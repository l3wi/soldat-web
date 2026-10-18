import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Receipt locations are project-relative, not executable command arguments.
 * Resolve recorded host-side Docker bind sources against the project root when
 * replaying them. External home locations use an explicit <host-home> marker.
 * Apply only at the reporting boundary: file I/O and subprocesses keep real paths.
 * @param {string} text
 * @param {string} root
 */
export function receiptPath(text, root = projectRoot) {
  const home = homedir();
  let portable = text.split(`${root}/`).join('');
  if (portable === root) portable = '<project-root>';
  portable = portable.split(`${root}:`).join('<project-root>:');
  if (home !== '/') {
    portable = portable.split(`${home}/`).join('<host-home>/');
    if (portable === home) portable = '<host-home>';
  }
  return portable;
}

/**
 * Preserve all values other than workstation location prefixes in strings.
 * @param {unknown} value
 * @param {string} root
 */
export function stringifyReceipt(value, root = projectRoot) {
  return JSON.stringify(value, (_key, entry) => typeof entry === 'string' ? receiptPath(entry, root) : entry, 2);
}
