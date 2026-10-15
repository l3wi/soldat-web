export type ControlAction =
  | 'left' | 'right' | 'up' | 'down' | 'fire' | 'jetpack'
  | 'throwNade' | 'changeWeapon' | 'throwWeapon' | 'reload' | 'prone' | 'flagThrow';

export interface Settings {
  filter: 'nearest' | 'linear';
  mipmaps: boolean;
  bindings: Record<ControlAction, string>;
}

// Original controls.cfg; SDL MOUSE3 is the browser's right button (Mouse2).
// Graphics defaults are Cvar.pas r_texturefilter=2 and r_mipmapping=True.
export const DEFAULT_SETTINGS: Settings = {
  filter: 'linear',
  mipmaps: true,
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
    bindings: { ...DEFAULT_SETTINGS.bindings },
  };
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (typeof stored !== 'object' || stored === null) return settings;
    const value = stored as Record<string, unknown>;
    if (value.filter === 'nearest' || value.filter === 'linear') settings.filter = value.filter;
    if (typeof value.mipmaps === 'boolean') settings.mipmaps = value.mipmaps;
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

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Keep the current session usable when browser storage is unavailable/full.
  }
}
