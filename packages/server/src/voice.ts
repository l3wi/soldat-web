import { createHmac } from 'node:crypto';
import type { FeatureServerMessage, IceServerConfiguration, VoiceChannel, VoiceConfiguration, VoiceSignal, VoiceState } from '@soldat-web/protocol';

export interface VoiceParticipant {
  /** Admission nonce, never a reusable sprite slot. */
  id: string;
  slot: number;
  nickname: string;
  team: number;
  muted: boolean;
}
export interface VoiceOperatorConfiguration {
  iceServers?: IceServerConfiguration[];
  relayOnly?: boolean;
  turn?: { urls: string[]; secret: string; ttlSeconds?: number };
}
export interface VoiceRelayOptions {
  send(id: string, message: FeatureServerMessage): void;
  configuration?: VoiceOperatorConfiguration;
  now?: () => number;
}
interface Member {
  participant: VoiceParticipant;
  enabled: boolean;
  channel: VoiceChannel;
  transmitting: boolean;
  configuration: VoiceConfiguration;
  credentialsExpire: number;
  lastState: string;
  windowStart: number;
  signals: number;
}
const MAX_PEERS = 64;
export const MAX_VOICE_SDP = 32_768;
export const MAX_VOICE_CANDIDATE = 2_048;

function iceUrls(urls: unknown): asserts urls is string[] {
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 8 || urls.some(url =>
    typeof url !== 'string' || Buffer.byteLength(url, 'utf8') > 1024 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(url) ||
    !/^(stun|stuns|turn|turns):[^\s/@]+(?::\d+)?(?:\?transport=(?:udp|tcp))?$/i.test(url))) {
    throw new Error('Voice ICE URLs must be bounded stun:, stuns:, turn: or turns: URLs');
  }
}
export function validateVoiceConfiguration(configuration: VoiceOperatorConfiguration): void {
  const servers = configuration.iceServers ?? [];
  if (!Array.isArray(servers) || servers.length > 8) throw new Error('Voice accepts at most eight ICE servers');
  for (const server of servers) {
    iceUrls(server.urls);
    if ((server.username !== undefined && (typeof server.username !== 'string' || Buffer.byteLength(server.username, 'utf8') > 512 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(server.username))) ||
        (server.credential !== undefined && (typeof server.credential !== 'string' || Buffer.byteLength(server.credential, 'utf8') > 512 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(server.credential)))) {
      throw new Error('Invalid voice ICE credentials');
    }
  }
  if (configuration.turn) {
    iceUrls(configuration.turn.urls);
    if (configuration.turn.urls.some(url => !/^turns?:/i.test(url)) || !configuration.turn.secret || configuration.turn.secret.length > 4096) {
      throw new Error('Ephemeral voice TURN requires TURN URLs and a nonempty shared secret');
    }
    const ttl = configuration.turn.ttlSeconds ?? 3600;
    if (!Number.isInteger(ttl) || ttl < 600 || ttl > 86400) throw new Error('Voice TURN TTL must be 600..86400 seconds');
  }
  if (configuration.relayOnly && !configuration.turn && !servers.some(server => server.urls.some(url => /^turns?:/i.test(url)))) {
    throw new Error('Voice relay-only mode requires an operator-configured TURN server');
  }
}
/** No default third-party endpoints. TURN shared secrets never leave this module. */
export function voiceConfigurationFromEnv(env: NodeJS.ProcessEnv): VoiceOperatorConfiguration {
  const configuration: VoiceOperatorConfiguration = {};
  if (env.SOLDAT_VOICE_ICE_SERVERS) configuration.iceServers = JSON.parse(env.SOLDAT_VOICE_ICE_SERVERS) as IceServerConfiguration[];
  if (env.SOLDAT_VOICE_RELAY_ONLY !== undefined) {
    if (!['true', 'false', '1', '0'].includes(env.SOLDAT_VOICE_RELAY_ONLY)) throw new Error('SOLDAT_VOICE_RELAY_ONLY must be true/false or 1/0');
    configuration.relayOnly = ['true', '1'].includes(env.SOLDAT_VOICE_RELAY_ONLY);
  }
  if (env.SOLDAT_VOICE_TURN_SECRET || env.SOLDAT_VOICE_TURN_URL) {
    if (!env.SOLDAT_VOICE_TURN_SECRET || !env.SOLDAT_VOICE_TURN_URL) throw new Error('Voice TURN requires both SOLDAT_VOICE_TURN_SECRET and SOLDAT_VOICE_TURN_URL');
    configuration.turn = { urls: env.SOLDAT_VOICE_TURN_URL.split(',').map(url => url.trim()), secret: env.SOLDAT_VOICE_TURN_SECRET,
      ttlSeconds: env.SOLDAT_VOICE_TURN_TTL ? Number(env.SOLDAT_VOICE_TURN_TTL) : 3600 };
  }
  validateVoiceConfiguration(configuration);
  return configuration;
}

