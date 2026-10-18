import type { LobbyState } from '@soldat-web/protocol';

export type MenuKey = { type: 'select'; index: number } | { type: 'activate'; index: number } | { type: 'back' } | null;

/** Number keys activate directly; arrows wrap without activating. Editing retains native keys. */
export function menuKey(key: string, selected: number, count: number, editing = false): MenuKey {
  if (key === 'Escape') return { type: 'back' };
  if (editing) return null;
  if (key === 'Backspace') return { type: 'back' };
  if (count < 1) return null;
  if (/^[1-9]$/.test(key) && Number(key) <= count) return { type: 'activate', index: Number(key) - 1 };
  if (key === 'ArrowDown' || key === 'ArrowUp') return { type: 'select', index: (selected + (key === 'ArrowDown' ? 1 : count - 1)) % count };
  if (key === 'Enter' || key === ' ') return { type: 'activate', index: selected };
  return null;
}

export function lobbyCode(value: string): string | null {
  let code = value.trim();
  if (!/^[0-9A-HJKMNP-TV-Z]{8}$/i.test(code)) {
    try { code = new URL(code, 'https://lobby.invalid/').searchParams.get('lobby') ?? ''; }
    catch { return null; }
  }
  return /^[0-9A-HJKMNP-TV-Z]{8}$/i.test(code) ? code.toUpperCase() : null;
}
export type ConsoleDestination =
  | { kind: 'lobby'; origin: string; code: string; hostToken?: string }
  | { kind: 'server'; origin: string };

/** Native IP/port/password and one-use match tickets are not browser admissions. */
export function consoleDestination(value: string, api: string): ConsoleDestination {
  const code = lobbyCode(value);
  if (code) return { kind: 'lobby', origin: api, code };
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Use a lobby code, friend link, or server origin'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a lobby code, friend link, or server origin, not a match ticket URL');
  }
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Unsupported server URL scheme');
  return { kind: 'server', origin: url.origin };
}


export function lobbyCanKick(lobby: LobbyState | null, selfId: string | undefined): boolean {
  return !!lobby && !lobby.started && lobby.players.some(player => player.id === selfId && player.host);
}

export type SearchState = { phase: 'testing' } | { phase: 'countdown'; region: string; deadline: number } | { phase: 'joining'; region: string } | { phase: 'cancelled' };
export type SearchEvent = { type: 'tested'; region: string; now: number } | { type: 'tick'; now: number } | { type: 'cancel' };
export function searchTransition(state: SearchState, event: SearchEvent): SearchState {
  if (event.type === 'cancel') return { phase: 'cancelled' };
  if (state.phase === 'testing' && event.type === 'tested') return { phase: 'countdown', region: event.region, deadline: event.now + 3000 };
  if (state.phase === 'countdown' && event.type === 'tick' && event.now >= state.deadline) return { phase: 'joining', region: state.region };
  return state;
}
export function countdownSeconds(state: SearchState, now: number): number {
  return state.phase === 'countdown' ? Math.max(0, Math.ceil((state.deadline - now) / 1000)) : 0;
}
