import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CombatHud, type HudOptions } from './hud';
import { DEFAULT_SETTINGS, type Settings } from '../settings';
import { cloneTaunts } from '../taunts';
import { LimboMenu } from './limbo';

/** Minimal DOM adapter; exercises CombatHud's registered handlers, not a replacement console. */
function fixture(t: TestContext, options: Partial<HudOptions> = {}) {
  const listeners = new Map<string, (event: KeyboardEvent) => void>();
  let active: FakeElement | null = null, dialogOpen = false;
  class FakeElement extends EventTarget {
    readonly style: Record<string, string> = { cursor: '' };
    readonly children: FakeElement[] = [];
    readonly attributes: Record<string, string> = {};
    parent: FakeElement | null = null;
    hidden = false; value = ''; width = 640; height = 480; clientWidth = 640; clientHeight = 480;
    className = ''; type = ''; maxLength = 0; autocomplete = ''; selectionStart = 0; selectionEnd = 0;
    private text = '';
    private textNode: { textContent: string } | null = null;
    constructor(readonly tagName: string) { super(); }
    set textContent(value: string) { this.text = value; this.children.length = 0; this.textNode = value ? { textContent: value } : null; }
    get textContent(): string { return this.textNode?.textContent ?? this.text; }
    get firstChild(): FakeElement | { textContent: string } | null { return this.textNode ?? this.children[0] ?? null; }
    append(...children: FakeElement[]) { for (const child of children) { child.parent = this; this.children.push(child); } }
    contains(element: FakeElement): boolean { return element === this || this.children.some(child => child.contains(element)); }
    closest(selector: string): FakeElement | null {
      return selector.split(',').some(part => part.trim() === this.tagName.toLowerCase()) ||
        (this.attributes.contenteditable === 'true' && selector.includes('[contenteditable]')) ? this : this.parent?.closest(selector) ?? null;
    }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    getAttribute(key: string) { return this.attributes[key] ?? null; }
    focus() { active = this; }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; }
    getContext() { return { save() {}, restore() {}, font: '', measureText(text: string) { return { width: text.length * 6 }; } }; }
  }
  const documentStub = {
    createElement(tag: string) { return new FakeElement(tag.toUpperCase()); },
    get activeElement() { return active; },
    pointerLockElement: null,
    querySelector() { return dialogOpen ? new FakeElement('DIALOG') : null; },
    exitPointerLock() {},
  };
  const replacements: Record<string, unknown> = {
    Element: FakeElement, HTMLElement: FakeElement, HTMLCanvasElement: FakeElement, document: documentStub,
    ResizeObserver: class { observe() {} disconnect() {} },
    window: { devicePixelRatio: 1,
      addEventListener(name: string, handler: (event: KeyboardEvent) => void) { listeners.set(name, handler); },
      removeEventListener(name: string) { listeners.delete(name); },
    },
  };
  const descriptors = Object.fromEntries(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const host = new FakeElement('DIV'), canvas = new FakeElement('CANVAS'); host.append(canvas); canvas.focus();
  const settings: Settings = { ...DEFAULT_SETTINGS, appearance: { ...DEFAULT_SETTINGS.appearance }, bindings: { ...DEFAULT_SETTINGS.bindings }, commandBindings: { ...DEFAULT_SETTINGS.commandBindings }, taunts: cloneTaunts(DEFAULT_SETTINGS.taunts) };
  const Constructor = CombatHud as unknown as new (host: HTMLElement, options: HudOptions) => CombatHud;
  const hud = new Constructor(host as unknown as HTMLElement, { startJet: 100, weapons: {}, settings, ...options });
  t.after(() => {
    hud.destroy();
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  });
  const root = host.children[1]!, form = root.children.find(child => child.tagName === 'FORM')!;
  const input = form.children[0]!.children[0]!;
  function key(code: string, properties: Partial<KeyboardEvent> = {}) {
    const event = { code, key: code === 'Slash' ? '/' : '', target: active, repeat: false, isComposing: false,
      ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...properties };
    listeners.get('keydown')!(event as unknown as KeyboardEvent);
    return event;
  }
  function keyUp(code: string, properties: Partial<KeyboardEvent> = {}) {
    const event = { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
      preventDefault() {}, stopImmediatePropagation() {}, ...properties };
    listeners.get('keyup')!(event as KeyboardEvent);
  }
  return { hud, input, root, canvas, key, keyUp, blur: () => listeners.get('blur')!({} as KeyboardEvent), settings, externalInput: () => new FakeElement('INPUT'), setDialog(value: boolean) { dialogOpen = value; } };
}

