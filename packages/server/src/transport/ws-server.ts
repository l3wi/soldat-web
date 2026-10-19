import WebSocket from 'ws';
import type { RawData } from 'ws';
import { MAX_PACKET_BYTES, MAX_CLIENT_PACKET_BYTES, ProtocolError, readChannel } from '@soldat-web/protocol';
import { BackpressureError, BackpressureQueue } from '@soldat-web/protocol/transport';
import type { MessageTransport, TransportChannel } from '@soldat-web/protocol/transport';

export interface NodeTransportObserver {
  /** Enqueue to socket.send invocation, not socket completion or remote ACK. */
  handoff(residenceMs: number): void;
  /** Instantaneous gauges; ages are zero when the corresponding queue is empty. */
  queueState(queuedPackets: number, queuedBytes: number, inFlightBytes: number, socketBufferedBytes: number, oldestQueuedAgeMs: number, inFlightAgeMs: number): void;
}

export interface NodeMessageTransport extends MessageTransport {
  /** Samples even a still-stalled queue without sending or changing its order. */
  sampleQueue(): void;
}

/**
 * Adapts an already-open ws socket. The WebSocketServer must also configure
 * maxPayload: MAX_CLIENT_PACKET_BYTES, perMessageDeflate: false, to bound receive-time
 * allocation. send copies caller bytes, retaining at most one write in flight,
 * a bounded cross-channel FIFO without replacing timeline records. Socket listeners and
 * retry timers are removed on close; this adapter exclusively owns the socket.
 */
