import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { GameSurface, CreditsPanel, AppearanceRows, RuleRows } from './ShellPanels';
import { openGameWeapons, openGameTeams, updateGameSettings, setGamePaused, setGameVolume, unlockGameAudio } from './game';
import { DEFAULT_SETTINGS, hasSavedNickname, saveSettings, validNickname, type Settings } from './settings';
import { DEFAULT_SANDBOX, compatibleSandboxMaps, sandboxRules, type SandboxOptions } from './sandbox-options';
import { CONTENT_NOTICES, contentUrl, type ContentIndex } from './content';
import { MapPreview } from './MapPreview';
import { prepareShell, type ShellProgress } from './shell-assets';
import { countdownSeconds, lobbyCanKick, lobbyCode, consoleDestination, menuKey, searchTransition, type ConsoleDestination, type SearchState } from './shell-state';
import { apiOrigin, apiRequest, LobbyConnection, type JoinedMatch, type LobbyState, type Region } from './shell-api';
import { GAME_MODES, teamCount, type GameMode, type LobbyLookup } from '@soldat-web/protocol';
import { Row } from './MenuRow';
import { SettingsMenu } from './SettingsMenu';

type Screen = 'boot' | 'name' | 'menu' | 'quickplay' | 'joined' | 'lobby' | 'maps' | 'join' | 'practice' | 'settings' | 'appearance' | 'credits' | 'pause';
const MAIN: { label: string; screen: Screen }[] = [
  { label: 'Quick play', screen: 'quickplay' }, { label: 'Play with friends', screen: 'lobby' }, { label: 'Join lobby', screen: 'join' },
  { label: 'Practice vs bots', screen: 'practice' }, { label: 'Settings', screen: 'settings' }, { label: 'Credits & licenses', screen: 'credits' },
];
const MODE_LABELS: Record<GameMode, string> = { dm: 'Deathmatch', pm: 'Pointmatch', tm: 'Team match', ctf: 'Capture the flag', rambo: 'Rambomatch', inf: 'Infiltration', htf: 'Hold the flag' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const ATTRACT_OPTIONS: SandboxOptions = { ...DEFAULT_SANDBOX, bots: 8 };
const ATTRACT_MOUNT = { attract: true };

function Roster({ humans, bots, me, kick }: { humans: { id?: string; nickname: string; ready?: boolean; host?: boolean }[]; bots: number; me: string; kick?(id: string): void }) {
  return <ul className="roster" aria-label="Players">
    {humans.map((player, i) => <li key={player.id ?? i} className={player.nickname === me ? 'you' : undefined}>
      <span className="player-slot" aria-hidden="true">{i + 1}</span>
      <strong className="player-name">{player.nickname}<small className="player-role">{player.nickname === me && 'You'}{player.nickname === me && player.host && ' · '}{player.host && 'Host'}</small></strong>
      {player.ready !== undefined && <span className={`player-ready ${player.ready ? 'ready' : 'waiting'}`}>{player.ready ? 'Ready' : 'Waiting'}</span>}
      {kick && player.id && !player.host && <button type="button" className="kick-player" aria-label={`Kick ${player.nickname}`} onClick={() => kick(player.id!)}>Kick</button>}
    </li>)}
    {bots > 0 && <li className="bots"><strong>+{bots}</strong><span>Bots fill the remaining slots</span></li>}
  </ul>;
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
  const [sandbox, setSandbox] = useState<SandboxOptions>({ ...DEFAULT_SANDBOX, bots: 11 });
  const [map, setMap] = useState('Arena');
  const [mapHighlight, setMapHighlight] = useState('Arena');
  const [mapReturn, setMapReturn] = useState<'practice' | 'lobby'>('practice');
  const [running, setRunning] = useState<{ map: string; sandbox: SandboxOptions; serverUrl?: string } | null>(() => {
    const params = new URLSearchParams(location.search);
    return params.has('server') ? { map: params.get('map') || 'Arena', sandbox: { ...DEFAULT_SANDBOX }, serverUrl: params.get('server')! } : null;
  });
  const [gameSettings, setGameSettings] = useState(settings);
  const [gameStatus, setGameStatus] = useState('');
  const [roundMap, setRoundMap] = useState('');
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
  const lastConnection = useRef<ConsoleDestination | null>(null);
  /** Current screen for socket callbacks created once per lobby connection. */
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const [visible, setVisible] = useState(!document.hidden);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [rotation, setRotation] = useState(0);
  const botMaps = useMemo(() => ['ctf_Ash', 'Airpirates', 'DesertWind', 'Arena', 'ctf_Death'].filter(name => index?.maps[name]?.botCapable), [index]);
  const attractMap = botMaps[rotation % Math.max(1, botMaps.length)];
  const attractSettings = useMemo(() => ({ ...DEFAULT_SETTINGS, filter: settings.filter, mipmaps: settings.mipmaps, bindings: { ...DEFAULT_SETTINGS.bindings } }), [settings.filter, settings.mipmaps]);
  const mode = screen === 'lobby' || (screen === 'maps' && mapReturn === 'lobby') ? lobby?.mode ?? 'dm' : sandbox.mode;
  const maps = useMemo(() => index ? compatibleSandboxMaps(index, mode, mapReturn === 'lobby' || sandbox.bots > 0) : [], [index, mode, mapReturn, sandbox.bots]);
  const setupMaps = useMemo(() => index ? compatibleSandboxMaps(index, mode, screen === 'lobby' || sandbox.bots > 0) : [], [index, mode, screen, sandbox.bots]);
  const updateSettings = useCallback((value: Settings) => { setSettings(value); saveSettings(value); setGameVolume(value.volume); updateGameSettings(value); }, [setSettings]);
  const closeLobby = useCallback(() => { lobbySocket.current?.close(); lobbySocket.current = null; lobbyHandoff.current = null; setLobby(null); setSelfId(undefined); }, []);
  const navigate = useCallback((next: Screen) => { request.current?.abort(); request.current = null; setError(''); setSelected(0); setScreen(next); }, []);
  const back = useCallback(() => {
    if (screen === 'boot' || (screen === 'name' && !hasSavedNickname())) return;
    if (screen === 'maps') { navigate(mapReturn); return; }
    if (running) { navigate(screen === 'settings' || screen === 'appearance' ? 'pause' : 'menu'); return; }
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
      const origin = new URL(url);
      if (origin.protocol === 'wss:') origin.protocol = 'https:';
      if (origin.protocol === 'ws:') origin.protocol = 'http:';
      lastConnection.current = { kind: 'lobby', origin: origin.origin, code: state.code, ...(hostToken ? { hostToken } : {}) };
      if (state.started && state.matchWsUrl && lobbyHandoff.current !== (state.matchId ?? state.matchWsUrl)) {
        lobbyHandoff.current = state.matchId ?? state.matchWsUrl;
        setGameSettings(settings);
        setRoundMap(state.map);
        setRunning({ map: state.map, sandbox: { ...DEFAULT_SANDBOX, ...state.rules, mode: state.mode, mapRotation: state.mapRotation }, serverUrl: state.matchWsUrl });
        setScreen('menu');
      }
    }, setError, message => {
      closeLobby();
      if (screenRef.current === 'lobby' || screenRef.current === 'maps') { navigate('menu'); setError(message); }
    });
  };
  const createLobby = async () => {
    navigate('lobby'); setHosting(true); setBusy(true); closeLobby();
    const abort = new AbortController(); request.current = abort;
    try {
      const compatible = index ? compatibleSandboxMaps(index, sandbox.mode, true) : [];
      const lobbyMap = compatible.includes(map) ? map : compatible[0];
      if (!lobbyMap) throw new Error('No bot-capable maps support this game type.');
      const rotation = sandbox.mapRotation.filter(name => name !== lobbyMap && compatible.includes(name));
      if (rotation.length >= 32) throw new Error('Include the selected map in the rotation, or remove one map before creating a friend game.');
      const created = await apiRequest<{ code: string; wsUrl: string; hostToken: string }>(apiOrigin(), '/api/lobbies', abort.signal, { mode: sandbox.mode, map: lobbyMap, rules: sandboxRules(sandbox), mapRotation: [lobbyMap, ...rotation] });
      if (!abort.signal.aborted) attachLobby(created.wsUrl, created.hostToken);
    } catch (reason) { if (!abort.signal.aborted) setError(errorText(reason)); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const joinLobby = async () => {
    const code = lobbyCode(joinInput);
    if (!code) { setError('Paste a lobby link or 8-character code.'); return; }
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
    if (mapReturn === 'lobby') lobbySocket.current?.send({ type: 'lobby-update', map: next, mapRotation: [next, ...(lobby?.mapRotation ?? []).filter(name => name !== next)] }); else setMap(next);
    navigate(mapReturn);
  };
  const changeMode = () => {
    const next = GAME_MODES[(GAME_MODES.indexOf(mode) + 1) % GAME_MODES.length]!;
    const compatible = index ? compatibleSandboxMaps(index, next, screen === 'lobby' || sandbox.bots > 0) : [];
    if (!compatible.length) { setError(`No compatible maps for ${MODE_LABELS[next]}.`); return; }
    const nextMap = compatible.includes(map) ? map : compatible[0]!;
    if (screen === 'lobby') lobbySocket.current?.send({ type: 'lobby-update', mode: next, map: nextMap, rules: { ...lobby!.rules, mode: next }, mapRotation: [nextMap] });
    else { setSandbox(value => ({ ...value, mode: next, team: 1, botTeam: 'balanced', mapRotation: [] })); setMap(nextMap); }
  };
  const openMaps = () => { setMapReturn(screen === 'lobby' ? 'lobby' : 'practice'); setMapHighlight(screen === 'lobby' ? lobby?.map ?? map : map); navigate('maps'); };
  const enterMatch = () => {
    if (!joined) return;
    lastConnection.current = consoleDestination(new URL(joined.wsUrl).origin, apiOrigin());
    setRoundMap(joined.map); setGameSettings(settings);
    setRunning({ map: joined.map, sandbox: { ...DEFAULT_SANDBOX, mode: joined.mode }, serverUrl: joined.wsUrl });
    navigate('menu');
  };
  const startPractice = () => {
    if (!index || !compatibleSandboxMaps(index, sandbox.mode, sandbox.bots > 0).includes(map)) { setError('Choose a compatible map for these players.'); return; }
    setRoundMap(map); setGameSettings(settings); setGameStatus(''); setRunning({ map, sandbox: { ...sandbox } }); navigate('menu');
  };
  const leaveGame = () => { setRunning(null); closeLobby(); navigate('menu'); };
  const consoleShellCommand = async (command: string, args: readonly string[]) => {
    if (command === 'disconnect' || command === 'shutdown') { leaveGame(); return; }
    let destination: ConsoleDestination;
    if (command === 'retry') {
      const previous = lastConnection.current ?? (running?.serverUrl ? consoleDestination(new URL(running.serverUrl).origin, apiOrigin()) : null);
      if (!previous) throw new Error('No previous server connection');
      destination = previous;
    } else if (command === 'connect' || command === 'join' || command === 'joinurl') {
      if (args.length !== 1) throw new Error(`Usage: ${command} "lobby code, friend link, or server origin"`);
      destination = consoleDestination(args[0]!, apiOrigin());
    } else throw new Error(`Unknown game command: ${command}`);
    leaveGame();
    const abort = new AbortController(); request.current = abort;
    try {
      if (destination.kind === 'lobby') {
        const state = await apiRequest<LobbyLookup>(destination.origin, `/api/lobbies/${destination.code}`, abort.signal);
        if (abort.signal.aborted) return;
        setHosting(!!destination.hostToken); setLobby(state); setScreen('lobby');
        attachLobby(state.wsUrl, destination.hostToken);
      } else {
        const match = await apiRequest<JoinedMatch>(destination.origin, '/api/quickplay', abort.signal, { nickname: settings.nickname });
        if (abort.signal.aborted) return;
        lastConnection.current = destination;
        setJoined(match); setRoundMap(match.map); setGameSettings(settings);
        setRunning({ map: match.map, sandbox: { ...DEFAULT_SANDBOX, mode: match.mode }, serverUrl: match.wsUrl });
        setScreen('menu');
      }
    } catch (reason) {
      if (!abort.signal.aborted) { setError(errorText(reason)); throw reason; }
    }
  };
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
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (screen === 'settings' && (
        panel.current?.querySelector('[data-binding-capture="true"]') ||
        (target instanceof HTMLInputElement && target.readOnly) ||
        (event.key !== 'Escape' && target?.closest('[role="tablist"]'))
      )) return;
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
  const setup = <div className="config"><Row number={1} disabled={screen === 'lobby' && (!hosting || !lobby || lobby.started)} onClick={changeMode}><span>Game type</span><strong>{MODE_LABELS[mode]}</strong></Row><Row number={2} disabled={screen === 'lobby' && (!hosting || !lobby || lobby.started)} onClick={openMaps}><span>Map</span><strong>{screen === 'lobby' ? lobby?.map ?? map : map}</strong></Row></div>;
  const rulesPanel = <RuleRows rules={screen === 'lobby' ? lobby?.rules ?? sandboxRules(sandbox) : sandboxRules(sandbox)} apply={rules => { if (screen === 'lobby') lobbySocket.current?.send({ type: 'lobby-update', rules }); else setSandbox(value => ({ ...value, ...rules })); }} maps={setupMaps} rotation={screen === 'lobby' ? lobby?.mapRotation ?? [] : sandbox.mapRotation} setRotation={mapRotation => { if (screen === 'lobby') { const current = mapRotation.includes(lobby!.map) ? lobby!.map : mapRotation[0] ?? lobby!.map; lobbySocket.current?.send({ type: 'lobby-update', map: current, mapRotation: mapRotation.length ? mapRotation : [current] }); } else setSandbox(value => ({ ...value, mapRotation })); }} disabled={screen === 'lobby' && (!hosting || !lobby || lobby.started)} />;
  let content: ReactNode;
  if (screen === 'boot') content = <><div className="progress" role="progressbar" aria-label="Loading assets" aria-valuemin={0} aria-valuemax={progress.totalFiles || 1} aria-valuenow={progress.files}><span style={{ width: `${progress.totalFiles ? 100 * progress.files / progress.totalFiles : 0}%` }} /></div><p className="load-file" role="status">{progress.label}<br /><small>{progress.files} / {progress.totalFiles || '…'} files · {(progress.bytes / 1048576).toFixed(1)}{progress.totalBytes ? ` / ${(progress.totalBytes / 1048576).toFixed(1)}` : ''} MB</small></p>{error && <button className="action" onClick={() => { setError(''); setBootAttempt(value => value + 1); }}>Retry</button>}</>;
  else if (screen === 'name') content = <><h2>Your name</h2><form onSubmit={event => { event.preventDefault(); if (!validNickname(name)) { setError('Use 1–24 letters, numbers or symbols.'); return; } updateSettings({ ...settings, nickname: name }); navigate(joinInput ? 'join' : 'menu'); }}><div className="field"><input autoFocus aria-label="Player name" aria-describedby="shell-error" autoComplete="nickname" spellCheck={false} maxLength={24} placeholder="Type your name" value={name} onChange={event => { setName(event.target.value); setError(''); }} /></div><button className="action primary" type="submit">Continue [Enter]</button></form></>;
  else if (screen === 'menu') content = <nav className="menu" aria-label="Main menu">{MAIN.map((item, i) => <Row key={item.screen} number={i + 1} selected={selected === i} onHighlight={() => setSelected(i)} onClick={() => { if (item.screen === 'lobby') void createLobby(); else navigate(item.screen); }}><span>{item.label}</span>{selected === i && <span className="menu-enter" aria-hidden="true">Enter</span>}</Row>)}</nav>;
  else if (screen === 'quickplay') content = <><h2>Finding a game</h2><div className="region-results"><table className="regions"><tbody>{regions.map(region => <tr key={region.id} className={'region' in search && search.region === region.id ? 'chosen' : ''}><td>{region.name}</td><td>{region.rtt === null ? 'Unavailable' : `${region.rtt} ms`}</td></tr>)}</tbody></table></div><div className="search-status" role="status">{search.phase === 'testing' ? <><i className="spinner" />Testing regions…</> : search.phase === 'countdown' ? <span className="countdown">Joining {regions.find(region => region.id === search.region)?.name} in <strong>{seconds}</strong>…</span> : 'Joining…'}</div><div className="actions"><button className="action" onClick={back}>Cancel [Esc]</button></div></>;
  else if (screen === 'joined' && joined) content = <><h2>{joined.map}</h2><p className="match-label">{MODE_LABELS[joined.mode]}{regions.find(region => 'region' in search && region.id === search.region)?.rtt != null ? ` / ${regions.find(region => 'region' in search && region.id === search.region)?.rtt} ms` : ''}</p><MapPreview map={joined.map} /><Roster humans={joined.humans.map(nickname => ({ nickname }))} bots={joined.bots} me={settings.nickname} /><div className="actions"><button className="action primary" onClick={enterMatch}>Enter game [Enter]</button><button className="action" onClick={back}>Back</button></div></>;
  else if (screen === 'lobby') {
    const humans = lobby?.players.length ?? 0;
    const bots = Math.max(0, (lobby?.targetPlayers ?? 12) - humans);
    content = <>
      <h2>Friend game</h2>
      <p className="screen-intro">{hosting ? `You are hosting as ${settings.nickname}` : 'Play together in a private lobby'}</p>
      <div className="lobby-columns">
        <div className="lobby-config">
          {setup}<MapPreview map={lobby?.map ?? map} />{rulesPanel}
          <div className="lobby-code">
            <div><small>Lobby code</small><strong>{lobby?.code ?? (busy ? 'Creating…' : '')}</strong></div>
            {lobby && <button className="action" onClick={() => {
              const url = new URL('/', location.href); url.searchParams.set('lobby', lobby.code);
              void navigator.clipboard.writeText(url.href).then(() => setCopyLink('Link copied')).catch(() => setCopyLink(url.href));
            }}>Copy link</button>}
          </div>
          {copyLink && <p className="copy-link" role="status">{copyLink}</p>}
        </div>
        <div className="lobby-players">
          <div className="roster-heading"><h3>Players</h3><p className="lobby-total">{humans} {humans === 1 ? 'human' : 'humans'} + {bots} bots = {humans + bots} total</p></div>
          <Roster humans={lobby?.players.map(player => ({ ...player, ready: player.host || player.ready })) ?? []} bots={bots} me={settings.nickname} kick={lobbyCanKick(lobby, selfId) ? id => lobbySocket.current?.send({ type: 'lobby-kick', id }) : undefined} />
          <p className="host-note">Only the host can change setup or kick a friend.</p>
        </div>
      </div>
      <div className="actions">
        <button className="action primary" disabled={!lobby || lobby.started} onClick={primary}>{hosting ? 'Start [Enter]' : lobby?.players.find(player => player.id === selfId)?.ready ? 'Ready ✓ [Enter]' : 'Ready up [Enter]'}</button>
        <button className="action" onClick={back}>Leave</button>
      </div>
    </>;
  }
  else if (screen === 'maps') content = <><h2>Choose a map</h2><div className="map-picker"><div className="map-list" role="listbox" aria-label="Maps">{maps.map((item, i) => <button className="menu-row" type="button" key={item} data-menu-row role="option" aria-selected={item === mapHighlight} onPointerEnter={() => setMapHighlight(item)} onFocus={() => setMapHighlight(item)} onClick={() => chooseMap(item)}><span className="number">{i + 1}</span><span>{item}</span></button>)}</div><div><MapPreview map={mapHighlight} /><p className="map-name">{mapHighlight}</p>{index?.maps[mapHighlight] && !index.maps[mapHighlight].botCapable && <p className="small">bots need waypoints on this map</p>}</div></div><div className="actions"><button className="action" onClick={back}>Back [Esc]</button></div></>;
  else if (screen === 'join') content = <><h2>Join a friend game</h2><form onSubmit={event => { event.preventDefault(); void joinLobby(); }}><div className="field"><input autoFocus aria-label="Lobby link or code" autoComplete="off" spellCheck={false} placeholder="Link or code" value={joinInput} onChange={event => setJoinInput(event.target.value)} /></div><button className="action primary" type="submit" disabled={busy}>{busy ? 'Joining…' : 'Join [Enter]'}</button></form><div className="actions"><button className="action" onClick={back}>Back</button></div></>;
  else if (screen === 'practice') content = <>
    <h2>Practice vs bots</h2>
    <p className="screen-intro">Your match. Your pace. No game server required.</p>
    <div className="practice-layout">
      <div className="practice-config">
        {setup}
        <label className="menu-row config"><span className="number">3</span><span>Bots</span><input id="bot-count" aria-label="Bots" type="number" min={0} max={31} value={sandbox.bots} onChange={event => {
          const bots = Math.max(0, Math.min(31, Math.trunc(Number(event.target.value))));
          const compatible = index ? compatibleSandboxMaps(index, sandbox.mode, bots > 0) : [];
          setSandbox({ ...sandbox, bots, mapRotation: sandbox.mapRotation.filter(name => compatible.includes(name)) });
          if (!compatible.includes(map) && compatible[0]) setMap(compatible[0]);
        }} /></label>
        <label className="menu-row config"><span className="number">4</span><span>Difficulty</span><select id="bot-difficulty" aria-label="Difficulty" value={sandbox.botDifficulty} onChange={event => setSandbox({ ...sandbox, botDifficulty: Number(event.target.value) })}>{[[300, 'Stupid'], [200, 'Poor'], [100, 'Normal'], [50, 'Hard'], [10, 'Impossible']].map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        {teamCount(sandbox.mode) > 0 && <div className="practice-teams">
          <label className="settings-row"><span>Your team</span><select aria-label="Your team" value={sandbox.team} onChange={event => setSandbox({ ...sandbox, team: Number(event.target.value) })}>{['Alpha', 'Bravo', 'Charlie', 'Delta'].slice(0, teamCount(sandbox.mode)).map((name, index) => <option value={index + 1} key={name}>{name}</option>)}</select></label>
          <label className="settings-row"><span>Bot teams</span><select aria-label="Bot teams" value={sandbox.botTeam} onChange={event => setSandbox({ ...sandbox, botTeam: event.target.value as SandboxOptions['botTeam'] })}><option value="balanced">Balanced</option>{(['alpha', 'bravo', 'charlie', 'delta'] as const).slice(0, teamCount(sandbox.mode)).map(team => <option key={team} value={team}>All {team[0]!.toUpperCase() + team.slice(1)}</option>)}</select></label>
        </div>}
        {rulesPanel}
        {index?.maps[map]?.missing.filter(item => item.active).map((item, i) => <p className="asset-warning" key={i}>{item.requested}{item.fallback ? ` — fallback: ${item.fallback}` : ' — missing dependency'}</p>)}
      </div>
      <aside className="practice-preview"><MapPreview map={map} /><p className="map-name">{map}</p><p className="small">{MODE_LABELS[mode]}</p></aside>
    </div>
    <div className="actions"><button className="action primary" disabled={!setupMaps.includes(map)} onClick={startPractice}>Start practice [Enter]</button></div>
  </>;
  else if (screen === 'settings') content = <><h2>Settings</h2><p className="screen-intro">Controls take effect as you edit.</p><SettingsMenu settings={settings} apply={updateSettings} /></>;
  else if (screen === 'appearance') content = <><h2>Player appearance</h2><AppearanceRows appearance={settings.appearance} apply={appearance => updateSettings({ ...settings, appearance })} /><div className="actions"><button className="action primary" onClick={back}>Back [Esc]</button></div></>;
  else if (screen === 'credits') content = <>
    <h2>Credits</h2>
    <ul className="credit-list">
      <li>A port of the original OpenSoldat game logic, compiled to WebAssembly. Art and sound re-encoded for the web (lossless WebP, Opus).</li>
      <li>Original art: Michal Marcinkowski, Transhuman Design and the base-content contributors.</li>
      <li>Airpirates: Evil Ville. DesertWind: grand_diablo. ctf_Ash: chakapoko maker. ctf_Death remake: NuZZ.</li>
      <li>Play typeface: Play contributors, SIL Open Font License 1.1.</li>
      <li>Anton typeface: The Anton Project Authors, <a href="/fonts/Anton-OFL.txt" target="_blank" rel="noopener noreferrer">SIL Open Font License 1.1</a>.</li>
      <li>Barlow Condensed typeface: The Barlow Project Authors, <a href="/fonts/BarlowCondensed-OFL.txt" target="_blank" rel="noopener noreferrer">SIL Open Font License 1.1</a>.</li>
      <li>Art and captures: CC BY 4.0, cropped or tinted.</li>
    </ul>
    <nav className="menu license-links" aria-label="License documents">
      <a className="small" href="https://github.com/l3wi/soldat-web/tree/main/sim/opensoldat" target="_blank" rel="noopener noreferrer">Browser simulation source</a>
      {CONTENT_NOTICES.map(notice => <a className="small" key={notice.path} href={contentUrl(notice.path)} target="_blank" rel="noopener noreferrer">{notice.title}</a>)}
    </nav>
    <p className="small">Unofficial. Not affiliated with or endorsed by Michał Marcinkowski, Transhuman Design, or the OpenSoldat contributors.</p>
    <details><summary>Notices, licenses & source provenance</summary><CreditsPanel manifest={index} /></details>
    <div className="actions"><button className="action primary" onClick={back}>Back</button></div>
  </>;
  else if (screen === 'pause') content = <><h2>{roundMap || running?.map}</h2><nav className="menu" aria-label="Game menu"><Row number={1} onClick={() => navigate('menu')}><span>Resume</span></Row><Row number={2} onClick={() => { navigate('menu'); openGameWeapons(); }}><span>Weapons</span></Row><Row number={3} onClick={() => { navigate('menu'); setGamePaused(false); openGameTeams(); }}><span>Change team</span></Row><Row number={4} onClick={() => navigate('appearance')}><span>Player appearance</span></Row><Row number={5} onClick={() => navigate('settings')}><span>Settings</span></Row><Row number={6} onClick={leaveGame}><span>Leave game</span></Row></nav></>;
  const showShell = !running || screen !== 'menu';
  return <div className="poster-menu">
    {running ? <main className="play-shell"><GameSurface map={running.map} settings={gameSettings} sandbox={running.sandbox} serverUrl={running.serverUrl} onStatus={setGameStatus} onRoundChange={setRoundMap} onSettingsChange={updateSettings} onShellCommand={consoleShellCommand} />{gameStatus && /unavailable|stopped|error/i.test(gameStatus) && <p className="game-error" role="alert">{gameStatus}</p>}</main> : <div className={`attract-scene${settings.gameplayBackground ? '' : ' backdrop-off'}`} aria-hidden="true">{index && attractMap && visible && settings.gameplayBackground && <GameSurface key={`${attractMap}-${reduced}`} map={attractMap} settings={attractSettings} sandbox={ATTRACT_OPTIONS} mountOptions={ATTRACT_MOUNT} still={reduced} />}<div className="attract-shade" /></div>}
    {showShell && <main className={`stage ${screen} ${screen}-screen${running ? ' game-overlay' : ''}`}>
      <div className="shell">
        <header className="masthead">
          <h1 className="wordmark"><span className="wordmark-soldat">Soldat</span><span className="wordmark-online">Online</span></h1>
          {screen === 'menu' && <p className="callsign">Player: {settings.nickname}</p>}
          {['settings', 'practice', 'lobby'].includes(screen) && <button className="action nav-back" onClick={back}>{screen === 'lobby' ? 'Leave [Esc]' : 'Back [Esc]'}</button>}
        </header>
        <section className="panel" ref={panel} aria-label={screen}>{content}{error && <p id="shell-error" className="error" role="alert">{error}</p>}</section>
        <footer className="shell-footer">
          {screen === 'menu' ? <div><strong className="browser-tagline">Original gameplay ported to your browser</strong><p>Unofficial OpenSoldat adaptation</p></div> : <p>Unofficial OpenSoldat adaptation</p>}
          <p className="keyboard-guide">{screen === 'menu' || screen === 'maps' || screen === 'pause' ? '↑ ↓ Select · Enter Confirm' : 'Esc Back'}</p>
        </footer>
      </div>
    </main>}
  </div>;
}
