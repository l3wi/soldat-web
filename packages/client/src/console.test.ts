import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConsoleHistory, GameConsole, parseConsoleCommand } from './console';
import { DEFAULT_SETTINGS, loadSettings, type Settings } from './settings';
import { cloneTaunts } from './taunts';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key: string) { return values.get(key) ?? null; },
  setItem(key: string, value: string) { values.set(key, value); },
} });
function settings(): Settings {
  return { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance }, bindings: { ...DEFAULT_SETTINGS.bindings },
    commandBindings: { ...DEFAULT_SETTINGS.commandBindings }, taunts: cloneTaunts(DEFAULT_SETTINGS.taunts) };
}

test('console parser handles original quoting, empty arguments and escapes without command evaluation', () => {
  assert.deepEqual(parseConsoleCommand('/bind "ALT+H" "say ""Get the flag!"""'), ['bind', 'ALT+H', 'say "Get the flag!"']);
  assert.deepEqual(parseConsoleCommand('/say "a \\"quote\\" and \\\\ path"'), ['say', 'a "quote" and \\ path']);
  assert.deepEqual(parseConsoleCommand('/bind "q" ""'), ['bind', 'q', '']);
  assert.deepEqual(parseConsoleCommand('/say "<img onerror=evil()>; /kick all"'), ['say', '<img onerror=evil()>; /kick all']);
  assert.throws(() => parseConsoleCommand('/say "unfinished'), /Unclosed quote/);
});

test('history preserves draft, bounds navigation, suppresses consecutive duplicates and caps retained entries', () => {
  const history = new ConsoleHistory();
  history.add('/say one'); history.add('/say one'); history.add('/say two');
  assert.equal(history.entries.length, 2);
  assert.equal(history.move(-1, 'unfinished'), '/say two');
  assert.equal(history.move(-1, ''), '/say one');
  assert.equal(history.move(-1, ''), '/say one');
  assert.equal(history.move(1, ''), '/say two');
  assert.equal(history.move(1, ''), 'unfinished');
  for (let i = 0; i < 110; i++) history.add(`/say ${i}`);
  assert.equal(history.entries.length, 100);
  assert.equal(history.entries[0], '/say 10');
});

test('say commands preserve literal text, route channels, validate bounds and do not send unknown admin commands', async () => {
  const sent: unknown[] = [], forwarded: unknown[] = [];
  const model = new GameConsole(settings(), { onChat: (channel, text) => sent.push([channel, text]), onConsoleCommand: (command, args) => { forwarded.push([command, args]); } });
  await model.execute('/say "<img src=x onerror=evil()>"');
  await model.execute('/say_team "return the flag"');
  await model.submit('plain chat', 'team');
  assert.deepEqual(sent, [['public', '<img src=x onerror=evil()>'], ['team', 'return the flag'], ['team', 'plain chat']]);
  for (const command of ['/say ""', `/say "${'x'.repeat(121)}"`, '/say "line\nbreak"', '/kick 2', '/votemap ctf_Laos', '/constructor', '/toString', '/record demo', '/stop', '/demo test', '/made_up']) await model.execute(command);
  assert.equal(sent.length, 3);
  assert.deepEqual(forwarded, []);
  assert.ok(model.lines.some(line => line.text.includes('Demo recording and playback are unavailable')));
  assert.ok(model.lines.some(line => line.text.includes('Feature is unavailable in this session')));
  assert.ok(model.lines.every(line => !line.text.includes('saved demo')));
});

test('context commands await real callbacks and report rejection without invented success', async () => {
  const forwarded: unknown[] = [];
  const model = new GameConsole(settings(), { onConsoleCommand: async (command, args) => {
    forwarded.push([command, args]); if (command === 'connect') throw new Error('Admission rejected');
  } });
  for (const command of ['/screenshot', '/switchcam 4', '/switchcamflag 2', '/team 1', '/weapons', '/connect https://server.example']) await model.submit(command);
  assert.deepEqual(forwarded, [['screenshot', []], ['switchcam', ['4']], ['switchcamflag', ['2']], ['team', ['1']], ['weapons', []], ['connect', ['https://server.example']]]);
  assert.match(model.lines.at(-1)!.text, /Admission rejected/);
  const unavailable = new GameConsole(settings());
  await unavailable.execute('/disconnect');
  assert.match(unavailable.lines.at(-1)!.text, /unavailable/);
});

