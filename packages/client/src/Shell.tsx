import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GameSurface, CreditsPanel } from './ShellPanels';
import { openGameWeapons, setGamePaused, setGameVolume, unlockGameAudio } from './game';
import { DEFAULT_SETTINGS, hasSavedNickname, saveSettings, validNickname, type ControlAction, type Settings } from './settings';
import { DEFAULT_SANDBOX, type SandboxOptions } from './sandbox-options';
import { CONTENT_NOTICES, contentUrl, type ContentIndex } from './content';
import { MapPreview } from './MapPreview';
import { prepareShell, type ShellProgress } from './shell-assets';
import { countdownSeconds, lobbyCode, menuKey, searchTransition, type SearchState } from './shell-state';
import { apiOrigin, apiRequest, LobbyConnection, type JoinedMatch, type LobbyState, type Region } from './shell-api';
import type { LobbyLookup } from '@soldat-web/protocol';

type Screen = 'boot' | 'name' | 'menu' | 'quickplay' | 'joined' | 'lobby' | 'maps' | 'join' | 'practice' | 'settings' | 'credits' | 'pause';
const MAIN: { label: string; screen: Screen }[] = [
  { label: 'Quick play', screen: 'quickplay' }, { label: 'Play with friends', screen: 'lobby' }, { label: 'Join lobby', screen: 'join' },
  { label: 'Practice vs bots', screen: 'practice' }, { label: 'Settings', screen: 'settings' }, { label: 'Credits & licenses', screen: 'credits' },
];
const CONTROLS: [ControlAction, string][] = [['left', 'Move left'], ['right', 'Move right'], ['up', 'Jump'], ['down', 'Crouch'], ['fire', 'Fire'], ['jetpack', 'Jetpack'], ['throwNade', 'Throw grenade'], ['changeWeapon', 'Change weapon'], ['throwWeapon', 'Drop weapon'], ['reload', 'Reload'], ['prone', 'Prone'], ['flagThrow', 'Throw flag']];
const modeLabel = (mode: string) => mode === 'ctf' ? 'Capture the flag' : 'Deathmatch';
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const ATTRACT_OPTIONS: SandboxOptions = { ...DEFAULT_SANDBOX, bots: 8 };
const ATTRACT_MOUNT = { attract: true };

function Row({ number, children, onClick, onHighlight, disabled = false, selected = false }: { number: number; children: ReactNode; onClick(): void; onHighlight?(): void; disabled?: boolean; selected?: boolean }) {
  return <button type="button" className={`menu-row${selected ? ' active' : ''}`} data-menu-row disabled={disabled} onClick={onClick} onPointerEnter={onHighlight} onFocus={onHighlight}><span className="number" aria-hidden="true">{number}</span>{children}</button>;
}
function Roster({ humans, bots, me }: { humans: { nickname: string; ready?: boolean }[]; bots: number; me: string }) {
  return <ul className="roster" aria-label="Players">{humans.map((player, i) => <li key={i} className={`${player.nickname === me ? 'you' : ''}${player.ready === false ? ' waiting' : ''}`} title={player.ready === false ? 'Not ready' : undefined}>{player.nickname}</li>)}{bots > 0 && <li className="bots">+ {bots} bots</li>}</ul>;
}

