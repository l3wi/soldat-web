import { decodeMessage, encodeMessage, type LobbyState, type Message } from '@soldat-web/protocol';
import { connectWss, type MessageTransport } from '@soldat-web/protocol/transport';

export type { LobbyState, LobbyPlayer, Region } from '@soldat-web/protocol';
export interface JoinedMatch { matchId: string; wsUrl: string; map: string; mode: 'dm' | 'ctf'; humans: string[]; bots: number }

export function apiOrigin(): string {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  const endpoint = configured || new URLSearchParams(location.search).get('server') || location.origin;
  const url = new URL(endpoint, location.origin);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol === 'ws:') url.protocol = 'http:';
  return url.origin;
}
export async function apiRequest<T>(origin: string, path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(new URL(path, origin), { signal, cache: 'no-store', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  if (!response.ok) {
    let detail = '';
    try { const value = await response.json(); if (typeof value.error === 'string') detail = `: ${value.error}`; } catch { /* Non-JSON HTTP failures retain their status. */ }
    throw new Error(`Server returned ${response.status}${detail}`);
  }
  return response.json() as Promise<T>;
}

/** Owns only the reliable lobby socket; the game opens its separate match session after Start. */
export class LobbyConnection {
  private readonly transport: MessageTransport;
  private closed = false;
  /** Cleared when the socket fails or the server closes it; the transport then rejects sends. */
  private live = true;
  /** `onError` reports recoverable lobby errors; `onClosed` reports that the lobby is gone for this client (kicked, host left, expired, network). */
  constructor(url: string, nickname: string, hostToken: string | undefined, onState: (state: LobbyState, selfId?: string) => void, onError: (message: string) => void, onClosed: (message: string) => void) {
    this.transport = connectWss(url);
    this.transport.onError = error => { this.live = false; if (!this.closed) onClosed(error.message); };
    this.transport.onClose = (code, reason) => { this.live = false; if (!this.closed) onClosed(reason || `Lobby disconnected (${code})`); };
    this.transport.onMessage = (_channel, packet) => {
      try {
        const message = decodeMessage(packet);
        if (message.type === 'lobby-state') onState(message.state, message.selfId);
        else if (message.type === 'lobby-error') onError(message.reason);
        else if (message.type === 'ping') this.send({ type: 'pong', timestamp: message.timestamp });
      } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    };
    this.send({ type: 'lobby-join', nickname, ...(hostToken ? { hostToken } : {}) });
  }
  /** Disconnection has already been reported through onClosed, so sends on a dead socket are dropped. */
  send(message: Message): void {
    if (!this.closed && this.live) this.transport.send('reliableControl', encodeMessage(message));
  }
  close(): void {
    if (this.closed) return;
    this.send({ type: 'lobby-leave' }); this.closed = true; this.transport.close();
  }
}
