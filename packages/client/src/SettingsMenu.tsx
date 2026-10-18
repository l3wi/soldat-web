import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { captureBinding } from './bindings';
import { Row } from './MenuRow';
import { AppearanceRows, TauntRows, VoiceSettingsRows } from './ShellPanels';
import { assignGameplayBinding, DEFAULT_SETTINGS, validNickname, type ControlAction, type Settings } from './settings';

const CATEGORIES = [
  { id: 'general', label: 'General', description: 'Name, audio & background', intro: 'Your name, sound and gameplay backdrop.' },
  { id: 'appearance', label: 'Player appearance', description: 'Colors & styles', intro: 'Choose your player colors and styles.' },
  { id: 'graphics', label: 'Graphics & controls', description: 'Rendering & keybindings', intro: 'Rendering options and gameplay controls.' },
  { id: 'taunts', label: 'Taunts & console', description: 'Chat, radio & gestures', intro: 'Customize your taunts, radio and console controls.' },
  { id: 'voice', label: 'Voice', description: 'Hold to talk', intro: 'Choose when and how to talk to other players.' },
] as const;
type Category = typeof CATEGORIES[number]['id'];

const CONTROLS: [ControlAction, string][] = [
  ['left', 'Move left'], ['right', 'Move right'], ['up', 'Jump'], ['down', 'Crouch'],
  ['fire', 'Fire'], ['jetpack', 'Jetpack'], ['throwNade', 'Throw grenade'], ['changeWeapon', 'Change weapon'],
  ['throwWeapon', 'Drop weapon'], ['reload', 'Reload'], ['prone', 'Prone'], ['flagThrow', 'Throw flag'],
];

