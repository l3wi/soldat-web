import { MAX_PACKET_BYTES } from '../index.ts';
import type { TransportChannel } from './types.ts';

export interface BackpressureOptions {
  /** Reliable bytes awaiting send, excluding the one packet in the socket. */
  maxReliableBytes?: number;
  /** Also bound overhead from many tiny reliable packets. */
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
 * Owns copies of enqueued packets. Reliable packets are FIFO and take priority
 * over the single replaceable snapshot. dequeue transfers ownership to its caller.
 * Adapters must close on BackpressureError: reliable traffic is never evicted.
 */
export class BackpressureQueue {
  private reliable: (Uint8Array | undefined)[] = [];
  private reliableHead = 0;
  private latest: Uint8Array | undefined;
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
  get reliablePackets(): number { return this.reliable.length - this.reliableHead; }
  get size(): number { return this.reliablePackets + (this.latest ? 1 : 0); }

  enqueue(channel: TransportChannel, packet: Uint8Array): void {
    if (channel === 'latestState') {
      this.latest = packet.slice();
      return;
    }
    if (channel !== 'reliableControl') throw new TypeError('Unknown transport channel');
    if (this.reliablePackets >= this.maxReliablePackets ||
        packet.byteLength > this.maxReliableBytes - this.bytes) {
      throw new BackpressureError('Reliable transport queue capacity exceeded');
    }
    this.reliable.push(packet.slice());
    this.bytes += packet.byteLength;
  }

  dequeue(): QueuedPacket | undefined {
    if (this.reliablePackets > 0) {
      const packet = this.reliable[this.reliableHead]!;
      this.reliable[this.reliableHead++] = undefined;
      this.bytes -= packet.byteLength;
      if (this.reliableHead === this.reliable.length) {
        this.reliable = [];
        this.reliableHead = 0;
      } else if (this.reliableHead >= 1024 && this.reliableHead * 2 >= this.reliable.length) {
        this.reliable = this.reliable.slice(this.reliableHead);
        this.reliableHead = 0;
      }
      return { channel: 'reliableControl', packet };
    }
    if (!this.latest) return undefined;
    const packet = this.latest;
    this.latest = undefined;
    return { channel: 'latestState', packet };
  }

  clear(): void {
    this.reliable = [];
    this.reliableHead = 0;
    this.bytes = 0;
    this.latest = undefined;
  }
}
