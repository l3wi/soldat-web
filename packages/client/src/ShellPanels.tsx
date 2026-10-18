import { type MatchRules, type PlayerAppearance } from '@soldat-web/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { mountGame, updateGameSettings, type GameMountOptions } from './game';
import { assignCommandBinding, DEFAULT_SETTINGS, type Settings } from './settings';
import { cloneTaunts, TAUNT_KEYS } from './taunts';
import {
  HISTORIC_MAP_CREDITS, contentUrl, loadContentManifest, loadContentNotices, sourceUrl,
  type ContentIndex, type ContentManifest, type ContentNotice,
} from './content';
import { DEFAULT_SANDBOX, type SandboxOptions } from './sandbox-options';
import { LIMBO_WEAPONS } from './render/limbo';
import { captureBinding } from './bindings';

export function AppearanceRows({ appearance, apply }: { appearance: PlayerAppearance; apply(value: PlayerAppearance): void }) {
  const colors = [['shirtColor', 'Shirt'], ['pantsColor', 'Pants'], ['skinColor', 'Skin'], ['hairColor', 'Hair'], ['jetColor', 'Jet flame']] as const;
  const styles = [
    ['hairStyle', 'Hair style', ['None', 'Normal', 'Punk', 'Mr. T', 'Dreadlocks']],
    ['headStyle', 'Headgear', ['None', 'Helmet', 'Hat']],
    ['chainStyle', 'Chain', ['None', 'Dog tags', 'Pendant']],
  ] as const;
  return <div className="appearance-options">
    <p className="small">Team colors replace your shirt while playing on a team.</p>
    {colors.map(([key, label]) => <label className="settings-row" key={key}><span>{label}</span><input aria-label={`${label} color`} type="color" value={`#${appearance[key].toString(16).padStart(6, '0')}`} onChange={event => apply({ ...appearance, [key]: parseInt(event.target.value.slice(1), 16) })} /></label>)}
    {styles.map(([key, label, options]) => <label className="settings-row" key={key}><span>{label}</span><select aria-label={label} value={appearance[key]} onChange={event => apply({ ...appearance, [key]: Number(event.target.value) })}>{options.map((name, value) => <option key={value} value={value}>{name}</option>)}</select></label>)}
  </div>;
}

