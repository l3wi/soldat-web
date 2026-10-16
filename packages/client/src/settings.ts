export type ControlAction =
  | 'left' | 'right' | 'up' | 'down' | 'fire' | 'jetpack'
  | 'throwNade' | 'changeWeapon' | 'throwWeapon' | 'reload' | 'prone' | 'flagThrow';

export interface Settings {
  filter: 'nearest' | 'linear';
  mipmaps: boolean;
  nickname: string;
  volume: number;
  gameplayBackground: boolean;
  bindings: Record<ControlAction, string>;
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
  bindings: {
    left: 'KeyA', right: 'KeyD', up: 'KeyW', down: 'KeyS',
    fire: 'Mouse0', jetpack: 'Mouse2', throwNade: 'KeyE',
    changeWeapon: 'KeyQ', throwWeapon: 'KeyF', reload: 'KeyR',
    prone: 'KeyX', flagThrow: 'Space',
  },
};

const STORAGE_KEY = 'soldat-web.settings.v1';

export function loadSettings(): Settings {
  const settings: Settings = {
    filter: DEFAULT_SETTINGS.filter,
    mipmaps: DEFAULT_SETTINGS.mipmaps,
    nickname: DEFAULT_SETTINGS.nickname,
    volume: DEFAULT_SETTINGS.volume,
    gameplayBackground: DEFAULT_SETTINGS.gameplayBackground,
    bindings: { ...DEFAULT_SETTINGS.bindings },
  };
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return settings;
    const value = stored as Record<string, unknown>;
    if (value.filter === 'nearest' || value.filter === 'linear') settings.filter = value.filter;
    if (typeof value.mipmaps === 'boolean') settings.mipmaps = value.mipmaps;
    if (typeof value.nickname === 'string' && validNickname(value.nickname)) settings.nickname = value.nickname;
    if (typeof value.volume === 'number' && Number.isFinite(value.volume)) settings.volume = Math.max(0, Math.min(1, value.volume));
    if (typeof value.gameplayBackground === 'boolean') settings.gameplayBackground = value.gameplayBackground;
    if (typeof value.bindings === 'object' && value.bindings !== null) {
      const bindings = value.bindings as Record<string, unknown>;
      for (const action of Object.keys(settings.bindings) as ControlAction[]) {
        const binding = bindings[action];
        if (typeof binding === 'string' && binding.length > 0) settings.bindings[action] = binding;
      }
    }
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Keep the current session usable when browser storage is unavailable/full.
  }
}