function SettingsRows({ settings, apply, back }: { settings: Settings; apply(value: Settings): void; back(): void }) {
  const [binding, setBinding] = useState<ControlAction | null>(null);
  const [draftName, setDraftName] = useState(settings.nickname);
  useEffect(() => {
    if (!binding) return;
    const assign = (event: KeyboardEvent | PointerEvent) => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event instanceof KeyboardEvent && event.code === 'Escape') { setBinding(null); return; }
      apply({ ...settings, bindings: { ...settings.bindings, [binding]: event instanceof KeyboardEvent ? event.code : `Mouse${event.button}` } });
      setBinding(null);
    };
    window.addEventListener('keydown', assign, true); window.addEventListener('pointerdown', assign, true);
    return () => { window.removeEventListener('keydown', assign, true); window.removeEventListener('pointerdown', assign, true); };
  }, [binding, settings, apply]);
  return <>
    <label className="settings-row"><span>Master volume <small>{Math.round(settings.volume * 100)}%</small></span><input aria-label="Master volume" type="range" min="0" max="100" value={Math.round(settings.volume * 100)} onChange={e => apply({ ...settings, volume: Number(e.target.value) / 100 })} /></label>
    <label className="settings-row"><span>Gameplay background</span><input type="checkbox" checked={settings.gameplayBackground} onChange={e => apply({ ...settings, gameplayBackground: e.target.checked })} /></label>
    <label className="settings-row"><span>Name</span><input aria-label="Name" maxLength={24} value={draftName} aria-invalid={!validNickname(draftName)} onChange={e => setDraftName(e.target.value)} onBlur={() => { if (validNickname(draftName)) apply({ ...settings, nickname: draftName }); else setDraftName(settings.nickname); }} /></label>
    <details className="settings-details"><summary>Graphics & controls</summary>
      <label className="settings-row"><span>Texture filtering</span><select value={settings.filter} onChange={e => apply({ ...settings, filter: e.target.value as Settings['filter'] })}><option value="linear">Linear</option><option value="nearest">Nearest</option></select></label>
      <label className="settings-row"><span>Use mipmaps</span><input type="checkbox" checked={settings.mipmaps} onChange={e => apply({ ...settings, mipmaps: e.target.checked })} /></label>
      <div className="binding-grid">{CONTROLS.map(([action, label], i) => <Row key={action} number={i + 1} onClick={() => setBinding(action)}><span>{label}</span><strong>{binding === action ? 'Press a key…' : settings.bindings[action]}</strong></Row>)}</div>
      {binding && <p role="status">Press a key or mouse button. Escape cancels.</p>}
      <button className="action" onClick={() => apply({ ...DEFAULT_SETTINGS, nickname: settings.nickname, bindings: { ...DEFAULT_SETTINGS.bindings } })}>Restore defaults</button>
    </details>
    <div className="actions"><button className="action primary" onClick={back}>Back [Esc]</button></div>
  </>;
}

