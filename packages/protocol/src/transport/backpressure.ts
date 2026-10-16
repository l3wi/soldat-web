import { MAX_PACKET_BYTES } from '../index.ts';
import type { TransportChannel } from './types.ts';

export interface BackpressureOptions {
  /** Bytes awaiting send across both reliable WSS channels, excluding the socket. */
  maxReliableBytes?: number;
  /** Also bound overhead from many tiny packets across both channels. */
  maxReliablePackets?: number;
}

export interface QueuedPacket {
  channel: TransportChannel;
  packet: Uint8Array;
}

export class BackpressureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackpressureError';
  }
}

/**
 * Owns copies of enqueued packets in one FIFO across both channels.
 * dequeue transfers ownership to its caller. Adapters must close on overflow:
 * neither state nor tick records can be replaced or reordered with controls.
 */
export class BackpressureQueue {
  private packets: (QueuedPacket | undefined)[] = [];
  private head = 0;
  private bytes = 0;
  readonly maxReliableBytes: number;
  readonly maxReliablePackets: number;

  constructor(options: BackpressureOptions = {}) {
    this.maxReliableBytes = options.maxReliableBytes ?? MAX_PACKET_BYTES;
    this.maxReliablePackets = options.maxReliablePackets ?? 1024;
    for (const limit of [this.maxReliableBytes, this.maxReliablePackets]) {
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new RangeError('Backpressure limits must be positive safe integers');
      }
    }
  }

  get reliableBytes(): number { return this.bytes; }
  get reliablePackets(): number { return this.packets.length - this.head; }
  get size(): number { return this.packets.length - this.head; }

  enqueue(channel: TransportChannel, packet: Uint8Array): void {
    if (channel !== 'latestState' && channel !== 'reliableControl') throw new TypeError('Unknown transport channel');
    if (this.reliablePackets >= this.maxReliablePackets ||
        packet.byteLength > this.maxReliableBytes - this.bytes) {
      throw new BackpressureError('Reliable transport queue capacity exceeded');
    }
    this.packets.push({ channel, packet: packet.slice() });
    this.bytes += packet.byteLength;
  }

  dequeue(): QueuedPacket | undefined {
    if (this.size === 0) return undefined;
    const next = this.packets[this.head]!;
    this.packets[this.head++] = undefined;
    this.bytes -= next.packet.byteLength;
    if (this.head === this.packets.length) {
      this.packets = [];
      this.head = 0;
    } else if (this.head >= 1024 && this.head * 2 >= this.packets.length) {
      this.packets = this.packets.slice(this.head);
      this.head = 0;
    }
    return next;
  }

  clear(): void {
    this.packets = [];
    this.head = 0;
    this.bytes = 0;
  }
}
