import WebSocket from 'ws';
import type { RawData } from 'ws';
import { MAX_PACKET_BYTES, ProtocolError, readChannel } from '@soldat-web/protocol';
import { BackpressureError, BackpressureQueue } from '@soldat-web/protocol/transport';
import type { MessageTransport, TransportChannel } from '@soldat-web/protocol/transport';

/**
 * Adapts an already-open ws socket. The WebSocketServer must also configure
 * maxPayload: MAX_PACKET_BYTES, perMessageDeflate: false, to bound receive-time
 * allocation. send copies caller bytes, retaining at most one write in flight,
 * a bounded reliable FIFO and the newest unsent snapshot. Socket listeners and
 * retry timers are removed on close; this adapter exclusively owns the socket.
 */
export function createNodeTransport(socket: WebSocket): MessageTransport {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket must be open');
  socket.binaryType = 'arraybuffer';
  const queue = new BackpressureQueue();
  let stopped = false;
  let inFlight = false;
  let flushing = false;
  let timer: NodeJS.Timeout | undefined;

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
      socket.close(code, reason);
      stop();
    },
  };

  function stop(): void {
    stopped = true;
    queue.clear();
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
      socket.close(code, 'Transport failure');
    } finally {
      transport.onError?.(error);
    }
  }

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || flushing || inFlight || socket.readyState !== WebSocket.OPEN) return;
    flushing = true;
    try {
      while (!stopped && !inFlight && queue.size > 0 && socket.bufferedAmount === 0) {
        const next = queue.dequeue()!;
        inFlight = true;
        socket.send(next.packet, { binary: true, compress: false }, (error?: Error) => {
          inFlight = false;
          if (stopped) return;
          if (error) fail(error);
          else flush();
        });
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

  function receive(data: RawData, isBinary: boolean): void {
    if (stopped) return;
    let packet: Uint8Array;
    let channel: TransportChannel;
    try {
      if (!isBinary) throw new ProtocolError('TRANSPORT', 'Only binary messages are accepted');
      const length = Array.isArray(data)
        ? data.reduce((total, fragment) => total + fragment.byteLength, 0)
        : data.byteLength;
      if (length > MAX_PACKET_BYTES) {
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