export function SettingsMenu({ settings, apply }: { settings: Settings; apply(value: Settings): void }) {
  const [category, setCategory] = useState<Category>('general');
  const [binding, setBinding] = useState<ControlAction | null>(null);
  const [draftName, setDraftName] = useState(settings.nickname);
  const workspace = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const cancelCapture = useRef<(() => void) | null>(null);
  const id = useId();
  const active = CATEGORIES.find(item => item.id === category)!;
  const talkKey = Object.entries(settings.commandBindings).find(([, command]) => command === '+voicechat')?.[0];

  useEffect(() => { setDraftName(settings.nickname); }, [settings.nickname]);

  useEffect(() => {
    if (!binding) return;
    const cancel = () => {
      window.removeEventListener('keydown', assign, true);
      window.removeEventListener('pointerdown', assign, true);
      cancelCapture.current = null;
    };
    const finish = () => { cancel(); setBinding(null); };
    const assign = (event: KeyboardEvent | PointerEvent) => {
      if (event instanceof PointerEvent && event.target instanceof Element &&
          event.target.closest('[role="tab"]') && workspace.current?.contains(event.target)) {
        finish();
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event instanceof KeyboardEvent && event.code === 'Escape') { finish(); return; }
      const value = captureBinding(event instanceof KeyboardEvent ? event : {
        code: `Mouse${event.button}`, ctrlKey: event.ctrlKey, altKey: event.altKey,
        shiftKey: event.shiftKey, metaKey: event.metaKey,
      });
      if (value === null) return;
      apply(assignGameplayBinding(settings, binding, value));
      finish();
    };
    cancelCapture.current = cancel;
    window.addEventListener('keydown', assign, true);
    window.addEventListener('pointerdown', assign, true);
    return cancel;
  }, [binding, settings, apply]);

  const selectCategory = (next: Category) => {
    cancelCapture.current?.();
    setBinding(null);
    setCategory(next);
  };
  const navigateTabs = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 :
      event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? CATEGORIES.length - 1 :
      direction ? (index + direction + CATEGORIES.length) % CATEGORIES.length : null;
    if (next !== null) {
      event.preventDefault();
      event.stopPropagation();
      selectCategory(CATEGORIES[next]!.id);
      tabs.current[next]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
  };

  return <div className="settings-workspace" ref={workspace} data-binding-capture={binding ? 'true' : undefined}>
    <nav className="settings-nav" role="tablist" aria-label="Settings categories" aria-orientation="vertical">
      {CATEGORIES.map((item, index) => <button
        key={item.id}
        ref={element => { tabs.current[index] = element; }}
        type="button"
        role="tab"
        id={`${id}-tab-${item.id}`}
        aria-selected={category === item.id}
        aria-controls={`${id}-panel`}
        tabIndex={category === item.id ? 0 : -1}
        className="settings-category"
        onClick={() => selectCategory(item.id)}
        onKeyDown={event => navigateTabs(event, index)}
      >
        <span className="settings-category-copy">
          <span className="settings-category-label">{item.label}</span>
          <span className="settings-category-description">{item.description}</span>
        </span>
        {item.id === 'voice' && <span className="settings-category-state">{settings.voice.enabled ? 'On' : 'Off'}</span>}
      </button>)}
      <div className="settings-voice-note">
        <p className="small">{talkKey ? `Talk key: ${talkKey}` : 'No talk key assigned.'}</p>
        <p className="small">Voice is off by default.</p>
      </div>
    </nav>
    <section className="settings-content" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${category}`} tabIndex={0}>
      <header className="settings-section-heading">
        <h3>{active.label}</h3>
        <p className="small">{active.intro}</p>
      </header>
      {category === 'general' && <div className="settings-general">
        <label className="settings-row settings-volume">
          <span>Master volume</span>
          <span className="settings-control">
            <input aria-label="Master volume" type="range" min={0} max={100} value={Math.round(settings.volume * 100)} onChange={event => apply({ ...settings, volume: Number(event.target.value) / 100 })} />
            <output>{Math.round(settings.volume * 100)}%</output>
          </span>
        </label>
        <label className="settings-row settings-background">
          <span>Gameplay background</span>
          <span className="settings-control">
            <input aria-label="Gameplay background" type="checkbox" checked={settings.gameplayBackground} onChange={event => apply({ ...settings, gameplayBackground: event.target.checked })} />
            <span className="settings-value" aria-hidden="true">{settings.gameplayBackground ? 'On' : 'Off'}</span>
          </span>
        </label>
        <label className="settings-row settings-nickname">
          <span className="settings-label">Nickname<small id={`${id}-name-limit`}>Up to 24 characters</small></span>
          <span className="settings-control settings-name-control">
            <input aria-label="Name" aria-describedby={`${id}-name-limit ${id}-name-update`} maxLength={24} value={draftName} aria-invalid={!validNickname(draftName)} onChange={event => setDraftName(event.target.value)} onBlur={() => {
              if (validNickname(draftName)) apply({ ...settings, nickname: draftName });
              else setDraftName(settings.nickname);
            }} />
            <small id={`${id}-name-update`}>Updates when you leave this field.</small>
          </span>
        </label>
      </div>}
      {category === 'appearance' && <AppearanceRows appearance={settings.appearance} apply={appearance => apply({ ...settings, appearance })} />}
      {category === 'graphics' && <div className="settings-graphics">
        <label className="settings-row"><span>Texture filtering</span><select value={settings.filter} onChange={event => apply({ ...settings, filter: event.target.value as Settings['filter'] })}><option value="linear">Linear</option><option value="nearest">Nearest</option></select></label>
        <label className="settings-row"><span>Use mipmaps</span><input type="checkbox" checked={settings.mipmaps} onChange={event => apply({ ...settings, mipmaps: event.target.checked })} /></label>
        {([['sniperLine', 'Sniper line'], ['scope', 'Sniper scope'], ['playerNames', 'Player names under cursor']] as const).map(([key, label]) => <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" checked={settings[key]} onChange={event => apply({ ...settings, [key]: event.target.checked })} /></label>)}
        <h4>Gameplay controls</h4>
        <div className="binding-grid">{CONTROLS.map(([action, label], index) => <Row key={action} number={index + 1} selected={binding === action} onClick={() => setBinding(action)}><span>{label}</span><strong>{binding === action ? 'Press a key…' : settings.bindings[action] || 'Unbound'}</strong></Row>)}</div>
        {binding && <p className="small" role="status">Press a key or mouse button. Escape cancels.</p>}
      </div>}
      {category === 'taunts' && <TauntRows settings={settings} apply={apply} />}
      {category === 'voice' && <VoiceSettingsRows settings={settings} apply={apply} />}
      <footer className="settings-reset">
        <button type="button" className="action" onClick={() => apply({ ...DEFAULT_SETTINGS, nickname: settings.nickname, bindings: { ...DEFAULT_SETTINGS.bindings } })}>Restore defaults</button>
        <small>Keeps your nickname.</small>
      </footer>
    </section>
  </div>;
}
