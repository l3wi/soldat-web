import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { mountGame, unlockGameAudio } from './game';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type ControlAction, type Settings } from './settings';
import {
  HISTORIC_MAP_CREDITS, contentUrl, loadContentManifest, loadContentNotices, sourceUrl,
  type ContentManifest, type ContentNotice,
} from './content';

const ACTIONS: { action: ControlAction; label: string }[] = [
  { action: 'left', label: 'Move left' }, { action: 'right', label: 'Move right' },
  { action: 'up', label: 'Jump' }, { action: 'down', label: 'Crouch' },
  { action: 'fire', label: 'Fire' }, { action: 'jetpack', label: 'Jetpack' },
  { action: 'throwNade', label: 'Throw grenade' }, { action: 'changeWeapon', label: 'Change weapon' },
  { action: 'throwWeapon', label: 'Drop weapon' }, { action: 'reload', label: 'Reload' },
  { action: 'prone', label: 'Prone' }, { action: 'flagThrow', label: 'Throw flag' },
];
const ignoreStatus = (_status: string) => {};
const cloneSettings = (settings: Settings): Settings => ({ ...settings, bindings: { ...settings.bindings } });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function GameSurface({ map, settings, onStatus = ignoreStatus, capture = false }: {
  map: string; settings: Settings; onStatus?: (status: string) => void; capture?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    let active = true;
    let destroy: (() => void) | undefined;
    try {
      destroy = mountGame(container.current, map, settings, status => { if (active) onStatus(status); });
    } catch (error) {
      onStatus(`Could not start ${map}: ${errorMessage(error)}`);
    }
    return () => { active = false; destroy?.(); };
  }, [map, settings, onStatus]);
  return <div ref={container} className={capture ? 'game-surface capture-surface' : 'game-surface'} aria-label={`${map} game canvas`} />;
}

function SettingsPanel({ settings, onApply }: { settings: Settings; onApply: (settings: Settings) => void }) {
  const [draft, setDraft] = useState(() => cloneSettings(settings));
  const [binding, setBinding] = useState<ControlAction | null>(null);
  useEffect(() => {
    if (!binding) return;
    const assign = (value: string) => {
      setDraft(current => ({ ...current, bindings: { ...current.bindings, [binding]: value } }));
      setBinding(null);
    };
    const keyDown = (event: KeyboardEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.code === 'Escape') setBinding(null);
      else if (!event.repeat && event.code) assign(event.code);
    };
    const pointerDown = (event: PointerEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      assign(`Mouse${event.button}`);
    };
    const contextMenu = (event: Event) => event.preventDefault();
    window.addEventListener('keydown', keyDown, true);
    window.addEventListener('pointerdown', pointerDown, true);
    window.addEventListener('contextmenu', contextMenu, true);
    return () => {
      window.removeEventListener('keydown', keyDown, true);
      window.removeEventListener('pointerdown', pointerDown, true);
      window.removeEventListener('contextmenu', contextMenu, true);
    };
  }, [binding]);
  return <form onSubmit={event => { event.preventDefault(); onApply(draft); }}>
    <p className="section-intro">Graphics and controls are stored on this device. Applying changes restarts the current map.</p>
    <fieldset className="graphics-settings">
      <legend>Graphics</legend>
      <label>Texture filtering
        <select value={draft.filter} onChange={event => setDraft({ ...draft, filter: event.target.value as Settings['filter'] })}>
          <option value="nearest">Nearest — crisp pixels</option><option value="linear">Linear — smooth pixels</option>
        </select>
      </label>
      <label className="checkbox-label"><input type="checkbox" checked={draft.mipmaps} onChange={event => setDraft({ ...draft, mipmaps: event.target.checked })} /> Use mipmaps</label>
    </fieldset>
    <fieldset>
      <legend>Key bindings</legend>
      <p className="muted" id="binding-help">Select a binding, then press a key or a mouse button. Escape cancels. Keyboard bindings use physical key positions.</p>
      <div className="binding-grid">
        {ACTIONS.map(({ action, label }) => <div className="binding-row" key={action}>
          <span id={`label-${action}`}>{label}</span>
          <button type="button" className={binding === action ? 'binding listening' : 'binding'} aria-labelledby={`label-${action} binding-${action}`} aria-describedby="binding-help" onClick={() => setBinding(action)}>
            <span id={`binding-${action}`}>{binding === action ? 'Press a key…' : draft.bindings[action]}</span>
          </button>
        </div>)}
      </div>
      <p className="binding-prompt" role="status">{binding ? `Listening for ${ACTIONS.find(item => item.action === binding)?.label.toLowerCase()}. Press Escape to cancel.` : 'Mouse0 = left mouse button. Mouse2 = right mouse button.'}</p>
    </fieldset>
    <div className="form-actions">
      <button type="submit" className="primary" disabled={binding !== null}>Apply settings</button>
      <button type="button" disabled={binding !== null} onClick={() => setDraft(cloneSettings(DEFAULT_SETTINGS))}>Restore defaults</button>
    </div>
  </form>;
}