/** Directional sender policy; receiver opt-in and native mute are independent. */
export function voiceCanSend(sender: VoiceParticipant, channel: VoiceChannel, receiver: VoiceParticipant): boolean {
  return sender.id !== receiver.id && sender.team !== 5 && !sender.muted &&
    (channel === 'public' || (receiver.team !== 5 && sender.team === receiver.team));
}
export function validVoiceSignal(signal: unknown): signal is VoiceSignal {
  if (!signal || typeof signal !== 'object') return false;
  const value = signal as Record<string, unknown>;
  if (value.kind === 'offer' || value.kind === 'answer') {
    return Object.keys(value).every(key => key === 'kind' || key === 'sdp') && typeof value.sdp === 'string' &&
      value.sdp.length > 0 && Buffer.byteLength(value.sdp, 'utf8') <= MAX_VOICE_SDP && /^v=0\r?\n/.test(value.sdp) &&
      /^m=audio /m.test(value.sdp) && !/^m=(?!audio )/m.test(value.sdp);
  }
  return value.kind === 'candidate' && Object.keys(value).every(key => ['kind', 'candidate', 'sdpMid', 'sdpMLineIndex'].includes(key)) &&
    typeof value.candidate === 'string' && Buffer.byteLength(value.candidate, 'utf8') <= MAX_VOICE_CANDIDATE &&
    (value.candidate === '' || value.candidate.startsWith('candidate:')) &&
    (value.sdpMid === null || (typeof value.sdpMid === 'string' && value.sdpMid.length <= 64)) &&
    (value.sdpMLineIndex === null || (Number.isInteger(value.sdpMLineIndex) && Number(value.sdpMLineIndex) >= 0 && Number(value.sdpMLineIndex) <= 8));
}

