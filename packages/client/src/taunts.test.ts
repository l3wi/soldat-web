import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindingCode, bindingMatches, captureBinding, normalizeBinding, validStoredBinding, type BindingEvent } from './bindings';
import { DEFAULT_SETTINGS, loadSettings } from './settings';
import { GameConsole } from './console';
import { cloneTaunts, DEFAULT_TAUNTS, tauntForKey, validChatText } from './taunts';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem(key: string) { return values.get(key) ?? null; },
  setItem(key: string, value: string) { values.set(key, value); },
} });
const event: BindingEvent = { code: 'KeyH', altKey: true, ctrlKey: false, shiftKey: false, metaKey: false };
const playable = { paused: false, editing: false, overlay: false };

test('original SDL bind aliases translate to exact modifier-aware browser keys', () => {
  assert.equal(normalizeBinding('CTRL+ALT+Q'), 'Ctrl+Alt+KeyQ');
  assert.equal(normalizeBinding('shift+/'), 'Shift+Slash');
  assert.equal(normalizeBinding('MOUSE1'), 'Mouse0');
  assert.equal(normalizeBinding('MOUSE2'), 'Mouse1');
  assert.equal(normalizeBinding('MOUSE3'), 'Mouse2');
  assert.equal(normalizeBinding('left ctrl'), 'Ctrl+ControlLeft');
  assert.equal(bindingCode('Ctrl+Alt+KeyQ'), 'KeyQ');
  assert.equal(bindingMatches('Alt+KeyH', event), true);
  assert.equal(bindingMatches('KeyH', event), false);
  assert.equal(bindingMatches('Alt+KeyH', { ...event, ctrlKey: true }), false);
  assert.equal(bindingMatches('', event), false);
  assert.throws(() => normalizeBinding('Ctrl+Q+W'), /one trigger/);
  assert.throws(() => normalizeBinding('not-a-key'), /Unknown bind key/);
});

test('setting capture waits for a trigger key and never rewrites browser right mouse as SDL middle mouse', () => {
  assert.equal(captureBinding({ ...event, code: 'ControlLeft', altKey: false, ctrlKey: true }), null);
  assert.equal(captureBinding({ ...event, ctrlKey: true }), 'Ctrl+Alt+KeyH');
  assert.equal(captureBinding({ ...event, code: 'Mouse2', altKey: false, shiftKey: true }), 'Shift+Mouse2');
  assert.equal(validStoredBinding('Ctrl+Mouse2'), true);
  assert.equal(validStoredBinding('Ctrl+KeyH'), true);
  assert.equal(validStoredBinding('Ctrl+ctrl+KeyH'), false);
  assert.equal(validStoredBinding(''), true);
  assert.equal(validStoredBinding(null), false);
});

test('original text taunts use Alt only; native gestures are not invented as chat', () => {
  assert.deepEqual(tauntForKey(DEFAULT_TAUNTS, event, playable), { channel: 'public', text: 'Get the flag!' });
  assert.equal(DEFAULT_TAUNTS['Alt+Digit1'], undefined);
  assert.equal(DEFAULT_SETTINGS.commandBindings['Alt+Digit1'], 'smoke');
  assert.equal(tauntForKey(DEFAULT_TAUNTS, { ...event, altKey: false }, playable), undefined);
  assert.equal(tauntForKey(DEFAULT_TAUNTS, { ...event, shiftKey: true }, playable), undefined);
});

test('taunts never trigger while paused, editing, in an overlay, composing, or repeating a held key', () => {
  for (const context of [{ ...playable, paused: true }, { ...playable, editing: true }, { ...playable, overlay: true }])
    assert.equal(tauntForKey(DEFAULT_TAUNTS, event, context), undefined);
  assert.equal(tauntForKey(DEFAULT_TAUNTS, { ...event, repeat: true }, playable), undefined);
  assert.equal(tauntForKey(DEFAULT_TAUNTS, { ...event, isComposing: true }, playable), undefined);
  assert.equal(validChatText(''), false); assert.equal(validChatText('  '), false);
  assert.equal(validChatText('line\nbreak'), false); assert.equal(validChatText('x'.repeat(121)), false);
  assert.equal(validChatText('<script>literal</script>'), true);
});

test('editable team taunts persist and reach chat callback rather than command or gameplay mutation', async () => {
  values.clear();
  const sent: unknown[] = [];
  const model = new GameConsole({ ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_SETTINGS.bindings }, commandBindings: { ...DEFAULT_SETTINGS.commandBindings }, taunts: cloneTaunts(DEFAULT_TAUNTS) }, {
    onChat: (channel, text) => sent.push([channel, text]),
  });
  await model.execute('/taunt "Alt+H" team "Defend <our> flag!"');
  const loaded = loadSettings();
  assert.deepEqual(loaded.taunts['Alt+KeyH'], { channel: 'team', text: 'Defend <our> flag!' });
  assert.equal(DEFAULT_TAUNTS['Alt+KeyH']!.text, 'Get the flag!');
  const taunt = tauntForKey(loaded.taunts, event, playable)!;
  model.sendChat(taunt.channel, taunt.text);
  assert.deepEqual(sent, [['team', 'Defend <our> flag!']]);
  assert.deepEqual(model.settings.bindings, DEFAULT_SETTINGS.bindings);
  await model.execute('/unbindall');
  assert.equal(tauntForKey(loadSettings().taunts, event, playable), undefined);
});
