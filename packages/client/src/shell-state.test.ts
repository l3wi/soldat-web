import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countdownSeconds, lobbyCanKick, lobbyCode, consoleDestination, menuKey, searchTransition, type SearchState } from './shell-state';
import { validNickname } from './settings';
import { normalizeMatchRules, type LobbyState } from '@soldat-web/protocol';

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
  assert.equal(lobbyCode(' ab12cd34 '), 'AB12CD34');
  assert.equal(lobbyCode('https://game.example/?lobby=k7m4q2z9'), 'K7M4Q2Z9');
  assert.equal(lobbyCode('/?lobby=k7m4q2z9'), 'K7M4Q2Z9');
  assert.equal(lobbyCode('01234567'), '01234567');
  for (const input of ['', 'abcde', 'AB-CD!', 'https://game.example/?map=Arena', '?lobby=%00AAAAAAA', 'AB12CD', '/?lobby=AB12CD', 'https://game.example/?lobby=AB12CD', 'AB12CD34X', ...['I', 'L', 'O', 'U', 'i', 'l', 'o', 'u'].map(letter => `${letter}1234567`)]) assert.equal(lobbyCode(input), null);
});
test('console connections use fresh admissions and reject credentials or consumed match tickets', () => {
  const api = 'https://region.example:7443';
  assert.deepEqual(consoleDestination('ab12cd34', api), { kind: 'lobby', origin: api, code: 'AB12CD34' });
  assert.deepEqual(consoleDestination('https://client.example/?lobby=k7m4q2z9', api), { kind: 'lobby', origin: api, code: 'K7M4Q2Z9' });
  assert.deepEqual(consoleDestination('wss://other.example:9445/', api), { kind: 'server', origin: 'https://other.example:9445' });
  for (const target of ['127.0.0.1 23073 password', 'javascript:alert(1)', 'file:///tmp/match',
    'https://user:secret@region.example/', 'wss://region.example/match?ticket=used',
    'https://region.example/?ticket=used', 'https://region.example/#secret']) {
    assert.throws(() => consoleDestination(target, api), Error);
  }
});
test('kick controls are available only to the current host before start', () => {
  const lobby: LobbyState = { code: 'AB12CD34', mode: 'dm', map: 'Arena', rules: normalizeMatchRules(), mapRotation: ['Arena'], targetPlayers: 8, started: false, players: [
    { id: 'host', nickname: 'Major', host: true, ready: true },
    { id: 'guest', nickname: 'Major', host: false, ready: false },
  ] };
  assert.equal(lobbyCanKick(lobby, 'host'), true);
  for (const id of ['guest', 'unknown', undefined]) assert.equal(lobbyCanKick(lobby, id), false);
  assert.equal(lobbyCanKick(null, 'host'), false);
  assert.equal(lobbyCanKick({ ...lobby, started: true }, 'host'), false);
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