test('settings commands update persisted settings and reject malformed values atomically', async () => {
  values.clear();
  const updates: Settings[] = [];
  const model = new GameConsole(settings(), { onSettingsChange: value => updates.push(value) });
  await model.execute('/snd_volume 35'); await model.execute('/r_texturefilter 1');
  await model.execute('/r_mipmapping false'); await model.execute('/ui_sniperline 1');
  await model.execute('/cl_player_name "My name"');
  assert.equal(model.settings.volume, 0.35); assert.equal(model.settings.filter, 'nearest');
  assert.equal(model.settings.mipmaps, false); assert.equal(model.settings.sniperLine, true);
  assert.equal(model.settings.nickname, 'My name');
  assert.deepEqual(loadSettings(), model.settings);
  const before = model.settings;
  for (const command of ['/snd_volume -1', '/snd_volume Infinity', '/r_texturefilter 3', '/r_mipmapping maybe', '/cl_player_name ""']) await model.execute(command);
  assert.equal(model.settings, before); assert.equal(updates.length, 5);
});

test('bind and unbindall change actual gameplay and command mappings and survive reload', async () => {
  values.clear();
  const model = new GameConsole(settings());
  await model.execute('/bind "CTRL+Q" "+reload"');
  assert.equal(model.settings.bindings.reload, 'Ctrl+KeyQ');
  assert.equal(model.settings.commandBindings['Ctrl+KeyQ'], undefined);
  await model.execute('/bind "ALT+H" "say_team ""Need backup!"""');
  assert.equal(model.settings.taunts['Alt+KeyH'], undefined);
  assert.equal(model.settings.commandBindings['Alt+KeyH'], 'say_team "Need backup!"');
  await model.execute('/bind "A" "say hi"');
  assert.equal(model.settings.bindings.left, '');
  assert.equal(model.settings.commandBindings.KeyA, 'say hi');
  assert.deepEqual(loadSettings(), model.settings);
  const before = model.settings;
  await model.execute('/bind "not-a-key" "+fire"');
  assert.equal(model.settings, before);
  await model.execute('/unbindall');
  assert.ok(Object.values(model.settings.bindings).every(value => value === ''));
  assert.deepEqual(model.settings.commandBindings, {}); assert.deepEqual(model.settings.taunts, {});
  assert.deepEqual(loadSettings(), model.settings);
});

test('mute is local, hides retained messages and does not mute a different human reusing a slot', async () => {
  const model = new GameConsole(settings());
  model.players = [{ slot: 2, name: 'Bob' }, { slot: 3, name: 'Alice' }];
  const message = { type: 'chat-message', channel: 'public', slot: 2, nickname: 'Bob', text: '<b>literal</b>' } as const;
  assert.equal(model.receiveChat(message), true);
  assert.equal(model.lines.at(-1)!.text, 'Bob: <b>literal</b>');
  await model.execute('/mute 2');
  assert.equal(model.receiveChat(message), false);
  assert.ok(model.lines.every(line => line.slot !== 2));
  assert.equal(model.receiveChat({ ...message, nickname: 'Charlie' }), true);
  await model.execute('/unmute Bob');
  assert.equal(model.receiveChat(message), true);
  await model.execute('/mute Alice');
  assert.equal(model.receiveChat({ ...message, slot: 3, nickname: 'ALICE' }), false);
  await model.execute('/mute all'); assert.equal(model.receiveChat(message), false);
  await model.execute('/mute all'); assert.equal(model.receiveChat(message), true);
  await model.execute('/unmute all');
  assert.equal(model.receiveChat({ ...message, slot: 3, nickname: 'Alice' }), true);
});

test('feature commands send typed gestures, self-kill, moderation and votes without claiming success', async () => {
  const sent: unknown[] = [];
  const model = new GameConsole(settings(), { onFeature: message => sent.push(message) });
  for (const command of ['/smoke', '/tabac', '/takeoff', '/victory', '/kill', '/kill 3', '/servermute 2', '/setteam 2 5', '/vote map ctf_Laos', '/vote kick 2 \"Team killing\"', '/radio 3 2']) await model.submit(command);
  assert.deepEqual(sent, [
    ...['smoke', 'tabac', 'takeoff', 'victory'].map(gesture => ({ type: 'gesture', gesture })),
    { type: 'self-kill' }, { type: 'admin-action', action: { kind: 'kill', slot: 3 } },
    { type: 'admin-action', action: { kind: 'mute', slot: 2 } }, { type: 'admin-action', action: { kind: 'team', slot: 2, team: 5 } },
    { type: 'vote-start', proposal: { kind: 'map', map: 'ctf_Laos' } },
    { type: 'vote-start', proposal: { kind: 'kick', slot: 2, reason: 'Team killing' } }, { type: 'radio', category: 3, direction: 2 },
  ]);
  assert.deepEqual(model.lines, []);
  const count = sent.length;
  for (const command of ['/kick 0', '/kill 33', '/ban 2 Infinity', '/setteam 2 6', '/vote yes', '/radio 4 1', '/radio 1 0', '/smoke extra', '/pause extra']) await model.submit(command);
  assert.equal(sent.length, count);
});