test('original open/send/cancel/history keys drive actual HUD and public/team callbacks', async t => {
  const sent: unknown[] = [], captures: boolean[] = [];
  const f = fixture(t, { onChat: (channel, text) => sent.push([channel, text]), onInputCapture: value => captures.push(value) });
  assert.equal(f.key('Enter').stopped, false); assert.equal(f.hud.inputActive, false);
  assert.equal(f.key('KeyT').stopped, true); assert.equal(f.hud.inputActive, true);
  f.input.value = '<b>literal text</b>';
  assert.equal(f.key('Enter').stopped, true);
  assert.equal(f.hud.inputActive, false); assert.deepEqual(sent, [['public', '<b>literal text</b>']]);
  f.key('Slash'); assert.equal(f.input.value, '/');
  f.input.value = 'unfinished'; f.key('ArrowUp'); assert.equal(f.input.value, '<b>literal text</b>');
  f.key('ArrowDown'); assert.equal(f.input.value, 'unfinished');
  f.key('Escape'); assert.equal(f.hud.inputActive, false); assert.equal(sent.length, 1);
  f.key('Slash'); f.input.value = '/say_team "Defend!"'; f.key('Enter');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sent.at(-1), ['team', 'Defend!']);
  assert.deepEqual(captures.slice(0, 2), [true, false]);
});

test('taunts never escape external inputs, console editing, pause, dialog or repeated/modified keys', t => {
  const sent: unknown[] = [];
  const f = fixture(t, { onChat: (channel, text) => sent.push([channel, text]) });
  f.key('KeyH', { altKey: true }); assert.deepEqual(sent, [['public', 'Get the flag!']]);
  f.key('KeyH', { altKey: true, repeat: true }); f.key('KeyH', { altKey: true, ctrlKey: true });
  const editor = f.externalInput(); editor.focus(); f.key('KeyH', { altKey: true });
  f.canvas.focus(); f.key('KeyT'); f.key('KeyH', { altKey: true }); f.key('Escape');
  f.hud.setSuspended(true); f.key('KeyH', { altKey: true }); f.hud.setSuspended(false);
  f.setDialog(true); f.key('KeyH', { altKey: true }); f.setDialog(false);
  assert.equal(sent.length, 1);
});

test('console bind/unbindall immediately changes HUD controls without remount or gameplay leakage', async t => {
  const sent: unknown[] = [], updates: Settings[] = [];
  const f = fixture(t, { onChat: (channel, text) => sent.push([channel, text]), onSettingsChange: value => updates.push(value) });
  f.key('Slash'); f.input.value = '/bind "ALT+H" "say_team ""Need backup"""'; f.key('Enter');
  await Promise.resolve(); await Promise.resolve();
  f.key('KeyH', { altKey: true });
  assert.deepEqual(sent, [['team', 'Need backup']]); assert.equal(updates.length, 1);
  f.key('Slash'); f.input.value = '/unbindall'; f.key('Enter');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.key('KeyT').stopped, false); assert.equal(f.hud.inputActive, false);
  f.key('KeyH', { altKey: true }); assert.equal(sent.length, 1);
});

test('incoming chat and notices render through textContent, never HTML parsing', t => {
  const f = fixture(t);
  f.hud.receiveChat({ type: 'chat-message', channel: 'team', slot: 3, nickname: '<img>', text: '<script>bad()</script>' });
  f.hud.consoleNotice('<strong>literal notice</strong>');
  const log = f.root.children.find(child => child.attributes.role === 'log')!;
  assert.match(log.textContent, /\(TEAM\) <img>: <script>bad\(\)<\/script>/);
  assert.match(log.textContent, /<strong>literal notice<\/strong>/);
  assert.equal(log.children.length, 0);
});

