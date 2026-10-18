export interface BindingEvent { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }

/** SDL names from controls.cfg translated once to browser physical-key codes. */
export function normalizeBinding(raw: string): string {
  const parts = raw.trim().split('+').map(part => part.trim());
  const modifiers = new Set<string>();
  let code = '';
  for (const part of parts) {
    const key = part.toLowerCase();
    const modifier = ({ ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta' } as Record<string, string>)[key];
    if (modifier) { modifiers.add(modifier); continue; }
    if (code) throw new Error('A bind must have exactly one trigger key');
    if (/^[a-z]$/i.test(part)) code = `Key${part.toUpperCase()}`;
    else if (/^[0-9]$/.test(part)) code = `Digit${part}`;
    else if (/^mouse[1-5]$/i.test(part)) code = `Mouse${[0, 1, 2, 3, 4][Number(part.slice(5)) - 1]}`;
    else code = ({ '/': 'Slash', space: 'Space', return: 'Enter', enter: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', 'left shift': 'ShiftLeft', 'right shift': 'ShiftRight', 'left ctrl': 'ControlLeft', 'right ctrl': 'ControlRight', 'left alt': 'AltLeft', 'right alt': 'AltRight' } as Record<string, string>)[key] ?? part;
    if (!/^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Mouse[0-4]|Arrow(?:Left|Right|Up|Down)|Space|Slash|Backquote|Backslash|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Tab|Enter|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|(?:Shift|Control|Alt|Meta)(?:Left|Right)|Numpad[0-9])$/.test(code)) throw new Error(`Unknown bind key: ${part}`);
  }
  if (!code) throw new Error('A bind needs a trigger key');
  if (/^Control(?:Left|Right)$/.test(code)) modifiers.add('Ctrl');
  else if (/^Alt(?:Left|Right)$/.test(code)) modifiers.add('Alt');
  else if (/^Shift(?:Left|Right)$/.test(code)) modifiers.add('Shift');
  else if (/^Meta(?:Left|Right)$/.test(code)) modifiers.add('Meta');
  return [...['Ctrl', 'Alt', 'Shift', 'Meta'].filter(modifier => modifiers.has(modifier)), code].join('+');
}

export function bindingCode(binding: string): string { return binding.split('+').at(-1) ?? ''; }

export function bindingMatches(binding: string, event: BindingEvent): boolean {
  if (!binding || bindingCode(binding) !== event.code) return false;
  return binding.includes('Ctrl+') === event.ctrlKey && binding.includes('Alt+') === event.altKey &&
    binding.includes('Shift+') === event.shiftKey && binding.includes('Meta+') === event.metaKey;
}

/** Unlike SDL's 1-based MOUSE names, saved/browser Mouse0..4 are already canonical. */
export function validStoredBinding(value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  try {
    const code = bindingCode(value);
    if (/^Mouse[0-4]$/.test(code)) return /^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?Mouse[0-4]$/.test(value);
    return normalizeBinding(value) === value;
  } catch { return false; }
}

/** Settings key capture waits for a non-modifier trigger, preserving canonical Mouse0..4. */
export function captureBinding(event: BindingEvent): string | null {
  if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(event.code)) return null;
  const binding = [event.ctrlKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '', event.metaKey ? 'Meta' : '', event.code].filter(Boolean).join('+');
  return validStoredBinding(binding) ? binding : null;
}
