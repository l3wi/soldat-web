import assert from 'node:assert/strict';
import test from 'node:test';
import { SPRITE_FLAGS } from '@soldat-web/sim-host';
import { createCamera } from './camera';
import { InputSampler } from './input';
import { DEFAULT_SETTINGS } from './settings';
import { SpectatorController } from './spectator';

// DOM event harness only. These tests exercise the real sampler, not simulation.
function harness() {
  class FakeElement extends EventTarget {
    closest(): null { return null; }
  }
  const fakeWindow = new EventTarget();
  const fakeDocument = Object.assign(new EventTarget(), {
    hidden: false, activeElement: null as FakeElement | null, pointerLockElement: null,
    captured: false, querySelector() { return this.captured ? {} : null; },
  });
  const canvas = Object.assign(new FakeElement(), {
    width: 640, height: 480, tabIndex: 0,
    getAttribute() { return '0'; },
    focus(this: FakeElement) { fakeDocument.activeElement = this; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 640, height: 480 }; },
  });
  const keys = ['window', 'document', 'Element'] as const;
  const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  const replacements = [fakeWindow, fakeDocument, FakeElement];
  for (let index = 0; index < keys.length; index++) {
    Object.defineProperty(globalThis, keys[index]!, { configurable: true, value: replacements[index] });
  }
  const sampler = new InputSampler(canvas as unknown as HTMLCanvasElement, DEFAULT_SETTINGS);
  const camera = createCamera(640, 480);
  const sprites = [
    { slot: 1, active: true, flags: SPRITE_FLAGS.active, team: 5, x: 0, y: 0 },
    { slot: 2, active: true, flags: SPRITE_FLAGS.active, team: 1, x: 20, y: 20 },
  ];
  const controller = new SpectatorController();
  controller.update(sprites, 1, false, 0);
  function key(type: 'keydown' | 'keyup', code: string, modifiers = {}, repeat = false): void {
    fakeWindow.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), {
      code, repeat, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers,
    }));
  }
  function mouse(type: 'mouseDown' | 'mouseUp', button: number, modifiers = {}): void {
    const handler = sampler as unknown as Record<typeof type, (event: MouseEvent) => void>;
    handler[type]({ target: canvas, button, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false,
      preventDefault() {}, ...modifiers } as unknown as MouseEvent);
  }
  return {
    sampler, camera, sprites, controller, fakeDocument, key, mouse,
    restore() {
      sampler.destroy();
      for (let index = 0; index < keys.length; index++) {
        const original = originals[index];
        if (original) Object.defineProperty(globalThis, keys[index]!, original);
        else Reflect.deleteProperty(globalThis, keys[index]!);
      }
    },
  };
}

test('spectator Fire follows without emitting any native controls; respawn requires a fresh click', () => {
  const h = harness();
  try {
    h.sampler.updateSpectator(h.controller);
    h.mouse('mouseDown', 0);
    h.sampler.updateSpectator(h.controller);
    assert.equal(h.controller.targetSlot, 2);
    assert.deepEqual([...h.sampler.sample(h.camera, 640, 480, 0, 0)], Array(12).fill(0));
    h.sprites[0]!.team = 1;
    h.controller.update(h.sprites, 1, false, 0);
    h.sampler.updateSpectator(h.controller);
    const record = h.sampler.sample(h.camera, 640, 480, 0, 0);
    assert.equal(new DataView(record.buffer).getUint16(0, true), 0);
    h.mouse('mouseUp', 0);
    h.mouse('mouseDown', 0);
    assert.equal(new DataView(h.sampler.sample(h.camera, 640, 480, 0, 0).buffer).getUint16(0, true), 1 << 4);
  } finally { h.restore(); }
});

test('overlays suppress observer intents and held controls cannot resume after capture', () => {
  const h = harness();
  try {
    h.sampler.updateSpectator(h.controller);
    h.mouse('mouseDown', 0);
    h.sampler.updateSpectator(h.controller, true);
    assert.equal(h.controller.targetSlot, 0);
    h.sampler.updateSpectator(h.controller);
    assert.equal(h.controller.targetSlot, 0);
    h.fakeDocument.captured = true;
    h.mouse('mouseDown', 0);
    h.sampler.updateSpectator(h.controller);
    assert.equal(h.controller.targetSlot, 0);
    h.fakeDocument.captured = false;
    h.key('keydown', 'KeyW');
    h.sampler.setSuspended(true);
    h.sampler.updateSpectator(h.controller);
    assert.equal(h.controller.targetSlot, 0);
    assert.deepEqual([...h.sampler.sample(h.camera, 640, 480, 0, 0)], Array(12).fill(0));
  } finally { h.restore(); }
});

test('modifier taunts never hold gameplay keys and chord release drops every matching trigger', () => {
  const h = harness();
  try {
    h.sprites[0]!.team = 1;
    h.controller.update(h.sprites, 1, false, 0);
    h.sampler.updateSpectator(h.controller);
    h.key('keydown', 'KeyA');
    assert.equal(new DataView(h.sampler.sample(h.camera, 640, 480, 0, 0).buffer).getUint16(0, true), 1);
    h.key('keydown', 'AltLeft', { altKey: true });
    h.key('keydown', 'KeyA', { altKey: true });
    assert.equal(new DataView(h.sampler.sample(h.camera, 640, 480, 0, 0).buffer).getUint16(0, true), 0);
    h.key('keyup', 'AltLeft');
    h.key('keydown', 'KeyA', {}, true);
    assert.equal(new DataView(h.sampler.sample(h.camera, 640, 480, 0, 0).buffer).getUint16(0, true), 0);
    h.sampler.updateSettings({ ...DEFAULT_SETTINGS, bindings: { ...DEFAULT_SETTINGS.bindings, left: 'Ctrl+KeyA', right: 'Ctrl+KeyA' } });
    h.key('keydown', 'KeyA', { ctrlKey: true });
    assert.equal(new DataView(h.sampler.sample(h.camera, 640, 480, 0, 0).buffer).getUint16(0, true), 3);
    h.key('keyup', 'KeyA', { ctrlKey: true });
    assert.equal(new DataView(h.sampler.sample(h.camera, 640, 480, 0, 0).buffer).getUint16(0, true), 0);
  } finally { h.restore(); }
});

test('dead player Fire and Jet are camera-only, including realistic mode', () => {
  const h = harness();
  try {
    h.sprites[0]!.team = 1;
    h.sprites[0]!.flags |= SPRITE_FLAGS.dead;
    h.controller.update(h.sprites, 1, true, 0);
    h.sampler.updateSpectator(h.controller);
    h.mouse('mouseDown', 2);
    h.sampler.updateSpectator(h.controller);
    assert.equal(h.controller.targetSlot, 2);
    assert.deepEqual([...h.sampler.sample(h.camera, 640, 480, 0, 0)], Array(12).fill(0));
    h.sprites[0]!.flags &= ~SPRITE_FLAGS.dead;
    h.controller.update(h.sprites, 1, true, 0);
    h.sampler.updateSpectator(h.controller);
    assert.equal(new DataView(h.sampler.sample(h.camera, 640, 480, 0, 0).buffer).getUint16(0, true), 0);
  } finally { h.restore(); }
});
