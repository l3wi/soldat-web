export type TransportChannel = 'reliableControl' | 'latestState';

/**
 * Each send copies the packet before returning, so the caller may immediately
 * reuse its buffer. Received packets are owned by the callback and may be kept
 * or mutated. Only snapshots may use latestState; all other messages are reliable.
 *
 * latestState replaces only the unsent snapshot. Bytes already handed to WSS
 * cannot be retracted. Queue overflow is an explicit error and connection close.
 */
export interface MessageTransport {
  send(channel: TransportChannel, packet: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onMessage: ((channel: TransportChannel, packet: Uint8Array) => void) | undefined;
  onClose: ((code: number, reason: string) => void) | undefined;
  onError: ((error: Error) => void) | undefined;
}
