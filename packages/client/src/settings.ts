import { DEFAULT_APPEARANCE, validateAppearance, type PlayerAppearance } from '@soldat-web/protocol';
import { validStoredBinding } from './bindings';
import { cloneTaunts, DEFAULT_TAUNTS, validChatText, type Taunt } from './taunts';
import { containsAdminCredential } from './feature-commands';

export type ControlAction =
  | 'left' | 'right' | 'up' | 'down' | 'fire' | 'jetpack'
  | 'throwNade' | 'changeWeapon' | 'throwWeapon' | 'reload' | 'prone' | 'flagThrow';

export interface Settings {
  filter: 'nearest' | 'linear';
  mipmaps: boolean;
  nickname: string;
  volume: number;
  gameplayBackground: boolean;
  appearance: PlayerAppearance;
  sniperLine: boolean;
  scope: boolean;
  playerNames: boolean;
  voice: { enabled: boolean; channel: 'public' | 'team'; receiveVolume: number };
  bindings: Record<ControlAction, string>;
  commandBindings: Record<string, string>;
  taunts: Record<string, Taunt>;
}

/** Shared original last-bind-wins rule. Input is a canonical stored chord, never an SDL key alias. */
export function assignGameplayBinding(settings: Settings, action: ControlAction, binding: string): Settings {
  if (!validStoredBinding(binding)) throw new Error('Invalid canonical gameplay binding');
  const bindings = { ...settings.bindings }, commandBindings = { ...settings.commandBindings }, taunts = { ...settings.taunts };
  for (const name of Object.keys(bindings) as ControlAction[]) if (binding && bindings[name] === binding) bindings[name] = '';
  bindings[action] = binding;
  delete commandBindings[binding]; delete taunts[binding];
  return { ...settings, bindings, commandBindings, taunts };
}

/** Assign a UI command using the same last-bind-wins rule as gameplay controls. */
export function assignCommandBinding(settings: Settings, command: string, binding: string): Settings {
  if (!validStoredBinding(binding) || containsAdminCredential(command)) throw new Error('Invalid or secret-bearing command bind');
  const bindings = { ...settings.bindings }, commandBindings = { ...settings.commandBindings }, taunts = { ...settings.taunts };
  for (const [key, value] of Object.entries(commandBindings)) if (value === command) delete commandBindings[key];
  if (binding) {
    for (const name of Object.keys(bindings) as ControlAction[]) if (bindings[name] === binding) bindings[name] = '';
    delete taunts[binding];
    commandBindings[binding] = command;
  }
  return { ...settings, bindings, commandBindings, taunts };
}

/** Original names are at most 24 characters (PLAYERNAME_CHARS); the sim accepts printable ASCII. */
export function validNickname(value: string): boolean {
  return /^[\x20-\x7e]{1,24}$/.test(value) && value.trim().length > 0;
}

// Original controls.cfg; SDL MOUSE3 is the browser's right button (Mouse2).
// Graphics defaults are Cvar.pas r_texturefilter=2 and r_mipmapping=True.
export const DEFAULT_SETTINGS: Settings = {
  filter: 'linear',
  mipmaps: true,
  nickname: 'Player',
  volume: 0.6,
  gameplayBackground: true,
  appearance: { ...DEFAULT_APPEARANCE },
  sniperLine: false,
  scope: true,
  playerNames: true,
  voice: { enabled: false, channel: 'team', receiveVolume: 1 },
  bindings: {
    left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS',
    fire: 'Mouse0', jetpack: 'Mouse2', throwNade: 'KeyE',
    changeWeapon: 'KeyQ', throwWeapon: 'KeyF', reload: 'KeyR',
    prone: 'KeyX', flagThrow: 'Space',
  },
  commandBindings: {
    KeyT: '+chat', KeyY: '+teamchat', Slash: '+cmd', Tab: '+weapons', F1: '+fragslist', F2: '+statsmenu',
    F4: 'screenshot', F5: '+recorddemo',
    KeyV: '+radio', F11: 'vote no', F12: 'vote yes',
    'Ctrl+KeyQ': 'switchcamflag 1', 'Ctrl+KeyW': 'switchcamflag 2', 'Ctrl+KeyE': 'switchcamflag 3',
    'Ctrl+Digit1': 'switchcam 1', 'Ctrl+Digit2': 'switchcam 2', 'Ctrl+Digit3': 'switchcam 3',
    'Ctrl+Digit4': 'switchcam 4', 'Ctrl+Digit5': 'switchcam 5',
    'Alt+Digit1': 'smoke', 'Alt+Digit2': 'tabac', 'Alt+Digit3': 'takeoff', 'Alt+Digit4': 'victory',
  },
  taunts: cloneTaunts(DEFAULT_TAUNTS),
};

