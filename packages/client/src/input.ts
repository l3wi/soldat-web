import type { Camera } from './render/types';
import { worldAt } from './camera';
import type { ControlAction, Settings } from './settings';
import { bindingCode, bindingMatches, type BindingEvent } from './bindings';
import type { SpectatorController } from './spectator';

// Must match sim-host CONTROL_NAMES and docs/formats/sim-abi.md, not DOM order.
const ACTIONS: readonly ControlAction[] = [
  'left', 'right', 'up', 'down', 'fire', 'jetpack', 'throwNade',
  'changeWeapon', 'throwWeapon', 'reload', 'prone', 'flagThrow',
];
const CONFLICTS = (1 << 6) | (1 << 7) | (1 << 8) | (1 << 9);

function roundI16(value: number): number {
  const lower = Math.floor(value);
  const rounded = value - lower === 0.5
    ? lower + (lower % 2 === 0 ? 0 : 1)
    : Math.round(value);
  return Math.max(-32768, Math.min(32767, rounded));
}

export class InputSampler {
  public pointerX: number;
  public pointerY: number;
  private readonly record = new Uint8Array(12);
  private readonly view = new DataView(this.record.buffer);
  private readonly aim = { x: 0, y: 0 };
  private readonly held = new Map<string, number>();
  private readonly bindings: string[];
  private readonly originalTabIndex: string | null;
  private sequence = 0;
  private previousConflict = 0;
  private destroyed = false;
  private suspended = false;
  private observing = false;
  private readonly bindingEvent: BindingEvent = { code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

  constructor(private readonly canvas: HTMLCanvasElement, settings: Settings) {
    this.bindings = ACTIONS.map(action => settings.bindings[action]);
    this.originalTabIndex = canvas.getAttribute('tabindex');
    if (this.originalTabIndex === null) canvas.tabIndex = -1;
    this.pointerX = canvas.width / 2;
    this.pointerY = canvas.height / 2;
    window.addEventListener('keydown', this.keyDown);
    window.addEventListener('keyup', this.keyUp);
    window.addEventListener('mousedown', this.mouseDown);
    window.addEventListener('mouseup', this.mouseUp);
    window.addEventListener('mousemove', this.mouseMove);
    window.addEventListener('blur', this.reset);
    document.addEventListener('visibilitychange', this.visibilityChange);
    document.addEventListener('focusin', this.focusIn);
    document.addEventListener('pointerlockchange', this.reset);
    canvas.addEventListener('contextmenu', this.contextMenu);
  }

  public setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    this.reset();
    if (suspended && document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  public updateSettings(settings: Settings): void {
    for (let i = 0; i < ACTIONS.length; i++) this.bindings[i] = settings.bindings[ACTIONS[i]!]!;
    this.reset();
  }

  /** Call after controller.update and before sample, once per 60 Hz tick. Camera
   * buttons are consumed here, never emitted as native Fire/Jet/Up controls.
   */
  public updateSpectator(controller: SpectatorController, captured = false): void {
    if (this.observing !== controller.observing) {
      this.observing = controller.observing;
      // A held death-click must not become a live shot/jet when respawning.
      this.reset();
    }
    if (captured || this.blocked(document.activeElement)) {
      this.reset();
      controller.controls(false, false, false, true);
      return;
    }
    if (controller.controls(
      this.held.has(this.bindings[4]!), this.held.has(this.bindings[5]!), this.held.has(this.bindings[2]!),
    )) {
      this.pointerX = this.canvas.width / 2;
      this.pointerY = this.canvas.height / 2;
    }
  }

  private blocked(target: EventTarget | null): boolean {
    return this.suspended || document.hidden || document.querySelector('dialog[open]') !== null ||
      (target instanceof Element && target.closest(
        'input, textarea, select, button, dialog, [contenteditable]:not([contenteditable="false"])',
      ) !== null);
  }

  private readonly keyDown = (event: KeyboardEvent): void => {
    if (this.blocked(event.target)) { this.reset(); return; }
    this.releaseModifiers(event);
    // Reset/overlay/respawn requires a fresh press, not browser key repeat.
    if (event.repeat) return;
    let matched = false;
    for (const binding of this.bindings) {
      if (!bindingMatches(binding, event)) continue;
      matched = true;
      if (!this.held.has(binding)) this.held.set(binding, ++this.sequence);
    }
    if (matched) event.preventDefault();
  };

  private readonly keyUp = (event: KeyboardEvent): void => {
    for (const binding of this.held.keys()) if (bindingCode(binding) === event.code) this.held.delete(binding);
    this.releaseModifiers(event);
  };

  private readonly mouseDown = (event: MouseEvent): void => {
    if (this.blocked(event.target)) { this.reset(); return; }
    if (event.target !== this.canvas && document.pointerLockElement !== this.canvas) return;
    this.canvas.focus({ preventScroll: true });
    this.releaseModifiers(event);
    const match = this.bindingEvent;
    match.code = `Mouse${event.button}`;
    let matched = false;
    for (const binding of this.bindings) {
      if (!bindingMatches(binding, match)) continue;
      matched = true;
      if (!this.held.has(binding)) this.held.set(binding, ++this.sequence);
    }
    if (matched) event.preventDefault();
  };

  private readonly mouseUp = (event: MouseEvent): void => {
    const code = `Mouse${event.button}`;
    for (const binding of this.held.keys()) if (bindingCode(binding) === code) this.held.delete(binding);
    this.releaseModifiers(event);
  };

  private releaseModifiers(event: Pick<BindingEvent, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): void {
    const match = this.bindingEvent;
    match.ctrlKey = event.ctrlKey;
    match.altKey = event.altKey;
    match.shiftKey = event.shiftKey;
    match.metaKey = event.metaKey;
    for (const binding of this.held.keys()) {
      match.code = bindingCode(binding);
      if (!bindingMatches(binding, match)) this.held.delete(binding);
    }
  }

  private readonly mouseMove = (event: MouseEvent): void => {
    if (this.blocked(event.target)) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    if (document.pointerLockElement === this.canvas) {
      this.pointerX = Math.max(0, Math.min(this.canvas.width, this.pointerX + event.movementX * scaleX));
      this.pointerY = Math.max(0, Math.min(this.canvas.height, this.pointerY + event.movementY * scaleY));
    } else {
      this.pointerX = (event.clientX - rect.left) * scaleX;
      this.pointerY = (event.clientY - rect.top) * scaleY;
    }
  };

  private readonly focusIn = (event: FocusEvent): void => {
    if (this.blocked(event.target)) this.reset();
  };

  private readonly visibilityChange = (): void => {
    if (document.hidden) this.reset();
  };

  private readonly contextMenu = (event: MouseEvent): void => { event.preventDefault(); };

  public readonly reset = (): void => {
    this.held.clear();
    this.sequence = 0;
    this.previousConflict = 0;
    this.record.fill(0);
  };

  /** Returns the SAME borrowed 12-byte record every tick. Copy only if retaining it. */
  public sample(
    camera: Camera, width: number, height: number, _playerX: number, _playerY: number, captured = false,
  ): Uint8Array {
    if (this.destroyed) {
      this.reset();
      return this.record;
    }
    // Native FreeControls still updates mouse aim while limbo/chat captures keys.
    if (captured || this.blocked(document.activeElement)) this.reset();
    if (this.observing) {
      this.record.fill(0);
      return this.record;
    }
    let bits = 0;
    for (let i = 0; i < ACTIONS.length; i++) {
      if (this.held.has(this.bindings[i]!)) bits |= 1 << i;
    }
    // Configured flag throw remains available alongside the original up+down chord.
    if ((bits & 12) === 12) bits |= 1 << 11;

    // Control.pas:204-237: remove the previously held weapon action, then resolve
    // simultaneous NEW actions in preference grenade > drop > change > reload.
    let conflicts = bits & CONFLICTS;
    if (conflicts !== 0 && (conflicts & (conflicts - 1)) !== 0) {
      bits &= ~this.previousConflict;
      conflicts = bits & CONFLICTS;
      const winner = (conflicts & (1 << 6)) || (conflicts & (1 << 8)) ||
        (conflicts & (1 << 7)) || (conflicts & (1 << 9));
      bits = (bits & ~CONFLICTS) | winner;
    } else {
      this.previousConflict = conflicts;
    }

    // ABI bits: left-first=1, right-first=2, up-first=4, down-first=8.
    // Keep raw horizontal controls: sim_set_input performs the original jump-aware
    // old/new-direction choice using its per-player tick history.
    const left = this.held.get(this.bindings[0]!) ?? Infinity;
    const right = this.held.get(this.bindings[1]!) ?? Infinity;
    const up = this.held.get(this.bindings[2]!) ?? Infinity;
    const down = this.held.get(this.bindings[3]!) ?? Infinity;
    let order = 0;
    if ((bits & 3) !== 0) order |= left <= right ? 1 : 2;
    if ((bits & 12) !== 0) order |= up <= down ? 4 : 8;
    worldAt(camera, this.pointerX, this.pointerY, width, height, this.aim);
    this.view.setUint16(0, bits, true);
    this.view.setInt16(2, roundI16(this.aim.x), true);
    this.view.setInt16(4, roundI16(this.aim.y), true);
    // Native Control.pas scope uses world MouseAim; MouseDist remains 150.
    this.view.setInt16(6, 150, true);
    this.view.setUint16(8, order, true);
    this.view.setUint16(10, 0, true);
    return this.record;
  }

  public async requestPointerLock(): Promise<void> {
    if (!this.destroyed) await this.canvas.requestPointerLock();
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.removeEventListener('keydown', this.keyDown);
    window.removeEventListener('keyup', this.keyUp);
    window.removeEventListener('mousedown', this.mouseDown);
    window.removeEventListener('mouseup', this.mouseUp);
    window.removeEventListener('mousemove', this.mouseMove);
    window.removeEventListener('blur', this.reset);
    document.removeEventListener('visibilitychange', this.visibilityChange);
    document.removeEventListener('focusin', this.focusIn);
    document.removeEventListener('pointerlockchange', this.reset);
    this.canvas.removeEventListener('contextmenu', this.contextMenu);
    if (this.originalTabIndex === null) this.canvas.removeAttribute('tabindex');
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.reset();
  }
}