export class VoiceRelay {
  private readonly members = new Map<string, Member>();
  private readonly generations = new Map<string, number>();
  private nextGeneration = 0;
  private readonly configuration: VoiceOperatorConfiguration;
  private readonly now: () => number;
  private readonly options: VoiceRelayOptions;
  private epoch: string | number | undefined;
  constructor(options: VoiceRelayOptions) {
    this.options = options;
    this.configuration = options.configuration ?? {};
    validateVoiceConfiguration(this.configuration);
    this.now = options.now ?? Date.now;
  }
  sync(participants: readonly VoiceParticipant[], epoch?: string | number): void {
    if (participants.length > MAX_PEERS || new Set(participants.map(peer => peer.id)).size !== participants.length) throw new Error('Invalid voice roster');
    const reset = this.epoch !== undefined && this.epoch !== epoch;
    this.epoch = epoch;
    const ids = new Set(participants.map(peer => peer.id));
    for (const id of this.members.keys()) if (!ids.has(id)) this.members.delete(id);
    for (const participant of participants) {
      let member = this.members.get(participant.id);
      if (!member) {
        member = { participant: { ...participant }, enabled: false, channel: 'team', transmitting: false,
          configuration: { enabled: true, iceServers: [], relayOnly: false }, credentialsExpire: 0, lastState: '', windowStart: 0, signals: 0 };
        this.members.set(participant.id, member);
      } else {
        if (reset || member.participant.team !== participant.team || participant.muted) member.transmitting = false;
        if (reset) member.enabled = false;
        member.participant = { ...participant };
      }
    }
    this.publish();
  }
  configure(id: string, request: { enabled: boolean; channel: VoiceChannel; transmitting: boolean }): string | null {
    const member = this.members.get(id);
    if (!member) return 'Voice participant is no longer admitted';
    if (typeof request.enabled !== 'boolean' || typeof request.transmitting !== 'boolean' || !['public', 'team'].includes(request.channel)) return 'Invalid voice settings';
    member.enabled = request.enabled;
    member.channel = request.channel;
    member.transmitting = request.enabled && request.transmitting && !member.participant.muted && member.participant.team !== 5;
    this.publish();
    return request.transmitting && !member.transmitting ? 'Voice transmission is unavailable while muted, spectating, or disabled' : null;
  }
  signal(id: string, peerId: string, generation: number, signal: VoiceSignal): string | null {
    const sender = this.members.get(id), recipient = this.members.get(peerId);
    if (!sender || !recipient || !this.connected(sender, recipient)) return 'Voice peer is unavailable';
    if (!validVoiceSignal(signal)) return 'Invalid or oversized voice signaling';
    const now = this.now();
    if (now - sender.windowStart >= 10_000) { sender.windowStart = now; sender.signals = 0; }
    if (++sender.signals > 600) return 'Voice signaling rate limit reached';
    if (!Number.isSafeInteger(generation) || generation < 1) return 'Invalid voice connection generation';
    // A delayed offer/candidate from an earlier enabled relationship must never
    // enter a replacement RTCPeerConnection for the same two admission nonces.
    if (this.generations.get(this.pairKey(id, peerId)) !== generation) return null;
    this.options.send(peerId, { type: 'voice-signal-delivery', peerId: id, generation, signal });
    return null;
  }
  /** Refresh REST TURN credentials while idle, before the previous allocation expires. */
  tick(): void {
    if (!this.configuration.turn) return;
    const now = this.now();
    for (const member of this.members.values()) {
      if (member.credentialsExpire <= now) {
        this.publish();
        return;
      }
    }
  }
  remove(id: string): void { if (this.members.delete(id)) this.publish(); }
  close(): void { this.members.clear(); this.generations.clear(); }
  private canSend(sender: Member, recipient: Member): boolean {
    return sender.enabled && recipient.enabled && voiceCanSend(sender.participant, sender.channel, recipient.participant);
  }
  private connected(a: Member, b: Member): boolean { return this.canSend(a, b) || this.canSend(b, a); }
  private pairKey(a: string, b: string): string {
    return a < b ? `${a.length}:${a}${b}` : `${b.length}:${b}${a}`;
  }
  private ice(member: Member): VoiceConfiguration {
    const now = this.now();
    if (member.credentialsExpire > now) return member.configuration;
    const iceServers = (this.configuration.iceServers ?? []).map(server => ({ ...server, urls: [...server.urls] }));
    const turn = this.configuration.turn;
    if (turn) {
      const ttl = turn.ttlSeconds ?? 3600;
      const username = `${Math.floor(now / 1000) + ttl}:${member.participant.id}`;
      iceServers.push({ urls: [...turn.urls], username, credential: createHmac('sha1', turn.secret).update(username).digest('base64') });
      member.credentialsExpire = now + ttl * 500;
    } else member.credentialsExpire = Number.POSITIVE_INFINITY;
    return member.configuration = { enabled: true, iceServers, relayOnly: this.configuration.relayOnly ?? false };
  }
  private publish(): void {
    const members = [...this.members.values()];
    const active = new Set<string>();
    for (let a = 0; a < members.length; a++) for (let b = a + 1; b < members.length; b++) {
      const first = members[a]!, second = members[b]!;
      if (!this.connected(first, second)) continue;
      const key = this.pairKey(first.participant.id, second.participant.id);
      active.add(key);
      if (!this.generations.has(key)) {
        if (this.nextGeneration === Number.MAX_SAFE_INTEGER) throw new Error('Voice connection generations exhausted');
        this.generations.set(key, ++this.nextGeneration);
      }
    }
    for (const key of this.generations.keys()) if (!active.has(key)) this.generations.delete(key);
    for (const [id, member] of this.members) {
      const state: VoiceState = { selfId: id, enabled: member.enabled, channel: member.channel, muted: member.participant.muted, transmitting: member.transmitting,
        configuration: this.ice(member), peers: members.filter(peer => this.connected(member, peer)).map(peer => ({
          id: peer.participant.id, slot: peer.participant.slot, nickname: peer.participant.nickname,
          generation: this.generations.get(this.pairKey(id, peer.participant.id))!,
          canSend: this.canSend(member, peer), canReceive: this.canSend(peer, member),
          talking: peer.transmitting && this.canSend(peer, member),
        })).sort((a, b) => a.id.localeCompare(b.id)) };
      const serialized = JSON.stringify(state);
      if (serialized === member.lastState) continue;
      member.lastState = serialized;
      this.options.send(id, { type: 'voice-state', state });
    }
  }
}