test('operator credentials never enter history, drafts, logs, settings or bound commands', async () => {
  values.clear();
  const sent: unknown[] = [];
  const model = new GameConsole(settings(), { onFeature: message => { sent.push(message); if (message.type === 'admin-auth') throw new Error(`transport echoed ${message.token}`); } });
  await model.submit('/say ordinary');
  await model.submit('/admin login \"private-secret\"');
  await model.submit('/adminlog second-secret');
  await model.submit('/bind \"K\" \"admin third-secret\"');
  await model.submit('/bind \"K\" \"admin \\\\\"fourth-secret\"');
  assert.equal(model.history.entries.some(value => value.includes('secret')), false);
  assert.equal(model.history.move(-1, '/admin draft-secret'), '/say ordinary');
  assert.equal(model.history.move(1, ''), '');
  assert.ok(model.lines.every(line => !line.text.includes('secret')));
  assert.ok(!JSON.stringify(model.settings).includes('secret'));
  assert.ok([...values.values()].every(value => !value.includes('secret')));
  assert.deepEqual(sent.slice(0, 2), [{ type: 'admin-auth', token: 'private-secret' }, { type: 'admin-auth', token: 'second-secret' }]);
  await model.submit('/admin logout');
  assert.deepEqual(sent.at(-1), { type: 'admin-logout' });
});

test('voting uses current server vote id and eligibility; local mute never sends moderation', async () => {
  const sent: unknown[] = [];
  const model = new GameConsole(settings(), { onFeature: message => sent.push(message) });
  model.controls.vote = { id: 8, proposal: { kind: 'map', map: 'Arena' }, initiator: 'Voter', targetLabel: 'Arena', yes: 1, no: 0, eligible: 3, required: 2, remainingMs: 30000, myVote: null, canVote: true, phase: 'active', reason: '' };
  await model.execute('/vote yes');
  assert.deepEqual(sent, [{ type: 'vote-cast', id: 8, choice: 'yes' }]);
  model.controls.vote = { ...model.controls.vote, myVote: 'yes' };
  await model.execute('/vote no');
  model.controls.vote = { ...model.controls.vote, myVote: null, canVote: false };
  await model.execute('/vote no');
  model.players = [{ slot: 2, name: 'Player' }];
  await model.execute('/mute 2');
  assert.equal(sent.length, 1);
});

test('local mute policy and changes are reusable by radio and voice without muting a reused slot', async () => {
  let changes = 0;
  const sent: unknown[] = [];
  const model = new GameConsole(settings(), { onLocalMuteChange: () => changes++, onFeature: message => sent.push(message) });
  model.players = [{ slot: 2, name: 'Bob' }, { slot: 3, name: 'Alice' }];
  await model.execute('/mute 2');
  assert.equal(changes, 1);
  assert.equal(model.isPlayerMuted(2, 'BOB'), true);
  assert.equal(model.isPlayerMuted(2, 'Charlie'), false);
  await model.execute('/mute Alice');
  assert.equal(model.isPlayerMuted(7, 'alice'), true);
  await model.execute('/servermute 3');
  assert.equal(changes, 2);
  assert.deepEqual(sent, [{ type: 'admin-action', action: { kind: 'mute', slot: 3 } }]);
  await model.execute('/mute all');
  assert.equal(model.isPlayerMuted(8, 'Future join'), true);
  await model.execute('/unmute all');
  assert.equal(model.isPlayerMuted(2, 'Bob'), false);
  assert.equal(model.isPlayerMuted(7, 'Alice'), false);
  assert.equal(changes, 4);
  await model.execute('/mute Missing');
  assert.equal(changes, 4);
});

test('fragmented quoted authentication names still conceal credentials from retained console state', async () => {
  const sent: unknown[] = [];
  const model = new GameConsole(settings(), { onFeature: message => sent.push(message) });
  await model.submit('/ad\"mi\"n login private-token');
  assert.deepEqual(sent, [{ type: 'admin-auth', token: 'private-token' }]);
  assert.deepEqual(model.history.entries, []);
  await model.submit('/bind K \"ad\"\"mi\"\"n private-token\"');
  assert.equal(model.settings.commandBindings.KeyK, undefined);
  assert.ok(model.lines.every(line => !line.text.includes('private-token')));
  assert.deepEqual(model.history.entries, []);
});
