import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignCommandBinding, assignGameplayBinding, DEFAULT_SETTINGS, loadSettings, saveSettings } from './settings';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key: string) { return values.get(key) ?? null; },
  setItem(key: string, value: string) { values.set(key, value); },
} });

test('original appearance and presentation settings survive a browser restart', () => {
  values.clear();
  assert.deepEqual(loadSettings().appearance, DEFAULT_SETTINGS.appearance);
  const settings = { ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_SETTINGS.bindings }, appearance: {
    shirtColor: 0x123456, pantsColor: 0, skinColor: 0xffffff, hairColor: 0xabcdef, jetColor: 0x654321,
    hairStyle: 4, headStyle: 2, chainStyle: 1,
  }, sniperLine: true, scope: false, playerNames: false };
  saveSettings(settings);
  assert.deepEqual(loadSettings(), settings);
});

test('malformed saved appearance and nonboolean presentation values retain defaults', () => {
  for (const appearance of [null, {}, { ...DEFAULT_SETTINGS.appearance, shirtColor: -1 },
    { ...DEFAULT_SETTINGS.appearance, hairStyle: 5 }, { ...DEFAULT_SETTINGS.appearance, headStyle: 3 },
    { ...DEFAULT_SETTINGS.appearance, chainStyle: 0.5 }, { ...DEFAULT_SETTINGS.appearance, unknown: 1 }]) {
    values.set('soldat-web.settings.v1', JSON.stringify({ nickname: 'Still valid', appearance, sniperLine: 'true', scope: 0, playerNames: null }));
    const settings = loadSettings();
    assert.equal(settings.nickname, 'Still valid');
    assert.deepEqual(settings.appearance, DEFAULT_SETTINGS.appearance);
    assert.equal(settings.sniperLine, DEFAULT_SETTINGS.sniperLine);
    assert.equal(settings.scope, DEFAULT_SETTINGS.scope);
    assert.equal(settings.playerNames, DEFAULT_SETTINGS.playerNames);
  }
  values.set('soldat-web.settings.v1', '{broken');
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

test('defaults are not shared mutable appearance or control records', () => {
  values.clear();
  const first = loadSettings();
  first.appearance.shirtColor = 0;
  first.bindings.left = 'ArrowLeft';
  assert.deepEqual(loadSettings(), DEFAULT_SETTINGS);
});

test('old settings migrate original console and taunts without sharing mutable defaults', () => {
  values.set('soldat-web.settings.v1', JSON.stringify({ nickname: 'Legacy', bindings: { left: 'ArrowLeft' } }));
  const first = loadSettings();
  assert.equal(first.nickname, 'Legacy');
  assert.equal(first.bindings.left, 'ArrowLeft');
  assert.equal(first.commandBindings.Slash, '+cmd');
  assert.deepEqual(first.taunts['Alt+KeyH'], { channel: 'public', text: 'Get the flag!' });
  first.commandBindings.Slash = 'say changed';
  first.taunts['Alt+KeyH']!.text = 'Changed';
  assert.equal(loadSettings().commandBindings.Slash, '+cmd');
  assert.equal(loadSettings().taunts['Alt+KeyH']!.text, 'Get the flag!');
});

test('saved unbound gameplay, empty command and taunt maps are intentional, not default restoration', () => {
  const settings = { ...DEFAULT_SETTINGS,
    bindings: { ...DEFAULT_SETTINGS.bindings, left: '', reload: 'Ctrl+KeyR', fire: 'Shift+Mouse2' },
    commandBindings: {}, taunts: {},
  };
  saveSettings(settings);
  assert.deepEqual(loadSettings(), settings);
});

test('malformed bindings and taunts cannot create unsupported key triggers or unsafe chat text', () => {
  values.set('soldat-web.settings.v1', JSON.stringify({
    bindings: { left: 'Ctrl+KeyA', right: 'javascript:evil()', fire: '' },
    commandBindings: { 'Alt+KeyH': 'say \"hello\"', invalid: 'say no', KeyT: 'line\nbreak', KeyY: 12 },
    taunts: { 'Alt+KeyH': { channel: 'team', text: '<b>literal</b>' }, KeyT: { channel: 'admin', text: 'no' },
      KeyQ: { channel: 'public', text: 'line\nbreak' }, KeyE: { channel: 'team', text: 'x'.repeat(121) } },
  }));
  const settings = loadSettings();
  assert.equal(settings.bindings.left, 'Ctrl+KeyA');
  assert.equal(settings.bindings.right, DEFAULT_SETTINGS.bindings.right);
  assert.equal(settings.bindings.fire, '');
  assert.deepEqual(settings.commandBindings, { 'Alt+KeyH': 'say \"hello\"' });
  assert.deepEqual(settings.taunts, { 'Alt+KeyH': { channel: 'team', text: '<b>literal</b>' } });
});

test('shared gameplay assignment preserves canonical mouse chords and evicts every prior key owner immutably', () => {
  const original = { ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_SETTINGS.bindings, left: 'Alt+KeyH', right: 'Alt+KeyH' },
    commandBindings: { ...DEFAULT_SETTINGS.commandBindings, 'Alt+KeyH': 'say hi', 'Ctrl+Mouse2': 'screenshot' },
    taunts: { ...DEFAULT_SETTINGS.taunts } };
  const assigned = assignGameplayBinding(original, 'fire', 'Alt+KeyH');
  assert.equal(assigned.bindings.fire, 'Alt+KeyH');
  assert.equal(assigned.bindings.left, ''); assert.equal(assigned.bindings.right, '');
  assert.equal(assigned.commandBindings['Alt+KeyH'], undefined); assert.equal(assigned.taunts['Alt+KeyH'], undefined);
  assert.equal(original.bindings.left, 'Alt+KeyH'); assert.equal(original.commandBindings['Alt+KeyH'], 'say hi');
  assert.equal(original.taunts['Alt+KeyH']!.text, 'Get the flag!');
  const mouse = assignGameplayBinding(assigned, 'fire', 'Ctrl+Mouse2');
  assert.equal(mouse.bindings.fire, 'Ctrl+Mouse2');
  assert.equal(mouse.commandBindings['Ctrl+Mouse2'], undefined);
  assert.equal(assignGameplayBinding(mouse, 'fire', '').bindings.fire, '');
  assert.throws(() => assignGameplayBinding(mouse, 'fire', 'CTRL+MOUSE3'), /canonical/);
});

test('voice defaults are opt-in, team-only and independent; stored values are bounded', () => {
  values.clear();
  const first = loadSettings();
  assert.deepEqual(first.voice, { enabled: false, channel: 'team', receiveVolume: 1 });
  assert.ok(!Object.values(first.commandBindings).includes('+voicechat'));
  first.voice.enabled = true;
  assert.equal(loadSettings().voice.enabled, false);
  values.set('soldat-web.settings.v1', JSON.stringify({ voice: { enabled: true, channel: 'public', receiveVolume: 7 } }));
  assert.deepEqual(loadSettings().voice, { enabled: true, channel: 'public', receiveVolume: 1 });
  values.set('soldat-web.settings.v1', JSON.stringify({ voice: { enabled: 'true', channel: 'admin', receiveVolume: '1' } }));
  assert.deepEqual(loadSettings().voice, DEFAULT_SETTINGS.voice);
});

test('UI command assignment evicts other key owners and unbinds hold-to-talk without restoring defaults', () => {
  const settings = assignCommandBinding(DEFAULT_SETTINGS, '+voicechat', 'KeyV');
  assert.equal(settings.commandBindings.KeyV, '+voicechat');
  assert.equal(Object.values(settings.commandBindings).includes('+radio'), false);
  const moved = assignCommandBinding(settings, '+voicechat', 'KeyA');
  assert.equal(moved.commandBindings.KeyV, undefined);
  assert.equal(moved.bindings.left, '');
  assert.equal(assignCommandBinding(moved, '+voicechat', '').commandBindings.KeyA, undefined);
  assert.equal(DEFAULT_SETTINGS.commandBindings.KeyV, '+radio');
  assert.throws(() => assignCommandBinding(DEFAULT_SETTINGS, 'admin secret', 'KeyK'), /secret/);
});

test('secret-bearing legacy macros cannot load or be persisted', () => {
  values.set('soldat-web.settings.v1', JSON.stringify({ commandBindings: { KeyK: 'admin token', KeyL: '/adminlog \"token\"', KeyJ: 'say harmless' } }));
  assert.deepEqual(loadSettings().commandBindings, { KeyJ: 'say harmless' });
  saveSettings({ ...DEFAULT_SETTINGS, commandBindings: { KeyK: 'admin secret-token', KeyJ: 'vote yes' } });
  assert.ok(!values.get('soldat-web.settings.v1')!.includes('secret-token'));
  assert.deepEqual(loadSettings().commandBindings, { KeyJ: 'vote yes' });
});
