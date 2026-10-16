import { MAX_PACKET_BYTES, ProtocolError, readChannel } from '../index.ts';
import { BackpressureError, BackpressureQueue } from './backpressure.ts';
import type { BackpressureOptions } from './backpressure.ts';
import type { MessageTransport, TransportChannel } from './types.ts';

/** Queue limits apply while connecting too. Native WSS has no drain event. */
export interface WssClientOptions extends BackpressureOptions {
  flushIntervalMs?: number;
}

/**
 * Opens native browser WSS, returning immediately so handlers can be installed
 * before open. send owns a copy, including when the socket is not open yet.
 * At most one non-drained packet is handed to the socket; all pending packets
 * retain cross-channel FIFO order. Fatal browser closes use 4002 (protocol),
 * 4009 (size), 4013 (backpressure), or 4011 (socket failure).
 */
export function connectWss(url: string | URL, options: WssClientOptions = {}): MessageTransport {
  const address = new URL(url);
  if (address.protocol !== 'wss:') throw new TypeError('Game transport requires a wss: URL');
  const queue = new BackpressureQueue(options);
  const interval = options.flushIntervalMs ?? 10;
  if (!Number.isFinite(interval) || interval < 1) throw new RangeError('Invalid flush interval');
  const socket = new WebSocket(address.href);
  socket.binaryType = 'arraybuffer';
  let stopped = false;
  let timer: number | undefined;

  const transport: MessageTransport = {
    onMessage: undefined,
    onClose: undefined,
    onError: undefined,
    send(channel: TransportChannel, packet: Uint8Array): void {
      if (stopped) throw new Error('Transport is closed');
      try {
        if (packet.byteLength > MAX_PACKET_BYTES) {
          throw new ProtocolError('OVERSIZED', 'Outgoing packet exceeds wire limit');
        }
        if (readChannel(packet) !== channel) {
          throw new ProtocolError('CHANNEL', 'Packet header and send channel differ');
        }
        queue.enqueue(channel, packet);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      flush();
    },
    close(code = 1000, reason = ''): void {
      if (stopped) return;
      // Let native close validate user-supplied code/reason before stopping.
      socket.close(code, reason);
      stop();
    },
  };

  function stop(): void {
    stopped = true;
    queue.clear();
    clearTimeout(timer);
    timer = undefined;
    socket.removeEventListener('open', flush);
    socket.removeEventListener('message', receive);
  }

  function fail(error: Error): void {
    if (stopped) return;
    const code = error instanceof BackpressureError ? 4013 :
      error instanceof ProtocolError ? (error.code === 'OVERSIZED' ? 4009 : 4002) : 4011;
    stop();
    try {
      socket.close(code, 'Transport failure');
    } finally {
      transport.onError?.(error);
    }
  }

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || socket.readyState !== WebSocket.OPEN) return;
    while (queue.size > 0 && socket.bufferedAmount === 0) {
      const next = queue.dequeue()!;
      try {
        socket.send(next.packet);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    if (queue.size > 0) timer = window.setTimeout(flush, interval);
  }

  function receive(event: MessageEvent): void {
    if (stopped) return;
    let packet: Uint8Array;
    let channel: TransportChannel;
    try {
      if (!(event.data instanceof ArrayBuffer)) {
        throw new ProtocolError('TRANSPORT', 'Only binary ArrayBuffer messages are accepted');
      }
      if (event.data.byteLength > MAX_PACKET_BYTES) {
        throw new ProtocolError('OVERSIZED', 'Incoming packet exceeds wire limit');
      }
      packet = new Uint8Array(event.data);
      channel = readChannel(packet);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    transport.onMessage?.(channel, packet);
  }

  function closed(event: CloseEvent): void {
    stop();
    socket.removeEventListener('close', closed);
    socket.removeEventListener('error', errored);
    transport.onClose?.(event.code, event.reason);
  }

  function errored(): void {
    fail(new Error('WebSocket connection failed'));
  }

  socket.addEventListener('open', flush);
  socket.addEventListener('message', receive);
  socket.addEventListener('close', closed);
  socket.addEventListener('error', errored);
  return transport;
}