test('native gestures, numbered radio capture and Escape never leak into gameplay', async t => {
  const sent: unknown[] = [], captures: boolean[] = [];
  const f = fixture(t, { onFeature: message => sent.push(message), onInputCapture: value => captures.push(value) });
  assert.equal(f.key('Digit1', { altKey: true }).stopped, true);
  assert.deepEqual(sent, [{ type: 'gesture', gesture: 'smoke' }]);
  f.key('KeyV');
  assert.equal(f.hud.gameplayCaptured, true);
  assert.equal(f.key('Digit1', { ctrlKey: true }).stopped, true);
  f.key('Digit3'); f.key('Digit2');
  assert.deepEqual(sent.at(-1), { type: 'radio', category: 3, direction: 2 });
  assert.equal(f.hud.gameplayCaptured, false);
  f.key('KeyV'); f.key('Digit1'); f.key('Escape');
  assert.equal(f.hud.gameplayCaptured, false);
  const before = sent.length;
  f.key('Slash'); f.input.value = '/radio 1 3'; f.key('Enter');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sent.at(-1), { type: 'radio', category: 1, direction: 3 });
  assert.equal(sent.length, before + 1);
  assert.ok(captures.includes(true));
});

test('authentication input is concealed on entry and credentials cannot be recalled', async t => {
  const sent: unknown[] = [];
  const f = fixture(t, { onFeature: message => sent.push(message) });
  f.key('Slash'); f.input.value = '/admin login private-token'; f.input.dispatchEvent(new Event('input'));
  assert.equal(f.input.type, 'password');
  f.key('Enter');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sent, [{ type: 'admin-auth', token: 'private-token' }]);
  assert.equal(f.input.value, ''); assert.equal(f.input.type, 'text');
  f.key('Slash'); f.key('ArrowUp');
  assert.ok(!f.input.value.includes('private-token'));
  const log = f.root.children.find(child => child.attributes.role === 'log')!;
  assert.ok(!log.textContent.includes('private-token'));
});

test('vote keys use server eligibility and current identity; menu input cannot vote', async t => {
  const sent: unknown[] = [];
  const f = fixture(t, { onFeature: message => sent.push(message) });
  const vote = { id: 4, proposal: { kind: 'map', map: 'Arena' }, initiator: 'Host', targetLabel: 'Arena', yes: 1, no: 0, eligible: 3, required: 2, remainingMs: 20000, myVote: null, canVote: true, phase: 'active', reason: '' } as const;
  f.hud.receiveFeature({ type: 'control-state', state: { admin: false, host: false, paused: false, muted: false, vote } });
  f.key('F12');
  assert.deepEqual(sent.at(-1), { type: 'vote-cast', id: 4, choice: 'yes' });
  f.hud.receiveFeature({ type: 'control-state', state: { admin: false, host: false, paused: false, muted: false, vote: { ...vote, myVote: 'yes', canVote: false } } });
  f.key('F11');
  await Promise.resolve();
  assert.equal(sent.length, 1);
  f.hud.receiveFeature({ type: 'control-state', state: { admin: false, host: false, paused: false, muted: false, vote: { ...vote, id: 5 } } });
  f.key('KeyV'); f.key('F12'); f.key('Escape');
  assert.equal(sent.length, 1);
  f.key('F11');
  assert.deepEqual(sent.at(-1), { type: 'vote-cast', id: 5, choice: 'no' });
});

test('numbered match controls expose host actions only after authoritative role and maps update', t => {
  const sent: unknown[] = [];
  const f = fixture(t, { onFeature: message => sent.push(message) });
  f.hud.setMaps(['Arena', 'ctf_Laos']);
  f.hud.openMatchControls(); f.key('Digit1'); f.key('Digit2');
  assert.deepEqual(sent, [{ type: 'vote-start', proposal: { kind: 'map', map: 'ctf_Laos' } }]);
  f.hud.receiveFeature({ type: 'control-state', state: { admin: false, host: true, paused: true, muted: false, vote: null } });
  f.hud.openMatchControls(); f.key('Digit5'); f.key('Digit1');
  assert.deepEqual(sent.at(-1), { type: 'admin-action', action: { kind: 'unpause' } });
  f.hud.openMatchControls(); f.key('Digit5');
  f.hud.receiveFeature({ type: 'control-state', state: { admin: false, host: false, paused: false, muted: false, vote: null } });
  f.key('Digit1');
  assert.equal(sent.length, 2);
  assert.equal(f.hud.gameplayCaptured, false);
});

