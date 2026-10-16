import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeMessage } from '@soldat-web/protocol';
import { LobbyConnection } from './shell-api';

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = 0;
  bufferedAmount = 0;
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  constructor(readonly url: string) { super(); FakeSocket.last = this; }
  send(packet: Uint8Array): void { this.sent.push(packet); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = FakeSocket.OPEN; this.dispatchEvent(new Event('open')); }
  serverClose(code: number, reason: string): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
}

function withFakeSocket(run: () => void): void {
  const saved = { WebSocket: globalThis.WebSocket, window: 'window' in globalThis ? globalThis.window : undefined };
  Object.assign(globalThis, { WebSocket: FakeSocket, window: globalThis });
  try { run(); } finally { Object.assign(globalThis, saved); }
}

test('leaving a lobby whose server already disconnected does not throw', () => {
  withFakeSocket(() => {
    const errors: string[] = [];
    const lobby = new LobbyConnection('wss://lobby.test/l/ABC123', 'Major', undefined, () => {}, message => errors.push(message));
    const socket = FakeSocket.last!;
    socket.open();
    socket.serverClose(1006, '');
    assert.deepEqual(errors, ['Lobby disconnected (1006): ']);
    assert.doesNotThrow(() => lobby.send({ type: 'lobby-ready', ready: true }));
    assert.doesNotThrow(() => lobby.close());
  });
});

test('leaving a live lobby still tells the server', () => {
  withFakeSocket(() => {
    const lobby = new LobbyConnection('wss://lobby.test/l/ABC123', 'Major', undefined, () => {}, () => {});
    const socket = FakeSocket.last!;
    socket.open();
    lobby.close();
    assert.deepEqual(socket.sent.map(packet => decodeMessage(packet).type), ['lobby-join', 'lobby-leave']);
  });
});
