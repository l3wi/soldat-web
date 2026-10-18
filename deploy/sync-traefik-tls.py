#!/usr/bin/env python3
"""Copy only Soldat's leaf certificate from root-only Traefik storage."""
import argparse
import base64
import grp
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--acme-file', type=Path, required=True)
parser.add_argument('--domain', required=True)
parser.add_argument('--tls-root', type=Path, default=Path('/etc/soldat/tls'))
parser.add_argument('--group', default='soldat')
parser.add_argument('--container', default='soldat-server')
args = parser.parse_args()

def openssl(arguments, data):
    result = subprocess.run(['openssl', *arguments], input=data, capture_output=True, check=False)
    if result.returncode:
        raise RuntimeError('Soldat certificate/key validation failed')
    return result.stdout

storage = json.loads(args.acme_file.read_text())
certificates = [certificate for resolver in storage.values()
                for certificate in resolver.get('Certificates', [])
                if certificate.get('domain', {}).get('main') == args.domain]
if len(certificates) != 1:
    raise RuntimeError('Expected exactly one dedicated Soldat API certificate')
certificate = base64.b64decode(certificates[0]['certificate'], validate=True)
key = base64.b64decode(certificates[0]['key'], validate=True)
openssl(['x509', '-noout', '-checkhost', args.domain, '-checkend', '604800'], certificate)
if openssl(['x509', '-pubkey', '-noout'], certificate) != openssl(['pkey', '-pubout'], key):
    raise RuntimeError('Soldat certificate and private key do not match')

gid = grp.getgrnam(args.group).gr_gid
args.tls_root.mkdir(parents=True, exist_ok=True)
os.chown(args.tls_root, 0, gid)
os.chmod(args.tls_root, 0o750)
current = args.tls_root / 'current'
try:
    changed = ((current / 'fullchain.pem').read_bytes() != certificate
               or (current / 'key.pem').read_bytes() != key)
except FileNotFoundError:
    changed = True
if changed:
    generation = Path(tempfile.mkdtemp(prefix='generation-', dir=args.tls_root))
    link = args.tls_root / (generation.name + '.link')
    selected = False
    try:
        os.chown(generation, 0, gid)
        os.chmod(generation, 0o750)
        for name, content in [('fullchain.pem', certificate), ('key.pem', key)]:
            path = generation / name
            descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'wb') as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
                os.fchown(stream.fileno(), 0, gid)
                os.fchmod(stream.fileno(), 0o640)
        link.symlink_to(generation.name)
        os.replace(link, current)
        selected = True
    finally:
        link.unlink(missing_ok=True)
        if not selected:
            shutil.rmtree(generation)

# Retry reload even if a previous invocation copied the pair but signal dispatch failed.
containers = subprocess.run(['docker', 'ps', '--filter', 'name=^/' + args.container + '$',
                             '--format', '{{.Names}}'], capture_output=True, check=True, text=True)
reloaded = args.container in containers.stdout.splitlines()
if reloaded:
    subprocess.run(['docker', 'kill', '--signal=HUP', args.container], capture_output=True, check=True)
print(json.dumps({'domain': args.domain, 'certificate_sha256': hashlib.sha256(certificate).hexdigest(),
                  'changed': changed, 'reload_dispatched': reloaded}))