const STORAGE_KEY = 'soldat-web.settings.v1';

export function loadSettings(): Settings {
  const settings: Settings = {
    filter: DEFAULT_SETTINGS.filter,
    mipmaps: DEFAULT_SETTINGS.mipmaps,
    nickname: DEFAULT_SETTINGS.nickname,
    volume: DEFAULT_SETTINGS.volume,
    gameplayBackground: DEFAULT_SETTINGS.gameplayBackground,
    appearance: { ...DEFAULT_APPEARANCE },
    sniperLine: DEFAULT_SETTINGS.sniperLine,
    scope: DEFAULT_SETTINGS.scope,
    playerNames: DEFAULT_SETTINGS.playerNames,
    voice: { ...DEFAULT_SETTINGS.voice },
    bindings: { ...DEFAULT_SETTINGS.bindings },
    commandBindings: { ...DEFAULT_SETTINGS.commandBindings },
    taunts: cloneTaunts(DEFAULT_TAUNTS),
  };
  let scrubbedCredentials = false;
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return settings;
    const value = stored as Record<string, unknown>;
    if (value.filter === 'nearest' || value.filter === 'linear') settings.filter = value.filter;
    if (typeof value.mipmaps === 'boolean') settings.mipmaps = value.mipmaps;
    if (typeof value.nickname === 'string' && validNickname(value.nickname)) settings.nickname = value.nickname;
    if (typeof value.volume === 'number' && Number.isFinite(value.volume)) settings.volume = Math.max(0, Math.min(1, value.volume));
    if (typeof value.gameplayBackground === 'boolean') settings.gameplayBackground = value.gameplayBackground;
    for (const key of ['sniperLine', 'scope', 'playerNames'] as const) {
      if (typeof value[key] === 'boolean') settings[key] = value[key];
    }
    if (typeof value.voice === 'object' && value.voice !== null) {
      const voice = value.voice as Record<string, unknown>;
      if (typeof voice.enabled === 'boolean') settings.voice.enabled = voice.enabled;
      if (voice.channel === 'public' || voice.channel === 'team') settings.voice.channel = voice.channel;
      if (typeof voice.receiveVolume === 'number' && Number.isFinite(voice.receiveVolume))
        settings.voice.receiveVolume = Math.max(0, Math.min(1, voice.receiveVolume));
    }
    try {
      validateAppearance(value.appearance);
      settings.appearance = { ...value.appearance };
    } catch {
      // A malformed or old cosmetic record keeps the original player defaults.
    }
    if (typeof value.bindings === 'object' && value.bindings !== null) {
      const bindings = value.bindings as Record<string, unknown>;
      for (const action of Object.keys(settings.bindings) as ControlAction[]) {
        const binding = bindings[action];
        if (validStoredBinding(binding)) settings.bindings[action] = binding;
      }
    }
    if (typeof value.commandBindings === 'object' && value.commandBindings !== null && !Array.isArray(value.commandBindings)) {
      settings.commandBindings = {};
      for (const [key, command] of Object.entries(value.commandBindings)) {
        if (typeof command === 'string' && containsAdminCredential(command)) { scrubbedCredentials = true; continue; }
        if (key && validStoredBinding(key) && typeof command === 'string' && command.length > 0 && command.length <= 512 &&
            !/[\u0000-\u001f\u007f]/.test(command)) settings.commandBindings[key] = command;
      }
    }
    if (typeof value.taunts === 'object' && value.taunts !== null && !Array.isArray(value.taunts)) {
      settings.taunts = {};
      for (const [key, taunt] of Object.entries(value.taunts)) {
        if (!key || !validStoredBinding(key) || typeof taunt !== 'object' || taunt === null) continue;
        const entry = taunt as Record<string, unknown>;
        if ((entry.channel === 'public' || entry.channel === 'team') && typeof entry.text === 'string' && validChatText(entry.text))
          settings.taunts[key] = { channel: entry.channel, text: entry.text };
      }
    }
    if (scrubbedCredentials) saveSettings(settings);
  } catch {
    // Storage can be unavailable (private browsing) or contain an older/corrupt value.
  }
  return settings;
}

export function hasSavedNickname(): boolean {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    return !!value && typeof value === 'object' && 'nickname' in value && typeof value.nickname === 'string' && validNickname(value.nickname);
  } catch { return false; }
}

export function saveSettings(settings: Settings): void {
  try {
    const commandBindings = Object.fromEntries(Object.entries(settings.commandBindings).filter(([, command]) => !containsAdminCredential(command)));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...settings, commandBindings }));
  } catch {
    // Keep the current session usable when browser storage is unavailable/full.
  }
}
