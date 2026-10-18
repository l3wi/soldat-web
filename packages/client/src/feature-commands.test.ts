import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsAdminCredential, featureCommand, voteSecondsRemaining } from './feature-commands';

test('radio commands reject out-of-range choices and client-authored radio text', () => {
  assert.throws(() => featureCommand('radio', ['1', '4'], null), /Direction/);
  assert.throws(() => featureCommand('radio', ['1', '1', 'raw text'], null), /Usage/);
});

test('vote countdown never invents a result, becomes negative or grows after a backward clock adjustment', () => {
  assert.equal(voteSecondsRemaining(20000, 1000, 1000), 20);
  assert.equal(voteSecondsRemaining(20000, 1000, 2001), 19);
  assert.equal(voteSecondsRemaining(20000, 1000, 21000), 0);
  assert.equal(voteSecondsRemaining(20000, 1000, 90000), 0);
  assert.equal(voteSecondsRemaining(20000, 1000, 500), 20);
});

test('authentication recognition covers malformed, quoted and nested command input without exposing credentials', () => {
  for (const value of ['/admin token', '/ADMIN login "token"', '/adminlog token', '/bind "K" "admin token"', '/bind K "admin \\"unfinished']) assert.equal(containsAdminCredential(value), true);
  assert.equal(containsAdminCredential('/map Arena'), false);
  assert.deepEqual(featureCommand('admin', ['login', 'secret'], null), { type: 'admin-auth', token: 'secret' });
  assert.deepEqual(featureCommand('admin', ['logout'], null), { type: 'admin-logout' });
  assert.throws(() => featureCommand('admin', ['login'], null), /Usage/);
  assert.throws(() => featureCommand('admin', ['secret', 'extra'], null), /Usage/);
  assert.throws(() => featureCommand('admin', ['a b'], null), /Invalid operator token/);
});

test('moderation command bounds match wire restrictions and remain distinct from local mute', () => {
  assert.deepEqual(featureCommand('ban', ['2', '43200', 'Abuse'], null), { type: 'admin-action', action: { kind: 'ban', slot: 2, minutes: 43200, reason: 'Abuse' } });
  assert.throws(() => featureCommand('ban', ['2', '43201'], null), /Minutes/);
  assert.equal(featureCommand('mute', ['2'], null), null);
  assert.equal(featureCommand('unmute', ['2'], null), null);
  assert.deepEqual(featureCommand('serverunmute', ['2'], null), { type: 'admin-action', action: { kind: 'unmute', slot: 2 } });
  assert.deepEqual(featureCommand('map', ['ctf_Laos'], null), { type: 'admin-action', action: { kind: 'map', map: 'ctf_Laos' } });
  assert.equal(featureCommand('rcon', ['arbitrary command'], null), null);
});

test('quoted command-name fragmentation cannot bypass credential masking or macro rejection', () => {
  for (const value of ['/ad\"mi\"n private-token', '/\"admin\" private-token', '/bind \"K\" \"ad\"\"mi\"\"n private-token\"', 'ad\"min\"log private-token']) assert.equal(containsAdminCredential(value), true);
});