export function RuleRows({ rules, apply, maps, rotation, setRotation, disabled = false }: {
  rules: MatchRules; apply(value: MatchRules): void; maps: string[]; rotation: string[]; setRotation(value: string[]): void; disabled?: boolean;
}) {
  const toggles = [['realistic', 'Realistic'], ['survival', 'Survival'], ['advance', 'Advance'], ['bulletTime', 'Bullet time'], ['friendlyFire', 'Friendly fire'], ['balanceTeams', 'Balance teams'], ['stationaryGuns', 'Stationary guns'], ['sniperLine', 'Allow sniper line']] as const;
  const bonuses = [['bonusFlamer', 'Flame god'], ['bonusPredator', 'Predator'], ['bonusBerserker', 'Berserker'], ['bonusVest', 'Bulletproof vest'], ['bonusCluster', 'Cluster grenades']] as const;
  const number = (key: 'advanceAmount' | 'timeLimitTicks' | 'scoreLimit', label: string, max: number, scale = 1, min = 0) => <label className="settings-row"><span>{label}</span><input aria-label={label} type="number" min={min} max={max} value={rules[key] / scale} onChange={event => apply({ ...rules, [key]: Math.max(min, Math.min(max, Math.trunc(Number(event.target.value)))) * scale })} /></label>;
  return <details className="settings-details match-options"><summary>Round & game rules</summary><fieldset disabled={disabled}>
    {number('timeLimitTicks', 'Time limit (minutes; 0 = none)', 596523, 3600)}
    {number('scoreLimit', 'Score limit (0 = none)', 9999)}
    {toggles.map(([key, label]) => <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" checked={rules[key]} onChange={event => apply({ ...rules, [key]: event.target.checked })} /></label>)}
    {rules.advance && number('advanceAmount', 'Kills to advance', 9999, 1, 1)}
    <details><summary>Bonuses</summary>
      <label className="settings-row"><span>Bonus frequency</span><select aria-label="Bonus frequency" value={rules.bonusFrequency} onChange={event => apply({ ...rules, bonusFrequency: Number(event.target.value) })}>{['Never', 'Very few', 'Few', 'Normal', 'Many', 'Very many'].map((label, value) => <option value={value} key={value}>{label}</option>)}</select></label>
      {bonuses.map(([key, label]) => <label className="settings-row" key={key}><span>{label}</span><input type="checkbox" checked={rules[key]} onChange={event => apply({ ...rules, [key]: event.target.checked })} /></label>)}
    </details>
    <details><summary>Enabled weapons</summary><div className="weapon-options">{LIMBO_WEAPONS.map(({ name, num: weapon }) => {
      const checked = rules.weapons.includes(weapon);
      return <label key={weapon}><input type="checkbox" checked={checked} onChange={event => apply({ ...rules, weapons: event.target.checked ? [...rules.weapons, weapon].sort((a, b) => a - b) : rules.weapons.filter(value => value !== weapon) })} />{name}</label>;
    })}</div></details>
    <details><summary>Map rotation ({rotation.length || 1})</summary><p className="small">Selected maps play in this order after each round. Leave empty to repeat the current map.</p>
      {rotation.map((map, index) => <div className="rotation-row" key={map}><span>{index + 1}. {map}</span><button type="button" className="action" aria-label={`Move ${map} up`} disabled={index === 0} onClick={() => { const next = [...rotation]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; setRotation(next); }}>Up</button><button type="button" className="action" aria-label={`Remove ${map}`} onClick={() => setRotation(rotation.filter(value => value !== map))}>Remove</button></div>)}
      <label className="settings-row"><span>Add map</span><select aria-label="Add map to rotation" disabled={rotation.length >= 32} value="" onChange={event => { if (event.target.value) setRotation([...rotation, event.target.value]); }}><option value="">Choose…</option>{maps.filter(map => !rotation.includes(map)).map(map => <option key={map}>{map}</option>)}</select></label>
    </details>
  </fieldset></details>;
}

export function TauntRows({ settings, apply }: { settings: Settings; apply(value: Settings): void }) {
  return <details className="settings-details"><summary>Taunts & console controls</summary>
    <p className="small">T: public chat · Y: team chat · /: console · V: numbered team radio · F12: vote yes · F11: vote no. Alt+1–4: native gestures; other Alt chords: taunts. Use /matchmenu for voting and host/operator controls.</p>
    {TAUNT_KEYS.map(key => {
      const taunt = settings.taunts[key];
      const label = key.replace('Alt+Key', 'Alt+').replace('Alt+Digit', 'Alt+');
      const update = (text: string, channel: 'public' | 'team') => {
        const taunts = { ...settings.taunts }, commandBindings = { ...settings.commandBindings }, bindings = { ...settings.bindings };
        if (text.trim()) {
          taunts[key] = { text, channel }; delete commandBindings[key];
          for (const action of Object.keys(bindings) as (keyof Settings['bindings'])[]) if (bindings[action] === key) bindings[action] = '';
        } else delete taunts[key];
        apply({ ...settings, taunts, commandBindings, bindings });
      };
      return <div className="settings-row" key={key}><label><span>{label}</span><input aria-label={`${label} taunt`} maxLength={120} placeholder={settings.commandBindings[key] ?? 'No taunt'} value={taunt?.text ?? ''} onChange={event => update(event.target.value.replace(/[\u0000-\u001f\u007f]/g, ''), taunt?.channel ?? 'public')} /></label><select aria-label={`${label} channel`} value={taunt?.channel ?? 'public'} onChange={event => update(taunt?.text ?? '', event.target.value as 'public' | 'team')}><option value="public">Public</option><option value="team">Team</option></select></div>;
    })}
    <FeatureBindingRows settings={settings} apply={apply} />
    <button type="button" className="action" onClick={() => apply({ ...settings, bindings: { ...DEFAULT_SETTINGS.bindings }, commandBindings: { ...DEFAULT_SETTINGS.commandBindings }, taunts: cloneTaunts(DEFAULT_SETTINGS.taunts) })}>Restore original controls & taunts</button>
  </details>;
}

function FeatureBindingRows({ settings, apply }: { settings: Settings; apply(value: Settings): void }) {
  const controls = [['+radio', 'Radio menu'], ['vote yes', 'Vote yes'], ['vote no', 'Vote no'], ['+matchcontrols', 'Match controls'], ['smoke', 'Smoke'], ['tabac', 'Tabac'], ['takeoff', 'Take off'], ['victory', 'Victory']] as const;
  return <div className="feature-bindings">{controls.map(([command, label]) =>
    <label className="settings-row" key={command}><span>{label}</span><input aria-label={`${label} binding`} readOnly placeholder="Click, then press a key" value={Object.entries(settings.commandBindings).find(([, value]) => value === command)?.[0] ?? ''} onKeyDown={event => {
      event.preventDefault(); event.stopPropagation();
      if (event.code === 'Escape') { event.currentTarget.blur(); return; }
      if (event.code === 'Backspace' || event.code === 'Delete') { apply(assignCommandBinding(settings, command, '')); return; }
      const binding = captureBinding(event);
      if (binding) apply(assignCommandBinding(settings, command, binding));
    }} /></label>)}</div>;
}

export function VoiceSettingsRows({ settings, apply }: { settings: Settings; apply(value: Settings): void }) {
  const binding = Object.entries(settings.commandBindings).find(([, value]) => value === '+voicechat')?.[0] ?? '';
  return <fieldset className="voice-settings"><legend>Voice (hold to talk)</legend>
    <p className="small">Off by default. Enabling does not request microphone access; only pressing your talk key does. Choose a talk key below (none in the pinned original defaults). Voice requires HTTPS or localhost; public-internet connections may require operator-configured TURN.</p>
    <label className="settings-row"><span>Enable voice</span><input aria-label="Enable voice" type="checkbox" checked={settings.voice.enabled} onChange={event => apply({ ...settings, voice: { ...settings.voice, enabled: event.target.checked } })} /></label>
    <label className="settings-row"><span>Voice channel</span><select aria-label="Voice channel" value={settings.voice.channel} onChange={event => apply({ ...settings, voice: { ...settings.voice, channel: event.target.value as 'public' | 'team' } })}><option value="team">Team</option><option value="public">Public</option></select></label>
    <label className="settings-row"><span>Receive volume</span><input aria-label="Voice receive volume" type="range" min={0} max={1} step={0.05} value={settings.voice.receiveVolume} onChange={event => apply({ ...settings, voice: { ...settings.voice, receiveVolume: Number(event.target.value) } })} /></label>
    <label className="settings-row"><span>Hold-to-talk key</span><input aria-label="Hold-to-talk binding" readOnly value={binding} placeholder="Click, then press a key" onKeyDown={event => {
      event.preventDefault(); event.stopPropagation();
      if (event.code === 'Escape') { event.currentTarget.blur(); return; }
      if (event.code === 'Backspace' || event.code === 'Delete') { apply(assignCommandBinding(settings, '+voicechat', '')); return; }
      const captured = captureBinding(event);
      if (captured) apply(assignCommandBinding(settings, '+voicechat', captured));
    }} /></label>
    <button type="button" className="action" onClick={() => apply(assignCommandBinding(settings, '+voicechat', ''))}>Unbind talk key</button>
    <p className="small">Escape cancels key capture; Backspace/Delete unbind. Talking always stops on key release, typing, menus, pause or focus loss. Microphone, connection and playback errors appear in the match voice status.</p>
  </fieldset>;
}

export function GameSurface({ map, settings, sandbox = DEFAULT_SANDBOX, onStatus, onRoundChange, onSettingsChange, onShellCommand, capture = false, serverUrl, mountOptions, still = false }: {
  map: string; settings: Settings; sandbox?: SandboxOptions; onStatus?: (status: string) => void; capture?: boolean;
  serverUrl?: string; mountOptions?: GameMountOptions; still?: boolean; onRoundChange?: (map: string) => void;
  onSettingsChange?: (settings: Settings) => void;
  onShellCommand?: (command: string, args: readonly string[]) => void | Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const latest = useRef({ settings, onStatus, onRoundChange, onSettingsChange, onShellCommand, mountOptions });
  latest.current = { settings, onStatus, onRoundChange, onSettingsChange, onShellCommand, mountOptions };
  useEffect(() => { if (!still) updateGameSettings(settings); }, [settings, still]);
  useEffect(() => {
    if (!container.current) return;
    let active = true;
    let destroy: (() => void) | undefined;
    try {
      destroy = mountGame(container.current, map, latest.current.settings,
        status => { if (active) latest.current.onStatus?.(status); }, sandbox, {
          ...latest.current.mountOptions, serverUrl, paused: still,
          onRoundChange: next => {
            if (!active) return;
            (latest.current.onRoundChange ?? latest.current.mountOptions?.onRoundChange)?.(next);
          },
          onSettingsChange: next => {
            if (!active) return;
            updateGameSettings(next);
            (latest.current.onSettingsChange ?? latest.current.mountOptions?.onSettingsChange)?.(next);
          },
          onShellCommand: (command, args) => {
            const callback = latest.current.onShellCommand ?? latest.current.mountOptions?.onShellCommand;
            if (!active || !callback) throw new Error(`${command} is unavailable in this view`);
            return callback(command, args);
          },
        });
    } catch (error) {
      latest.current.onStatus?.(`Could not start ${map}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return () => { active = false; destroy?.(); };
  }, [map, sandbox, serverUrl, still, mountOptions?.attract]);
  return <div ref={container} className={capture ? 'game-surface capture-surface' : 'game-surface'} aria-label={`${map} game canvas`} />;
}


export function CreditsPanel({ manifest: index }: { manifest: ContentIndex | null }) {
  const [manifest, setManifest] = useState<ContentManifest | null>(null);
  const [manifestError, setManifestError] = useState('');
  const [notices, setNotices] = useState<ContentNotice[] | null>(null);
  const [noticeError, setNoticeError] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    loadContentManifest(abort.signal).then(value => { if (!abort.signal.aborted) setManifest(value); })
      .catch(error => { if (!abort.signal.aborted) setManifestError(error instanceof Error ? error.message : String(error)); });
    loadContentNotices(abort.signal).then(setNotices).catch(error => { if (!abort.signal.aborted) setNoticeError(error instanceof Error ? error.message : String(error)); });
    return () => abort.abort();
  }, []);
  const provenance = useMemo(() => manifest ? Object.entries(manifest.objects).flatMap(([object, entry]) =>
    entry.provenance.map((source, index) => ({ object, hash: entry.sha256, source, key: `${object}:${index}` }))) : [], [manifest]);
  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return provenance.filter(({ object, source }) => !needle || `${object} ${source.sourcePath} ${source.credit} ${source.licenseId}`.toLowerCase().includes(needle));
  }, [provenance, query]);
  const transformations = useMemo(() => [...new Set(provenance.flatMap(({ source }) => source.transformations))].sort(), [provenance]);
  const pageSize = 24;
  return <div className="credits">
    <p className="section-intro">Unofficial browser game using open-licensed Soldat/OpenSoldat content. Not affiliated with or endorsed by Michał Marcinkowski, Transhuman Design, or the OpenSoldat contributors.</p>
    <section>
      <h3>Creators & contributions</h3>
      <p>Michał Marcinkowski / Transhuman Design; OpenSoldat contributors. Historic graphics contributions include Monster and L[one]R.</p>
      <p>AEfremov contributed kit artwork; pewpew (BranDougherty) contributed interface icons. The complete shipped upstream credits text is below; upstream describes its list as incomplete.</p>
      <p>Play font: © 2011 Jonas Hecksher / Playtype / e-types AS, licensed under SIL OFL 1.1. The font is distributed unmodified.</p>
      <p>Toolchain recipe attribution: <a target="_blank" rel="noopener noreferrer" href="https://github.com/humanova/soldat-web">humanova/soldat-web</a> (MIT).</p>
      <p>Base assets: <a target="_blank" rel="noopener noreferrer" href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0</a>. OpenSoldat source: MIT, except individually identified components. <a target="_blank" rel="noopener noreferrer" href="https://github.com/opensoldat/opensoldat/blob/bf43a43bdd7a069e02c906768807f66e621b2888/shared/Vector.pas">Vector.pas source and retained notice</a>: MPL 1.1, JEDI/Direct3DX-derived code. <a target="_blank" rel="noopener noreferrer" href="https://www.mozilla.org/MPL/1.1/">Read MPL 1.1</a>.</p>
      {index && <dl className="pins">
        <dt>Base content pin</dt><dd><a target="_blank" rel="noopener noreferrer" href={sourceUrl(index.pins.base.repo, index.pins.base.commit)}><code>{index.pins.base.commit}</code></a></dd>
        <dt>OpenSoldat source pin</dt><dd><a target="_blank" rel="noopener noreferrer" href={sourceUrl(index.pins.opensoldat.repo, index.pins.opensoldat.commit)}><code>{index.pins.opensoldat.commit}</code></a></dd>
      </dl>}
    </section>
    <details>
      <summary>Known historic map authors</summary>
      <p>Preserved from the official 1.7.1.1 manual; historic titles may differ from the imported catalog. No classic installer assets are shipped. <a target="_blank" rel="noopener noreferrer" href="https://opensoldat.github.io/manual/manual.html#license">Manual credits</a></p>
      <dl className="map-credits">{HISTORIC_MAP_CREDITS.map(([author, maps]) => <div key={`${author}:${maps}`}><dt>{author}</dt><dd>{maps}</dd></div>)}</dl>
    </details>
    <section>
      <h3>Served notices & licenses</h3>
      {!notices && !noticeError && <p role="status">Loading notice texts…</p>}
      {noticeError && <p role="alert">Could not load notices: {noticeError}</p>}
      {notices?.map(notice => <details key={notice.path}>
        <summary>{notice.title}</summary>
        <p><a target="_blank" rel="noopener noreferrer" href={contentUrl(notice.path)}>Open original notice text</a></p>
        {notice.error ? <p role="alert">Notice unavailable: {notice.error}</p> : <pre className="notice-text">{notice.text}</pre>}
      </details>)}
    </section>
    <section>
      <h3>Browser transformations</h3>
      <p>Source images are decoded to straight-alpha PNG frames with exact color-key handling where recorded. GPU upload premultiplies alpha once. PCM sound is preserved; MS-ADPCM is converted to PCM16. Source tables and overrides become structured data. Per-file changes and source hashes are listed below.</p>
      <details><summary>Transformation identifiers from this bundle</summary><ul>{transformations.map(item => <li key={item}><code>{item}</code></li>)}</ul></details>
    </section>
    <section>
      <h3>Per-file provenance</h3>
      {manifestError && <p role="alert">Could not load provenance: {manifestError}</p>}
      {!manifest ? <p role="status">{manifestError ? 'Provenance unavailable.' : 'Loading full provenance…'}</p> : <>
        <p><a target="_blank" rel="noopener noreferrer" href={contentUrl('manifest.json')}>Open full content manifest</a>. Every contribution retains its credit, license, source pin, source hash and ordered transformations.</p>
        <label>Find a source path, creator or license<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        <p className="muted" role="status">{matching.length} provenance records{matching.length > 0 ? `; showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, matching.length)}` : ''}.</p>
        <div className="provenance-list">{matching.slice(page * pageSize, (page + 1) * pageSize).map(({ key, object, hash, source }) => <details key={key}>
          <summary>{source.sourcePath} <span className="license-tag">{source.licenseId}</span></summary>
          <dl>
            <dt>Credit</dt><dd>{source.credit}</dd>
            <dt>Source</dt><dd><a target="_blank" rel="noopener noreferrer" href={sourceUrl(source.sourceRepo, source.sourceCommit, source.sourcePath)}>{source.sourceRepo} / {source.sourcePath}</a></dd>
            <dt>Pinned commit</dt><dd><code>{source.sourceCommit}</code></dd>
            <dt>Source SHA-256</dt><dd><code>{source.sourceSha256}</code></dd>
            <dt>Output</dt><dd><code>{object}</code></dd>
            <dt>Output SHA-256</dt><dd><code>{hash}</code></dd>
            <dt>Transformations</dt><dd>{source.transformations.length ? <ol>{source.transformations.map((item, index) => <li key={index}><code>{item}</code></li>)}</ol> : 'None; original bytes preserved.'}</dd>
          </dl>
        </details>)}</div>
        <div className="form-actions">
          <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous records</button>
          <button type="button" disabled={(page + 1) * pageSize >= matching.length} onClick={() => setPage(page + 1)}>Next records</button>
        </div>
      </>}
    </section>
  </div>;
}
