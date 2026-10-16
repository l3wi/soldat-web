import { isIP } from "node:net";

export const HARDENING_DEFAULTS = {
  maxHostedLobbiesPerIp: 2, maxPrivateMatchesPerIp: 2, maxQuickplayReservationsPerIp: 4,
  lobbyExpiryMs: 1_800_000, afkMs: 300_000, lobbyBufferedBytes: 262_144,
  maxPendingUpgrades: 256, maxWebSocketsPerIp: 16, maxConnectionsPerIp: 32,
  outboundQueueBytes: 4_194_304, replayTicksPerSecond: 60,
  controlBurst: 60, controlPerSecond: 30, failedLookupsPerMinute: 10,
  globalFailedLookupsPerSecond: 100, globalCreationsPerSecond: 20,
} as const;
export type HardeningOptions = { [K in keyof typeof HARDENING_DEFAULTS]?: number };
export type HardeningLimits = { -readonly [K in keyof typeof HARDENING_DEFAULTS]: number };
export function hardeningLimits(options: HardeningOptions | Record<string, unknown>): HardeningLimits {
  const limits = { ...HARDENING_DEFAULTS } as HardeningLimits;
  for (const key of Object.keys(limits) as (keyof HardeningLimits)[]) {
    const value = options[key] === undefined ? limits[key] : options[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) throw new Error(`Invalid ${key}`);
    limits[key] = value;
  }
  return limits;
}

/** Direct socket identity; IPv4-mapped addresses share the IPv4 quota. */
export function sourceIp(address: string | undefined): string {
  if (!address) return "unknown";
  address = address.toLowerCase().split("%")[0]!;
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7);
  if (isIP(address) !== 6) return address;
  // Let node canonicalize embedded IPv4 and compressed IPv6 before grouping /64.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const halves = canonical.split("::"), left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  if (words.slice(0, 5).every(word => parseInt(word, 16) === 0) && words[5] === "ffff") {
    const high = parseInt(words[6]!, 16), low = parseInt(words[7]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return `${words.slice(0, 4).map(word => parseInt(word, 16).toString(16)).join(":")}::/64`;
}

export class TokenBucket {
  private tokens: number;
  private at: number;
  readonly capacity: number;
  readonly perSecond: number;
  constructor(capacity: number, perSecond: number, now = Date.now()) {
    this.capacity = capacity; this.perSecond = perSecond; this.tokens = capacity; this.at = now;
  }
  available(amount = 1, now = Date.now()): boolean {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.at) * this.perSecond / 1000);
    this.at = now;
    return amount <= this.tokens;
  }
  take(amount = 1, now = Date.now()): boolean {
    if (!this.available(amount, now)) return false;
    this.tokens -= amount; return true;
  }
}

/** Bounded LRU: activity refreshes order; new identities evict the stalest entry. */
export class BucketTable {
  private readonly entries = new Map<string, { bucket: TokenBucket; at: number }>();
  readonly capacity: number;
  readonly burst: number;
  readonly perSecond: number;
  constructor(capacity: number, burst: number, perSecond: number) {
    this.capacity = capacity; this.burst = burst; this.perSecond = perSecond;
  }
  take(key: string, now = Date.now()): boolean {
    let entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry) {
      if (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
      entry = { bucket: new TokenBucket(this.burst, this.perSecond, now), at: now };
    }
    entry.at = now; this.entries.set(key, entry);
    return entry.bucket.take(1, now);
  }
  available(key: string, now = Date.now()): boolean { return this.entries.get(key)?.bucket.available(1, now) ?? true; }
  prune(now: number): void { for (const [key, entry] of this.entries) if (now - entry.at > 120_000) this.entries.delete(key); }
}

/** One instance shared by every lobby/match WSS on an HTTPS listener. */
export class ConnectionAdmission {
  private readonly counts = new Map<string, number>();
  private pending = 0;
  private readonly limits: HardeningLimits;
  constructor(limits: HardeningLimits) { this.limits = limits; }
  acquire(address: string): { joined(): void; release(): void } | undefined {
    const count = this.counts.get(address) ?? 0;
    if (count >= this.limits.maxWebSocketsPerIp || this.pending >= this.limits.maxPendingUpgrades) return;
    this.counts.set(address, count + 1); this.pending++;
    let pending = true, released = false;
    const joined = () => { if (pending) { pending = false; this.pending--; } };
    return { joined, release: () => {
      if (released) return; released = true; joined();
      const next = this.counts.get(address)! - 1;
      if (next) this.counts.set(address, next); else this.counts.delete(address);
    } };
  }
}