export function createNodeTransport(socket: WebSocket, maxOutboundBytes = 4_194_304, observation?: { observer: NodeTransportObserver; nowMs?: () => number }): NodeMessageTransport {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket must be open');
  socket.binaryType = 'arraybuffer';
  const queue = new BackpressureQueue({ maxReliableBytes: maxOutboundBytes });
  let stopped = false;
  let inFlight = false;
  let flushing = false;
  let inFlightBytes = 0;
  let timer: NodeJS.Timeout | undefined;
  const nowMs = observation?.nowMs ?? performance.now.bind(performance);
  // Parallel numeric ring follows the existing FIFO; it never retains packets.
  const enqueuedAt = observation ? new Float64Array(queue.maxReliablePackets) : undefined;
  let timestampHead = 0, timestampTail = 0;
  let inFlightAt = 0;

  const transport: NodeMessageTransport = {
    onMessage: undefined,
    onClose: undefined,
    onError: undefined,
    sampleQueue: observe,
    send(channel: TransportChannel, packet: Uint8Array): void {
      if (stopped) throw new Error('Transport is closed');
      try {
        if (packet.byteLength > MAX_PACKET_BYTES) {
          throw new ProtocolError('OVERSIZED', 'Outgoing packet exceeds wire limit');
        }
        if (readChannel(packet) !== channel) {
          throw new ProtocolError('CHANNEL', 'Packet header and send channel differ');
        }
        if (Math.max(socket.bufferedAmount, inFlightBytes) + queue.reliableBytes + packet.byteLength > maxOutboundBytes) throw new BackpressureError('Slow peer exceeds outbound byte limit');
        queue.enqueue(channel, packet);
        if (enqueuedAt) { enqueuedAt[timestampTail] = nowMs(); timestampTail = (timestampTail + 1) % enqueuedAt.length; }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      observe();
      flush();
    },
    close(code = 1000, reason = ''): void {
      if (stopped) return;
      socket.close(code, reason);
      stop();
    },
  };

  function observe(): void {
    if (!observation) return;
    const now = nowMs();
    try {
      observation.observer.queueState(queue.size, queue.reliableBytes, inFlightBytes, socket.bufferedAmount,
        queue.size && enqueuedAt ? Math.max(0, now - enqueuedAt[timestampHead]!) : 0,
        inFlight ? Math.max(0, now - inFlightAt) : 0);
    } catch { /* Diagnostics must not change delivery or socket ownership. */ }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    queue.clear();
    timestampHead = timestampTail = 0;
    inFlight = false;
    inFlightBytes = 0;
    inFlightAt = 0;
    observe();
    clearTimeout(timer);
    timer = undefined;
    socket.off('message', receive);
  }

  function fail(error: Error): void {
    if (stopped) return;
    const code = error instanceof BackpressureError ? 1013 :
      error instanceof ProtocolError ? (error.code === 'OVERSIZED' ? 1009 : 1002) : 1011;
    stop();
    try {
      if (error instanceof BackpressureError) socket.terminate();
      else socket.close(code, 'Transport failure');
    } finally {
      transport.onError?.(error);
    }
  }

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || flushing || inFlight || socket.readyState !== WebSocket.OPEN) return;
    flushing = true;
    if (Math.max(socket.bufferedAmount, inFlightBytes) + queue.reliableBytes > maxOutboundBytes) { fail(new BackpressureError('Slow peer exceeds outbound byte limit')); flushing = false; return; }
    try {
      while (!stopped && !inFlight && queue.size > 0 && socket.bufferedAmount === 0) {
        const next = queue.dequeue()!;
        const handedAt = nowMs();
        const residenceMs = enqueuedAt ? Math.max(0, handedAt - enqueuedAt[timestampHead]!) : 0;
        if (enqueuedAt) timestampHead = (timestampHead + 1) % enqueuedAt.length;
        inFlight = true;
        inFlightBytes = next.packet.byteLength;
        inFlightAt = handedAt;
        socket.send(next.packet, { binary: true, compress: false }, sent);
        if (observation) {
          try { observation.observer.handoff(residenceMs); } catch { /* Observation cannot reject an accepted write. */ }
        }
        observe();
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    } finally {
      flushing = false;
    }
    if (!stopped && !inFlight && queue.size > 0) {
      timer = setTimeout(flush, 10);
      timer.unref();
    }
  }

  function sent(error?: Error): void {
    if (stopped) return;
    inFlight = false;
    inFlightBytes = 0;
    inFlightAt = 0;
    observe();
    if (error) fail(error);
    else flush();
  }

  function receive(data: RawData, isBinary: boolean): void {
    if (stopped) return;
    let packet: Uint8Array;
    let channel: TransportChannel;
    try {
      if (!isBinary) throw new ProtocolError('TRANSPORT', 'Only binary messages are accepted');
      const length = Array.isArray(data)
        ? data.reduce((total, fragment) => total + fragment.byteLength, 0)
        : data.byteLength;
      if (length > MAX_CLIENT_PACKET_BYTES) {
        throw new ProtocolError('OVERSIZED', 'Incoming packet exceeds wire limit');
      }
      if (Array.isArray(data)) {
        packet = new Uint8Array(length);
        let offset = 0;
        for (const fragment of data) {
          packet.set(fragment, offset);
          offset += fragment.byteLength;
        }
      } else {
        // ArrayBuffer belongs to this message. Copy Buffer views because ws can
        // deliver them as slices of a larger allocation shared with other data.
        packet = data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
      }
      channel = readChannel(packet);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    transport.onMessage?.(channel, packet);
  }

  function closed(code: number, reason: Buffer): void {
    stop();
    socket.off('close', closed);
    socket.off('error', errored);
    transport.onClose?.(code, reason.toString('utf8'));
  }

  function errored(error: Error): void {
    // ws enforces maxPayload before delivering a message. Preserve the same
    // typed size failure as the post-delivery guard, rather than reporting it
    // as an unrelated socket error.
    if ('code' in error && error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
      fail(new ProtocolError('OVERSIZED', error.message, 0, { cause: error }));
    } else {
      fail(error);
    }
  }

  socket.on('message', receive);
  socket.on('close', closed);
  socket.on('error', errored);
  return transport;
}
