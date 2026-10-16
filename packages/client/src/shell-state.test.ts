import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countdownSeconds, lobbyCode, menuKey, searchTransition, type SearchState } from './shell-state';
import { validNickname } from './settings';

test('number keys activate, arrows wrap, editing keeps native keys', () => {
  assert.deepEqual(menuKey('6', 0, 6), { type: 'activate', index: 5 });
  assert.equal(menuKey('7', 0, 6), null);
  assert.deepEqual(menuKey('ArrowUp', 0, 6), { type: 'select', index: 5 });
  assert.deepEqual(menuKey('ArrowDown', 5, 6), { type: 'select', index: 0 });
  assert.deepEqual(menuKey('Enter', 3, 6), { type: 'activate', index: 3 });
  assert.equal(menuKey('1', 0, 6, true), null);
  assert.equal(menuKey('Backspace', 0, 6, true), null);
  assert.deepEqual(menuKey('Escape', 0, 6, true), { type: 'back' });
});
test('names match the original 24-byte printable ASCII boundary', () => {
  for (const value of ['', ' ', 'é', 'a\nb', 'a'.repeat(25), '\x7f']) assert.equal(validNickname(value), false);
  for (const value of ['A', 'Sgt. Mac', '[name] ~!', 'a'.repeat(24)]) assert.equal(validNickname(value), true);
});
test('lobby codes accept shared links but reject malformed codes', () => {
  assert.equal(lobbyCode(' ab12cd '), 'AB12CD');
  assert.equal(lobbyCode('https://game.example/?lobby=k7m4q2'), 'K7M4Q2');
  assert.equal(lobbyCode('/?lobby=k7m4q2'), 'K7M4Q2');
  for (const input of ['', 'abcde', 'AB-CD!', 'https://game.example/?map=Arena', '?lobby=%00AAAAA']) assert.equal(lobbyCode(input), null);
});
test('probes precede a full three-second countdown; cancellation is terminal', () => {
  let state: SearchState = searchTransition({ phase: 'testing' }, { type: 'tick', now: 100 });
  assert.equal(state.phase, 'testing');
  state = searchTransition(state, { type: 'tested', region: 'local', now: 120 });
  assert.equal(countdownSeconds(state, 120), 3);
  assert.equal(countdownSeconds(state, 1120), 2);
  assert.equal(searchTransition(state, { type: 'tick', now: 3119 }).phase, 'countdown');
  assert.deepEqual(searchTransition(state, { type: 'tick', now: 3120 }), { phase: 'joining', region: 'local' });
  state = searchTransition(state, { type: 'cancel' });
  assert.equal(searchTransition(state, { type: 'tick', now: 10000 }).phase, 'cancelled');
  assert.equal(searchTransition(state, { type: 'tested', region: 'other', now: 10000 }).phase, 'cancelled');
});
