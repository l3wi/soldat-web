import { describe, expect, test } from 'bun:test';
import { BackpressureError, BackpressureQueue } from './backpressure.ts';

describe('two-channel backpressure queue', () => {
  test('state and ticks retain FIFO order with controls without replacement', () => {
    const queue = new BackpressureQueue();
    queue.enqueue('reliableControl', new Uint8Array([1]));
    queue.enqueue('latestState', new Uint8Array([2]));
    queue.enqueue('reliableControl', new Uint8Array([3]));
    queue.enqueue('latestState', new Uint8Array([4]));
    expect(queue.size).toBe(4);
    expect(queue.dequeue()).toEqual({ channel: 'reliableControl', packet: new Uint8Array([1]) });
    expect(queue.dequeue()).toEqual({ channel: 'latestState', packet: new Uint8Array([2]) });
    expect(queue.dequeue()).toEqual({ channel: 'reliableControl', packet: new Uint8Array([3]) });
    expect(queue.dequeue()).toEqual({ channel: 'latestState', packet: new Uint8Array([4]) });
    expect(queue.dequeue()).toBeUndefined();
    expect(queue.reliableBytes).toBe(0);
  });

  test('copies caller-owned subarrays for both channels', () => {
    const queue = new BackpressureQueue();
    const source = new Uint8Array([0, 1, 2, 3]);
    queue.enqueue('reliableControl', source.subarray(1, 2));
    queue.enqueue('latestState', source.subarray(2, 3));
    source.fill(9);
    expect(queue.dequeue()!.packet).toEqual(new Uint8Array([1]));
    expect(queue.dequeue()!.packet).toEqual(new Uint8Array([2]));
  });

  test('combined byte overflow never evicts controls, states or tick records', () => {
    const queue = new BackpressureQueue({ maxReliableBytes: 3 });
    queue.enqueue('reliableControl', new Uint8Array([1, 2]));
    expect(() => queue.enqueue('latestState', new Uint8Array([3, 4]))).toThrow(BackpressureError);
    expect(queue.reliableBytes).toBe(2);
    queue.enqueue('latestState', new Uint8Array([3]));
    expect(queue.dequeue()!.packet).toEqual(new Uint8Array([1, 2]));
    expect(queue.dequeue()!.packet).toEqual(new Uint8Array([3]));
  });

  test('combined packet count bounds both channels independently of bytes', () => {
    const queue = new BackpressureQueue({ maxReliablePackets: 2 });
    queue.enqueue('reliableControl', new Uint8Array([1]));
    queue.enqueue('latestState', new Uint8Array([2]));
    expect(() => queue.enqueue('latestState', new Uint8Array([3]))).toThrow(BackpressureError);
    expect(() => queue.enqueue('reliableControl', new Uint8Array([3]))).toThrow(BackpressureError);
    expect(queue.reliablePackets).toBe(2);
  });

  test('clear releases all channels and capacity for close cleanup', () => {
    const queue = new BackpressureQueue({ maxReliableBytes: 2, maxReliablePackets: 2 });
    queue.enqueue('reliableControl', new Uint8Array([1]));
    queue.enqueue('latestState', new Uint8Array([2]));
    queue.clear();
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.reliableBytes).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
    queue.enqueue('reliableControl', new Uint8Array([3]));
    expect(queue.dequeue()!.packet).toEqual(new Uint8Array([3]));
  });

  test('a continuously nonempty queue preserves order across storage compaction', () => {
    const queue = new BackpressureQueue({ maxReliablePackets: 2 });
    queue.enqueue('reliableControl', new Uint8Array([0]));
    for (let i = 1; i < 4096; i++) {
      const channel = i % 2 ? 'latestState' : 'reliableControl';
      queue.enqueue(channel, new Uint8Array([i % 256]));
      const next = queue.dequeue()!;
      expect(next.packet[0]).toBe((i - 1) % 256);
      expect(next.channel).toBe(i % 2 ? 'reliableControl' : 'latestState');
      expect(queue.reliablePackets).toBe(1);
      expect(queue.reliableBytes).toBe(1);
    }
    expect(queue.dequeue()!.packet[0]).toBe(255);
  });

  test('invalid limits are rejected', () => {
    for (const limit of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => new BackpressureQueue({ maxReliableBytes: limit })).toThrow(RangeError);
      expect(() => new BackpressureQueue({ maxReliablePackets: limit })).toThrow(RangeError);
    }
  });
});