function CreditsPanel({ manifest }: { manifest: ContentManifest | null }) {
  const [notices, setNotices] = useState<ContentNotice[] | null>(null);
  const [noticeError, setNoticeError] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    loadContentNotices(abort.signal).then(setNotices).catch(error => { if (!abort.signal.aborted) setNoticeError(errorMessage(error)); });
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
      <p>Toolchain recipe attribution: <a href="https://github.com/humanova/soldat-web">humanova/soldat-web</a> (MIT).</p>
      <p>Base assets: <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0</a>. OpenSoldat source: MIT, except individually identified components. <a href="https://github.com/opensoldat/opensoldat/blob/bf43a43bdd7a069e02c906768807f66e621b2888/shared/Vector.pas">Vector.pas source and retained notice</a>: MPL 1.1, JEDI/Direct3DX-derived code. <a href="https://www.mozilla.org/MPL/1.1/">Read MPL 1.1</a>.</p>
      {manifest && <dl className="pins">
        <dt>Base content pin</dt><dd><a href={sourceUrl(manifest.pins.base.repo, manifest.pins.base.commit)}><code>{manifest.pins.base.commit}</code></a></dd>
        <dt>OpenSoldat source pin</dt><dd><a href={sourceUrl(manifest.pins.opensoldat.repo, manifest.pins.opensoldat.commit)}><code>{manifest.pins.opensoldat.commit}</code></a></dd>
      </dl>}
    </section>
    <details>
      <summary>Known historic map authors</summary>
      <p>Preserved from the official 1.7.1.1 manual; historic titles may differ from the imported catalog. No classic installer assets are shipped. <a href="https://opensoldat.github.io/manual/manual.html#license">Manual credits</a></p>
      <dl className="map-credits">{HISTORIC_MAP_CREDITS.map(([author, maps]) => <div key={`${author}:${maps}`}><dt>{author}</dt><dd>{maps}</dd></div>)}</dl>
    </details>
    <section>
      <h3>Served notices & licenses</h3>
      {!notices && !noticeError && <p role="status">Loading notice texts…</p>}
      {noticeError && <p role="alert">Could not load notices: {noticeError}</p>}
      {notices?.map(notice => <details key={notice.path}>
        <summary>{notice.title}</summary>
        <p><a href={contentUrl(notice.path)}>Open original notice text</a></p>
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
      {!manifest ? <p>The content index is unavailable. Its error is shown in the main menu.</p> : <>
        <p><a href={contentUrl('manifest.json')}>Open full content manifest</a>. Every contribution retains its credit, license, source pin, source hash and ordered transformations.</p>
        <label>Find a source path, creator or license<input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
        <p className="muted" role="status">{matching.length} provenance records{matching.length > 0 ? `; showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, matching.length)}` : ''}.</p>
        <div className="provenance-list">{matching.slice(page * pageSize, (page + 1) * pageSize).map(({ key, object, hash, source }) => <details key={key}>
          <summary>{source.sourcePath} <span className="license-tag">{source.licenseId}</span></summary>
          <dl>
            <dt>Credit</dt><dd>{source.credit}</dd>
            <dt>Source</dt><dd><a href={sourceUrl(source.sourceRepo, source.sourceCommit, source.sourcePath)}>{source.sourceRepo} / {source.sourcePath}</a></dd>
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

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog ref={dialog} className="shell-dialog" aria-labelledby="dialog-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2 id="dialog-title">{title}</h2><button type="button" onClick={onClose}>Close</button></header>
    <div className="dialog-body">{children}</div>
  </dialog>;
}

function ClientShell({ settings, setSettings }: { settings: Settings; setSettings: (settings: Settings) => void }) {
  const [manifest, setManifest] = useState<ContentManifest | null>(null);
  const [manifestError, setManifestError] = useState('');
  const [reload, setReload] = useState(0);
  const [selectedMap, setSelectedMap] = useState('Arena');
  const [mapQuery, setMapQuery] = useState('');
  const [runningMap, setRunningMap] = useState<string | null>(null);
  const [page, setPage] = useState<'play' | 'settings' | 'credits'>('play');
  const [modal, setModal] = useState<'settings' | 'credits' | null>(null);
  const [status, setStatus] = useState('');
  const [settingsStatus, setSettingsStatus] = useState('');
  const [audioStatus, setAudioStatus] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setManifestError('');
    loadContentManifest(abort.signal).then(index => {
      if (abort.signal.aborted) return;
      setManifest(index);
      setSelectedMap(current => Object.hasOwn(index.maps, current) ? current : (Object.keys(index.maps).sort()[0] ?? ''));
    }).catch(error => { if (!abort.signal.aborted) setManifestError(errorMessage(error)); });
    return () => abort.abort();
  }, [reload]);
  const applySettings = useCallback((next: Settings) => {
    setSettings(next);
    try { saveSettings(next); setSettingsStatus('Settings applied and saved on this device.'); }
    catch (error) { setSettingsStatus(`Settings applied, but could not be saved: ${errorMessage(error)}`); }
    setModal(null);
  }, [setSettings]);
  const mapNames = useMemo(() => Object.keys(manifest?.maps ?? {}).sort((a, b) => a.localeCompare(b)), [manifest]);
  const visibleMaps = mapNames.filter(name => name.toLowerCase().includes(mapQuery.trim().toLowerCase()));
  const currentMap = manifest?.maps[selectedMap];
  const activeMissing = currentMap?.missing.filter(item => item.active) ?? [];
  const unlockAudio = () => {
    try {
      // The unlock call itself stays in the click gesture, before any await.
      Promise.resolve(unlockGameAudio()).then(() => setAudioStatus('Audio enabled.')).catch(error => setAudioStatus(`Audio could not be enabled: ${errorMessage(error)}`));
    } catch (error) { setAudioStatus(`Audio could not be enabled: ${errorMessage(error)}`); }
  };

  if (runningMap) return <main className="play-shell">
    <header className="game-toolbar">
      <div className="game-status"><strong>{runningMap}</strong><span role="status">{status || 'Starting map…'}</span></div>
      <nav aria-label="In-game menu">
        <button type="button" onClick={unlockAudio}>Enable audio</button>
        <button type="button" onClick={() => setModal('settings')}>Settings</button>
        <button type="button" onClick={() => setModal('credits')}>About / Credits</button>
        <button type="button" onClick={() => { setRunningMap(null); setAudioStatus(''); }}>Main menu</button>
      </nav>
      {audioStatus && <span className="audio-status" role="status">{audioStatus}</span>}
    </header>
    <GameSurface map={runningMap} settings={settings} onStatus={setStatus} />
    {modal && <Modal title={modal === 'settings' ? 'Settings' : 'About / Credits & Licenses'} onClose={() => setModal(null)}>
      {modal === 'settings' ? <SettingsPanel settings={settings} onApply={applySettings} /> : <CreditsPanel manifest={manifest} />}
    </Modal>}
  </main>;

  return <main className="briefing-shell">
    <aside className="briefing-sidebar">
      <header><div className="briefing-mark" aria-hidden="true"><span /><span /><span /></div><h1>Field sandbox</h1><p>Offline browser development build</p></header>
      <nav aria-label="Main menu">
        <button type="button" aria-current={page === 'play' ? 'page' : undefined} onClick={() => setPage('play')}>Choose map</button>
        <button type="button" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>Settings</button>
        <button type="button" aria-current={page === 'credits' ? 'page' : undefined} onClick={() => setPage('credits')}>Credits & Licenses</button>
      </nav>
      <p className="sidebar-note">Desktop keyboard and mouse.<br />Single-player sandbox; no server connection.</p>
      <p className="disclaimer">Unofficial. Uses open-licensed Soldat/OpenSoldat content. No affiliation or endorsement.</p>
    </aside>
    <section className="briefing-content" aria-labelledby="page-title">
      <header className="page-header"><h2 id="page-title">{page === 'play' ? 'Choose a map' : page === 'settings' ? 'Settings' : 'Credits & Licenses'}</h2><span className="build-note">Local sandbox</span></header>
      {manifestError && <div className="error-message" role="alert"><p>{manifestError} Check that imported content is served at /content/.</p><button type="button" onClick={() => setReload(reload + 1)}>Reload content index</button></div>}
      {settingsStatus && <p className="save-status" role="status">{settingsStatus}</p>}
      {page === 'play' && <>
        <p className="section-intro">Explore imported maps locally. Only the selected map and its required assets load when you start.</p>
        {!manifest && !manifestError && <p role="status">Loading map catalog…</p>}
        {manifest && <div className="map-briefing">
          <div className="map-catalog">
            <label htmlFor="map-search">Find a map</label><input id="map-search" type="search" placeholder="Map name" value={mapQuery} onChange={event => setMapQuery(event.target.value)} />
            <label htmlFor="map-choice">Imported maps <span className="muted">({visibleMaps.length} of {mapNames.length})</span></label>
            <select id="map-choice" size={14} value={visibleMaps.includes(selectedMap) ? selectedMap : ''} onChange={event => setSelectedMap(event.target.value)}>
              {visibleMaps.map(name => <option key={name} value={name}>{name}{manifest.maps[name]?.missing.some(item => item.active) ? ' — asset warning' : ''}</option>)}
            </select>
            {visibleMaps.length === 0 && <p role="status">No matching maps. Try another name.</p>}
          </div>
          <div className="map-orders">
            <h3>{selectedMap || 'No maps imported'}</h3>
            <dl><dt>Session</dt><dd>Local single-player sandbox</dd><dt>Texture filtering</dt><dd>{settings.filter === 'nearest' ? 'Nearest' : 'Linear'}{settings.mipmaps ? ', mipmaps on' : ', mipmaps off'}</dd></dl>
            {activeMissing.length > 0 && <div className="asset-warning"><h4>Content warning</h4><ul>{activeMissing.map((item, index) => <li key={index}>{item.requested}{item.fallback ? ` — fallback: ${item.fallback}` : ' — missing dependency'}</li>)}</ul></div>}
            <button type="button" className="primary launch-button" disabled={!currentMap} onClick={() => { setStatus(''); setRunningMap(selectedMap); }}>Start sandbox</button>
            <p className="muted">Controls are configurable in Settings. Audio is off until you choose Enable audio in-game.</p>
          </div>
        </div>}
      </>}
      {page === 'settings' && <SettingsPanel settings={settings} onApply={applySettings} />}
      {page === 'credits' && <CreditsPanel manifest={manifest} />}
    </section>
  </main>;
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [route] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return { capture: params.has('capture'), map: params.get('map') || 'Airpirates' };
  });
  // Capture bypasses all menus, dialogs, status overlays and catalog requests.
  if (route.capture) return <GameSurface capture map={route.map} settings={settings} />;
  return <ClientShell settings={settings} setSettings={setSettings} />;
}