test('PTT releases on keyup, modifier loss, editing, menu, pause, blur, unbind and dialog', t => {
  const transmitting: boolean[] = [];
  const f = fixture(t, { onFeature() {}, onVoiceTransmit: value => transmitting.push(value) });
  const settings: Settings = { ...f.settings, voice: { enabled: true, channel: 'team', receiveVolume: 1 }, commandBindings: { ...f.settings.commandBindings, KeyC: '+voicechat' } };
  f.hud.updateSettings(settings);
  f.key('KeyC'); f.key('KeyC', { repeat: true }); f.keyUp('KeyA'); f.keyUp('KeyC');
  assert.deepEqual(transmitting, [true, false]);
  f.key('KeyC'); f.key('KeyT'); f.key('Escape');
  f.key('KeyC'); f.key('KeyV'); f.key('Escape');
  f.key('KeyC'); f.blur();
  f.key('KeyC'); f.hud.setSuspended(true); f.hud.setSuspended(false);
  f.key('KeyC'); f.setDialog(true); f.key('KeyA'); f.setDialog(false);
  f.key('KeyC'); f.hud.updateSettings({ ...settings, commandBindings: {} });
  assert.deepEqual(transmitting, Array.from({ length: 14 }, (_, index) => index % 2 === 0));
  f.hud.updateSettings({ ...settings, commandBindings: { 'Ctrl+KeyC': '+voicechat' } });
  f.key('KeyC', { ctrlKey: true }); f.keyUp('ControlLeft');
  assert.deepEqual(transmitting.slice(-2), [true, false]);
});

test('incoming radio uses original labels and remains literal and locally mutable', t => {
  const f = fixture(t);
  f.hud.receiveFeature({ type: 'radio-message', category: 1, direction: 3, slot: 2, nickname: '<b>Player</b>' });
  f.hud.setVoiceStatus('Microphone permission denied. Allow microphone access to talk.');
  const log = f.root.children.find(child => child.attributes.role === 'log')!;
  assert.equal(log.textContent, '(TEAM) <b>Player</b>: Enemy flagger down!');
  assert.equal(log.children.length, 0);
  assert.ok(f.root.children.some(child => child.attributes.role === 'status' && child.textContent.includes('Microphone permission denied')));
});

test('feature menus preserve native death-picker visibility and lock rather than consuming weapon choices', t => {
  const sent: unknown[] = [];
  const f = fixture(t, { onFeature: message => sent.push(message), weaponsMenu: true });
  const limbo: unknown = Reflect.get(f.hud, 'limbo');
  assert.ok(limbo instanceof LimboMenu);
  limbo.observe(true, 4, 0);
  assert.equal(limbo.active, true); assert.equal(limbo.locked, false);
  f.key('KeyV'); assert.equal(limbo.active, true);
  f.hud.setMaps(['Arena']);
  f.hud.openMatchControls(); f.key('Digit1'); f.key('Digit1');
  assert.deepEqual(sent, [{ type: 'vote-start', proposal: { kind: 'map', map: 'Arena' } }]);
  assert.equal(limbo.primary, 4); assert.equal(limbo.active, true); assert.equal(limbo.locked, false);
  assert.equal(f.hud.gameplayCaptured, true);
});

test('HUD exposes local mute changes for audible radio and voice receive paths', async t => {
  let changes = 0;
  const f = fixture(t, { onLocalMuteChange: () => changes++ });
  f.key('Slash'); f.input.value = '/mute all'; f.key('Enter');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(changes, 1); assert.equal(f.hud.isPlayerMuted(2, 'Bob'), true);
  f.hud.receiveFeature({ type: 'radio-message', category: 3, direction: 1, slot: 2, nickname: 'Bob' });
  const log = f.root.children.find(child => child.attributes.role === 'log')!;
  assert.ok(!log.textContent.includes('Enemy spotted'));
  f.key('Slash'); f.input.value = '/unmute all'; f.key('Enter');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(changes, 2); assert.equal(f.hud.isPlayerMuted(2, 'Bob'), false);
});