export function ClientShell({ settings, setSettings }: { settings: Settings; setSettings(value: Settings): void }) {
  const [screen, setScreen] = useState<Screen>('boot');
  const [index, setIndex] = useState<ContentIndex | null>(null);
  const [progress, setProgress] = useState<ShellProgress>({ files: 0, totalFiles: 0, bytes: 0, totalBytes: 0, label: 'Loading content index…' });
  const [error, setError] = useState('');
  const [bootAttempt, setBootAttempt] = useState(0);
  const [name, setName] = useState(() => hasSavedNickname() ? settings.nickname : '');
  const [joinInput, setJoinInput] = useState(() => new URLSearchParams(location.search).get('lobby') ?? '');
  const [selected, setSelected] = useState(0);
  const [sandbox, setSandbox] = useState<SandboxOptions>({ ...DEFAULT_SANDBOX, bots: 15 });
  const [map, setMap] = useState('Arena');
  const [mapHighlight, setMapHighlight] = useState('Arena');
  const [mapReturn, setMapReturn] = useState<'practice' | 'lobby'>('practice');
  const [running, setRunning] = useState<{ map: string; sandbox: SandboxOptions; serverUrl?: string } | null>(() => {
    const params = new URLSearchParams(location.search);
    return params.has('server') ? { map: params.get('map') || 'Arena', sandbox: { ...DEFAULT_SANDBOX }, serverUrl: params.get('server')! } : null;
  });
  const [gameSettings, setGameSettings] = useState(settings);
  const [gameStatus, setGameStatus] = useState('');
  const [joined, setJoined] = useState<JoinedMatch | null>(null);
  const [regions, setRegions] = useState<(Region & { rtt: number | null })[]>([]);
  const [search, setSearch] = useState<SearchState>({ phase: 'testing' });
  const [seconds, setSeconds] = useState(3);
  const [lobby, setLobby] = useState<LobbyState | null>(null);
  const [selfId, setSelfId] = useState<string>();
  const [hosting, setHosting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyLink, setCopyLink] = useState('');
  const lobbySocket = useRef<LobbyConnection | null>(null);
  const lobbyHandoff = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const panel = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(!document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [rotation, setRotation] = useState(0);
  const botMaps = useMemo(() => ['ctf_Ash', 'Airpirates', 'DesertWind', 'Arena', 'ctf_Death'].filter(name => index?.maps[name]?.botCapable), [index]);
  const attractMap = botMaps[rotation % Math.max(1, botMaps.length)];
  const attractSettings = useMemo(() => ({ ...DEFAULT_SETTINGS, filter: settings.filter, mipmaps: settings.mipmaps, bindings: { ...DEFAULT_SETTINGS.bindings } }), [settings.filter, settings.mipmaps]);
  const mode = screen === 'lobby' || (screen === 'maps' && mapReturn === 'lobby') ? lobby?.mode ?? 'dm' : sandbox.mode;
  const maps = useMemo(() => Object.keys(index?.maps ?? {}).filter(name => mapReturn !== 'lobby' || (index?.maps[name]?.botCapable && (mode === 'ctf' ? /^ctf_/i.test(name) : !/^(ctf|inf|htf)_/i.test(name)))).sort((a, b) => a.localeCompare(b)), [index, mode, mapReturn]);
  const updateSettings = useCallback((value: Settings) => { setSettings(value); saveSettings(value); setGameVolume(value.volume); }, [setSettings]);
  const closeLobby = useCallback(() => { lobbySocket.current?.close(); lobbySocket.current = null; lobbyHandoff.current = null; setLobby(null); setSelfId(undefined); }, []);
  const navigate = useCallback((next: Screen) => { request.current?.abort(); request.current = null; setError(''); setSelected(0); setScreen(next); }, []);
  const back = useCallback(() => {
    if (screen === 'boot' || (screen === 'name' && !hasSavedNickname())) return;
    if (screen === 'maps') { navigate(mapReturn); return; }
    if (running) { setGameSettings(settings); navigate(screen === 'settings' ? 'pause' : 'menu'); return; }
    if (screen === 'lobby') closeLobby();
    navigate('menu');
  }, [screen, running, settings, mapReturn, navigate, closeLobby]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const visibility = () => setVisible(!document.hidden), motion = () => setReduced(media.matches);
    document.addEventListener('visibilitychange', visibility); media.addEventListener('change', motion);
    return () => { document.removeEventListener('visibilitychange', visibility); media.removeEventListener('change', motion); };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    prepareShell(setProgress, abort.signal).then(value => {
      if (abort.signal.aborted) return;
      setIndex(value); setScreen(hasSavedNickname() ? (joinInput ? 'join' : 'menu') : 'name');
    }).catch(reason => { if (!abort.signal.aborted) setError(errorText(reason)); });
    return () => abort.abort();
  }, [bootAttempt]);
  useEffect(() => { if (running || !visible || reduced || !settings.gameplayBackground) return; const timer = setInterval(() => setRotation(value => value + 1), 90_000); return () => clearInterval(timer); }, [running, visible, reduced, settings.gameplayBackground]);
  useEffect(() => { if (running) setGamePaused(screen !== 'menu'); }, [running, screen]);
  useEffect(() => { setGameVolume(settings.volume); }, [settings.volume]);
  useEffect(() => {
    const unlock = () => { void unlockGameAudio().catch(reason => setError(`Audio unavailable: ${errorText(reason)}`)); };
    window.addEventListener('pointerdown', unlock, { once: true }); window.addEventListener('keydown', unlock, { once: true });
    return () => { window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
  }, []);
  useEffect(() => () => { request.current?.abort(); lobbySocket.current?.close(); }, []);
  useEffect(() => {
    if (screen !== 'quickplay') return;
    const abort = new AbortController(); request.current = abort;
    let state: SearchState = { phase: 'testing' }, timer: number | undefined;
    setSearch(state); setRegions([]); setSeconds(3);
    void (async () => {
      const configured = await apiRequest<Region[]>(apiOrigin(), '/api/regions', abort.signal);
      if (!configured.length) throw new Error('No game regions are configured.');
      const probes: (Region & { rtt: number | null })[] = [];
      for (const region of configured) {
        const start = performance.now();
        try {
          const response = await fetch(new URL('/api/ping', region.url), { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]), cache: 'no-store' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await response.arrayBuffer(); probes.push({ ...region, rtt: Math.round(performance.now() - start) });
        } catch (reason) { if (abort.signal.aborted) throw reason; probes.push({ ...region, rtt: null }); }
        setRegions([...probes]);
      }
      const best = probes.filter(item => item.rtt !== null).sort((a, b) => a.rtt! - b.rtt!)[0];
      if (!best) throw new Error('No region responded. Check your connection and try again.');
      state = searchTransition(state, { type: 'tested', region: best.id, now: performance.now() }); setSearch(state);
      timer = window.setInterval(() => {
        if (abort.signal.aborted) return;
        const now = performance.now(); state = searchTransition(state, { type: 'tick', now }); setSearch(state); setSeconds(countdownSeconds(state, now));
        if (state.phase === 'joining') {
          clearInterval(timer);
          void apiRequest<JoinedMatch>(best.url, '/api/quickplay', abort.signal, { nickname: settings.nickname }).then(match => { if (!abort.signal.aborted) { setJoined(match); setScreen('joined'); } }).catch(reason => { if (!abort.signal.aborted) setError(errorText(reason)); });
        }
      }, 100);
    })().catch(reason => { if (!abort.signal.aborted) setError(errorText(reason)); });
    return () => { state = searchTransition(state, { type: 'cancel' }); abort.abort(); clearInterval(timer); };
  }, [screen === 'quickplay', settings.nickname]);

  const attachLobby = (url: string, hostToken?: string) => {
    lobbySocket.current?.close();
    lobbySocket.current = new LobbyConnection(url, settings.nickname, hostToken, (state, id) => {
      setLobby(state); if (id) setSelfId(id);
      if (state.started && state.matchWsUrl && lobbyHandoff.current !== (state.matchId ?? state.matchWsUrl)) {
        lobbyHandoff.current = state.matchId ?? state.matchWsUrl;
        setGameSettings(settings);
        setRunning({ map: state.map, sandbox: { ...DEFAULT_SANDBOX, mode: state.mode }, serverUrl: state.matchWsUrl });
        setScreen('menu');
      }
    }, setError);
  };
  const createLobby = async () => {
    navigate('lobby'); setHosting(true); setBusy(true); closeLobby();
    const abort = new AbortController(); request.current = abort;
    try {
      const created = await apiRequest<{ code: string; wsUrl: string; hostToken: string }>(apiOrigin(), '/api/lobbies', abort.signal, { mode: sandbox.mode, map });
      if (!abort.signal.aborted) attachLobby(created.wsUrl, created.hostToken);
    } catch (reason) { if (!abort.signal.aborted) setError(errorText(reason)); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const joinLobby = async () => {
    const code = lobbyCode(joinInput);
    if (!code) { setError('Paste a lobby link or 6-character code.'); return; }
    setError(''); setBusy(true); setHosting(false);
    const abort = new AbortController(); request.current = abort;
    try {
      const state = await apiRequest<LobbyLookup>(apiOrigin(), `/api/lobbies/${code}`, abort.signal);
      if (abort.signal.aborted) return;
      setLobby(state); setScreen('lobby');
      attachLobby(state.wsUrl);
    } catch (reason) { if (!abort.signal.aborted) setError(errorText(reason)); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const chooseMap = (next: string) => {
    if (mapReturn === 'lobby') lobbySocket.current?.send({ type: 'lobby-update', map: next }); else setMap(next);
    navigate(mapReturn);
  };
  const changeMode = () => {
    const next = mode === 'dm' ? 'ctf' : 'dm';
    const nextMap = next === 'ctf' ? 'ctf_Ash' : 'Arena';
    if (screen === 'lobby') lobbySocket.current?.send({ type: 'lobby-update', mode: next, map: nextMap });
    else { setSandbox(value => ({ ...value, mode: next })); setMap(nextMap); }
  };
  const openMaps = () => { setMapReturn(screen === 'lobby' ? 'lobby' : 'practice'); setMapHighlight(screen === 'lobby' ? lobby?.map ?? map : map); navigate('maps'); };
  const enterMatch = () => { if (joined) { setGameSettings(settings); setRunning({ map: joined.map, sandbox: { ...DEFAULT_SANDBOX, mode: joined.mode }, serverUrl: joined.wsUrl }); navigate('menu'); } };
  const startPractice = () => { setGameSettings(settings); setGameStatus(''); setRunning({ map, sandbox: { ...sandbox } }); navigate('menu'); };
  const leaveGame = () => { setRunning(null); closeLobby(); navigate('menu'); };
  const primary = () => {
    if (screen === 'joined') enterMatch();
    else if (screen === 'practice') startPractice();
    else if (screen === 'lobby' && lobby) { const me = lobby.players.find(player => player.id === selfId); lobbySocket.current?.send(hosting ? { type: 'lobby-start' } : { type: 'lobby-ready', ready: !me?.ready }); }
    else if (screen === 'settings' || screen === 'credits') back();
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (running && screen === 'menu') {
        if (event.key === 'Escape' && !(event.target instanceof HTMLElement && event.target.matches('input,textarea'))) {
          event.preventDefault(); event.stopImmediatePropagation(); setScreen('pause');
        }
        return;
      }
      const editing = event.target instanceof HTMLElement && event.target.matches('input,select,textarea');
      if (!editing && screen === 'practice' && (event.key === '3' || event.key === '4')) { event.preventDefault(); panel.current?.querySelector<HTMLElement>(event.key === '3' ? '#bot-count' : '#bot-difficulty')?.focus(); return; }
      if (!editing && event.key === 'Enter' && !['menu', 'maps', 'pause'].includes(screen) && !(event.target instanceof HTMLElement && event.target.closest('button,a,summary'))) { event.preventDefault(); primary(); return; }
      const rows = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[data-menu-row]:not(:disabled)') ?? []).filter(row => row.getClientRects().length > 0);
      const action = menuKey(event.key, screen === 'maps' ? Math.max(0, maps.indexOf(mapHighlight)) : selected, rows.length, editing);
      if (!action) { if (!editing && event.key === 'Enter' && !rows.length && !(event.target instanceof HTMLElement && event.target.closest('button,a,summary'))) { event.preventDefault(); primary(); } return; }
      if (action.type === 'back') { event.preventDefault(); event.stopImmediatePropagation(); back(); }
      else if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof HTMLElement && event.target.closest('button,a,summary')) return;
      else { event.preventDefault(); if (action.type === 'select') { setSelected(action.index); rows[action.index]?.focus(); if (screen === 'maps') setMapHighlight(maps[action.index]); } else if (screen === 'maps') chooseMap(maps[action.index]); else rows[action.index]?.click(); }
    };
    window.addEventListener('keydown', keydown, true); return () => window.removeEventListener('keydown', keydown, true);
  });
  const setup = <div className="config"><Row number={1} disabled={screen === 'lobby' && (!hosting || !lobby || lobby.started)} onClick={changeMode}><span>Game type</span><strong>{modeLabel(mode)}</strong></Row><Row number={2} disabled={screen === 'lobby' && (!hosting || !lobby || lobby.started)} onClick={openMaps}><span>Map</span><strong>{screen === 'lobby' ? lobby?.map ?? map : map}</strong></Row></div>;
  let content: ReactNode;
  if (screen === 'boot') content = <><div className="progress" role="progressbar" aria-label="Loading assets" aria-valuemin={0} aria-valuemax={progress.totalFiles || 1} aria-valuenow={progress.files}><span style={{ width: `${progress.totalFiles ? 100 * progress.files / progress.totalFiles : 0}%` }} /></div><p className="load-file" role="status">{progress.label}<br /><small>{progress.files} / {progress.totalFiles || '…'} files · {(progress.bytes / 1048576).toFixed(1)}{progress.totalBytes ? ` / ${(progress.totalBytes / 1048576).toFixed(1)}` : ''} MB</small></p>{error && <button className="action" onClick={() => { setError(''); setBootAttempt(value => value + 1); }}>Retry</button>}</>;
  else if (screen === 'name') content = <><h2>Your name</h2><form onSubmit={event => { event.preventDefault(); if (!validNickname(name)) { setError('Use 1–24 letters, numbers or symbols.'); return; } updateSettings({ ...settings, nickname: name }); navigate(joinInput ? 'join' : 'menu'); }}><div className="field"><input autoFocus aria-label="Player name" aria-describedby="shell-error" autoComplete="nickname" spellCheck={false} maxLength={24} placeholder="Type your name" value={name} onChange={event => { setName(event.target.value); setError(''); }} /></div><button className="action primary" type="submit">Continue [Enter]</button></form></>;
  else if (screen === 'menu') content = <nav className="menu" aria-label="Main menu">{MAIN.map((item, i) => <Row key={item.screen} number={i + 1} selected={selected === i} onHighlight={() => setSelected(i)} onClick={() => { if (item.screen === 'lobby') void createLobby(); else navigate(item.screen); }}><span>{item.label}</span></Row>)}</nav>;
  else if (screen === 'quickplay') content = <><h2>Finding a game</h2><div className="region-results"><table className="regions"><tbody>{regions.map(region => <tr key={region.id} className={'region' in search && search.region === region.id ? 'chosen' : ''}><td>{region.name}</td><td>{region.rtt === null ? 'Unavailable' : `${region.rtt} ms`}</td></tr>)}</tbody></table></div><div className="search-status" role="status">{search.phase === 'testing' ? <><i className="spinner" />Testing regions…</> : search.phase === 'countdown' ? <span className="countdown">Joining {regions.find(region => region.id === search.region)?.name} in <strong>{seconds}</strong>…</span> : 'Joining…'}</div><div className="actions"><button className="action" onClick={back}>Cancel [Esc]</button></div></>;
  else if (screen === 'joined' && joined) content = <><h2>{joined.map}</h2><p className="match-label">{modeLabel(joined.mode)}{regions.find(region => 'region' in search && region.id === search.region)?.rtt != null ? ` / ${regions.find(region => 'region' in search && region.id === search.region)?.rtt} ms` : ''}</p><MapPreview map={joined.map} /><Roster humans={joined.humans.map(nickname => ({ nickname }))} bots={joined.bots} me={settings.nickname} /><div className="actions"><button className="action primary" onClick={enterMatch}>Enter game [Enter]</button><button className="action" onClick={back}>Back</button></div></>;
  else if (screen === 'lobby') content = <><h2>Friend game</h2><div className="lobby-setup">{setup}<MapPreview map={lobby?.map ?? map} /></div><div className="lobby-code"><strong>{lobby?.code ?? (busy ? 'Creating…' : '')}</strong>{lobby && <button className="action" onClick={() => { const url = new URL('/', location.href); url.searchParams.set('lobby', lobby.code); void navigator.clipboard.writeText(url.href).then(() => setCopyLink('Link copied')).catch(() => setCopyLink(url.href)); }}>Copy link</button>}</div>{copyLink && <p className="copy-link" role="status">{copyLink}</p>}<Roster humans={lobby?.players.map(player => ({ ...player, ready: player.host || player.ready })) ?? []} bots={Math.max(0, (lobby?.targetPlayers ?? 16) - (lobby?.players.length ?? 0))} me={settings.nickname} /><div className="actions"><button className="action primary" disabled={!lobby || lobby.started} onClick={primary}>{hosting ? 'Start [Enter]' : lobby?.players.find(player => player.id === selfId)?.ready ? 'Ready ✓ [Enter]' : 'Ready up [Enter]'}</button><button className="action" onClick={back}>Leave</button></div></>;
  else if (screen === 'maps') content = <><h2>Choose a map</h2><div className="map-picker"><div className="map-list" role="listbox" aria-label="Maps">{maps.map((item, i) => <button className="menu-row" type="button" key={item} data-menu-row role="option" aria-selected={item === mapHighlight} onPointerEnter={() => setMapHighlight(item)} onFocus={() => setMapHighlight(item)} onClick={() => chooseMap(item)}><span className="number">{i + 1}</span><span>{item}</span></button>)}</div><div><MapPreview map={mapHighlight} /><p className="map-name">{mapHighlight}</p>{index?.maps[mapHighlight] && !index.maps[mapHighlight].botCapable && <p className="small">bots need waypoints on this map</p>}</div></div><div className="actions"><button className="action" onClick={back}>Back [Esc]</button></div></>;
  else if (screen === 'join') content = <><h2>Join a friend game</h2><form onSubmit={event => { event.preventDefault(); void joinLobby(); }}><div className="field"><input autoFocus aria-label="Lobby link or code" autoComplete="off" spellCheck={false} placeholder="Link or code" value={joinInput} onChange={event => setJoinInput(event.target.value)} /></div><button className="action primary" type="submit" disabled={busy}>{busy ? 'Joining…' : 'Join [Enter]'}</button></form><div className="actions"><button className="action" onClick={back}>Back</button></div></>;
  else if (screen === 'practice') content = <><h2>Practice vs bots</h2>{setup}<label className="menu-row config"><span className="number">3</span><span>Bots</span><input id="bot-count" type="number" min={0} max={31} value={sandbox.bots} onChange={event => setSandbox({ ...sandbox, bots: Math.max(0, Math.min(31, Math.trunc(Number(event.target.value)))) })} /></label><label className="menu-row config"><span className="number">4</span><span>Difficulty</span><select id="bot-difficulty" value={sandbox.botDifficulty} onChange={event => setSandbox({ ...sandbox, botDifficulty: Number(event.target.value) })}>{[[300, 'Stupid'], [200, 'Poor'], [100, 'Normal'], [50, 'Hard'], [10, 'Impossible']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>{sandbox.mode === 'ctf' && <><label className="settings-row"><span>Your team</span><select aria-label="Your team" value={sandbox.team} onChange={event => setSandbox({ ...sandbox, team: Number(event.target.value) as 1 | 2 })}><option value={1}>Alpha</option><option value={2}>Bravo</option></select></label><label className="settings-row"><span>Bot teams</span><select aria-label="Bot teams" value={sandbox.botTeam} onChange={event => setSandbox({ ...sandbox, botTeam: event.target.value as SandboxOptions['botTeam'] })}><option value="balanced">Balanced</option><option value="alpha">All Alpha</option><option value="bravo">All Bravo</option></select></label></>}<MapPreview map={map} />{sandbox.bots > 0 && index?.maps[map] && !index.maps[map].botCapable && <p className="asset-warning">bots need waypoints on this map</p>}{index?.maps[map]?.missing.filter(item => item.active).map((item, i) => <p className="asset-warning" key={i}>{item.requested}{item.fallback ? ` — fallback: ${item.fallback}` : ' — missing dependency'}</p>)}<div className="actions"><button className="action primary" onClick={startPractice}>Start practice [Enter]</button><button className="action" onClick={back}>Back</button></div></>;
  else if (screen === 'settings') content = <><h2>Settings</h2><SettingsRows settings={settings} apply={updateSettings} back={back} /></>;
  else if (screen === 'credits') content = <>
    <h2>Credits</h2>
    <ul className="credit-list">
      
      <li>A port of the original OpenSoldat game logic, compiled to WebAssembly and verified bit-for-bit against the original server. Art and sound re-encoded for the web (lossless WebP, Opus).</li>
      <li>Original art: Michal Marcinkowski, Transhuman Design and the base-content contributors.</li>
      <li>Airpirates: Evil Ville. DesertWind: grand_diablo. ctf_Ash: chakapoko maker. ctf_Death remake: NuZZ.</li>
      <li>Play typeface: Play contributors, SIL Open Font License 1.1.</li>
      <li>Art and captures: CC BY 4.0, cropped or tinted.</li>
    </ul>
    <nav className="menu license-links" aria-label="License documents">
      {CONTENT_NOTICES.map(notice => <a className="small" key={notice.path} href={contentUrl(notice.path)} target="_blank" rel="noopener noreferrer">{notice.title}</a>)}
    </nav>
    <p className="small">Unofficial. Not affiliated with or endorsed by Michał Marcinkowski, Transhuman Design, or the OpenSoldat contributors. Soldat Online is a development/private-build name; public release requires written permission.</p>
    <details><summary>Notices, licenses & source provenance</summary><CreditsPanel manifest={index} /></details>
    <div className="actions"><button className="action primary" onClick={back}>Back</button></div>
  </>;
  else if (screen === 'pause') content = <><h2>{running?.map}</h2><nav className="menu" aria-label="Game menu"><Row number={1} onClick={() => navigate('menu')}><span>Resume</span></Row><Row number={2} onClick={() => { navigate('menu'); openGameWeapons(); }}><span>Weapons</span></Row><Row number={3} onClick={() => navigate('settings')}><span>Settings</span></Row><Row number={4} onClick={leaveGame}><span>Leave game</span></Row></nav></>;
  const showShell = !running || screen !== 'menu';
  return <div className="theme-a">
    {running ? <main className="play-shell"><GameSurface map={running.map} settings={gameSettings} sandbox={running.sandbox} serverUrl={running.serverUrl} onStatus={setGameStatus} />{gameStatus && /unavailable|stopped|error/i.test(gameStatus) && <p className="game-error" role="alert">{gameStatus}</p>}</main> : <div className="attract-scene" aria-hidden="true">{index && attractMap && visible && settings.gameplayBackground && <GameSurface key={`${attractMap}-${reduced}`} map={attractMap} settings={attractSettings} sandbox={ATTRACT_OPTIONS} mountOptions={ATTRACT_MOUNT} still={reduced} />}<div className="attract-shade" /></div>}
    {showShell && <main className={`stage ${screen}${['joined', 'lobby', 'maps', 'credits', 'settings'].includes(screen) ? ` ${screen}-screen` : ''}${running ? ' game-overlay' : ''}`}><div className="shell"><header className="masthead"><h1 className="wordmark"><span>Soldat</span><span>Online</span></h1></header><section className="panel" ref={panel} aria-label={screen}>{content}{error && <p id="shell-error" className="error" role="alert">{error}</p>}</section></div></main>}
  </div>;
}
