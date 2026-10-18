import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHmac } from 'node:crypto';
import type { FeatureServerMessage, VoiceState } from '@soldat-web/protocol';
import { VoiceRelay, validVoiceSignal, voiceCanSend, voiceConfigurationFromEnv, type VoiceParticipant } from './voice.ts';

const roster: VoiceParticipant[] = [
  { id: 'admission-a', slot: 1, nickname: 'Alpha', team: 1, muted: false },
  { id: 'admission-b', slot: 2, nickname: 'Bravo', team: 1, muted: false },
  { id: 'admission-c', slot: 3, nickname: 'Charlie', team: 2, muted: false },
  { id: 'admission-s', slot: 4, nickname: 'Spectator', team: 5, muted: false },
];
function fixture(configuration = {}) {
  const states = new Map<string, VoiceState>();
  const messages: { id: string; message: FeatureServerMessage }[] = [];
  const relay = new VoiceRelay({ configuration, now: () => 1_700_000_000_000, send(id, message) {
    messages.push({ id, message });
    if (message.type === 'voice-state') states.set(id, message.state);
  } });
  relay.sync(roster, 'round-1');
  return { relay, states, messages };
}

test('directional public/team voice excludes loopback and spectator send, not public listening', () => {
  assert.equal(voiceCanSend(roster[0]!, 'team', roster[1]!), true);
  assert.equal(voiceCanSend(roster[0]!, 'team', roster[2]!), false);
  assert.equal(voiceCanSend(roster[0]!, 'public', roster[3]!), true);
  assert.equal(voiceCanSend(roster[3]!, 'public', roster[0]!), false);
  assert.equal(voiceCanSend(roster[0]!, 'public', roster[0]!), false);
  assert.equal(voiceCanSend({ ...roster[0]!, muted: true }, 'public', roster[1]!), false);
  assert.equal(voiceCanSend({ ...roster[0]!, team: 0 }, 'team', { ...roster[1]!, team: 0 }), true);
  const { relay, states } = fixture();
  relay.configure('admission-a', { enabled: true, channel: 'public', transmitting: false });
  relay.configure('admission-c', { enabled: true, channel: 'team', transmitting: true });
  const peer = states.get('admission-a')!.peers.find(peer => peer.id === 'admission-c')!;
  assert.equal(peer.canSend, true);
  assert.equal(peer.canReceive, false);
  assert.equal(peer.talking, false);
});

test('native mute revokes transmitting and signaling, slot reuse cannot inherit peer identity', () => {
  const { relay, states } = fixture();
  for (const id of ['admission-a', 'admission-b']) relay.configure(id, { enabled: true, channel: 'team', transmitting: true });
  relay.sync(roster.map(peer => peer.id === 'admission-a' ? { ...peer, muted: true } : peer), 'round-1');
  assert.equal(states.get('admission-a')!.transmitting, false);
  assert.equal(states.get('admission-b')!.peers.find(peer => peer.id === 'admission-a')!.canReceive, false);
  relay.remove('admission-a');
  relay.sync(roster.map(peer => peer.id === 'admission-a' ? { ...peer, id: 'new-admission-a' } : peer), 'round-1');
  assert.equal(states.get('new-admission-a')!.enabled, false);
  assert.ok(relay.signal('admission-b', 'admission-a', 1, { kind: 'candidate', candidate: 'candidate:test', sdpMid: '0', sdpMLineIndex: 0 }));
  assert.equal(states.get('admission-b')!.peers.some(peer => peer.id === 'admission-a'), false);
});

test('team and epoch changes clear PTT, epoch clears opt-in, and removal clears peer presence', () => {
  const { relay, states } = fixture();
  relay.configure('admission-a', { enabled: true, channel: 'public', transmitting: true });
  relay.configure('admission-b', { enabled: true, channel: 'public', transmitting: false });
  relay.sync(roster.map(peer => peer.id === 'admission-a' ? { ...peer, team: 2 } : peer), 'round-1');
  assert.equal(states.get('admission-a')!.transmitting, false);
  relay.sync(roster, 'round-2');
  assert.equal(states.get('admission-a')!.enabled, false);
  assert.equal(states.get('admission-b')!.peers.length, 0);
});

test('SDP/candidate validation rejects non-audio, oversized, malformed and forged signals', () => {
  assert.equal(validVoiceSignal({ kind: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }), true);
  for (const signal of [
    { kind: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    { kind: 'offer', sdp: `v=0\r\nm=audio ${'x'.repeat(32768)}` },
    { kind: 'candidate', candidate: 'candidate:a', sdpMid: '0', sdpMLineIndex: -1 },
    { kind: 'candidate', candidate: 'not a candidate', sdpMid: null, sdpMLineIndex: null },
    { kind: 'candidate', candidate: 'candidate:a', sdpMid: '0', sdpMLineIndex: 0, sender: 'forged' },
  ]) assert.equal(validVoiceSignal(signal), false);
  const { relay, messages } = fixture();
  const candidate = { kind: 'candidate' as const, candidate: 'candidate:a', sdpMid: '0', sdpMLineIndex: 0 };
  assert.ok(relay.signal('admission-a', 'admission-b', 1, candidate));
  relay.configure('admission-a', { enabled: true, channel: 'team', transmitting: false });
  relay.configure('admission-b', { enabled: true, channel: 'team', transmitting: false });
  assert.equal(relay.signal('admission-a', 'admission-b', 1, candidate), null);
  assert.deepEqual(messages.at(-1), { id: 'admission-b', message: { type: 'voice-signal-delivery', peerId: 'admission-a', generation: 1, signal: candidate } });
  for (let index = 1; index < 600; index++) assert.equal(relay.signal('admission-a', 'admission-b', 1, candidate), null);
  assert.match(relay.signal('admission-a', 'admission-b', 1, candidate)!, /rate limit/);
});

test('operator ICE has no public defaults and REST TURN credentials expire without exposing the secret', () => {
  assert.deepEqual(voiceConfigurationFromEnv({}), {});
  assert.throws(() => voiceConfigurationFromEnv({ SOLDAT_VOICE_RELAY_ONLY: 'true' }), /TURN/);
  assert.throws(() => voiceConfigurationFromEnv({ SOLDAT_VOICE_ICE_SERVERS: '[{"urls":["https://not-ice.invalid"]}]' }), /ICE/);
  const { states } = fixture({ relayOnly: true, turn: { urls: ['turn:relay.example:3478?transport=udp'], secret: 'operator-secret', ttlSeconds: 600 } });
  const configuration = states.get('admission-a')!.configuration;
  const server = configuration.iceServers[0]!;
  assert.equal(server.username, '1700000600:admission-a');
  assert.equal(server.credential, createHmac('sha1', 'operator-secret').update(server.username!).digest('base64'));
  assert.equal(JSON.stringify(configuration).includes('operator-secret'), false);
  assert.equal(configuration.relayOnly, true);
});

test('operator credentials enforce wire UTF8 bounds and reject invisible/control/surrogate characters at startup', () => {
  for (const credential of ['é'.repeat(257), 'secret\n', 'secret\u200b', 'secret\ud800']) {
    assert.throws(() => voiceConfigurationFromEnv({
      SOLDAT_VOICE_ICE_SERVERS: JSON.stringify([{ urls: ['turn:relay.example:3478'], username: 'operator', credential }]),
    }), /credentials/);
  }
  const credential = 'é'.repeat(256);
  assert.equal(voiceConfigurationFromEnv({
    SOLDAT_VOICE_ICE_SERVERS: JSON.stringify([{ urls: ['turn:relay.example:3478'], username: 'operator', credential }]),
  }).iceServers![0]!.credential, credential);
});

test('idle TURN maintenance refreshes at half TTL without roster changes or PTT and remains quiet otherwise', () => {
  let now = 1_700_000_000_000;
  const delivered: VoiceState[] = [];
  const relay = new VoiceRelay({
    now: () => now,
    configuration: { turn: { urls: ['turn:relay.example:3478'], secret: 'refresh-secret', ttlSeconds: 600 } },
    send(_id, message) { if (message.type === 'voice-state') delivered.push(message.state); },
  });
  relay.sync([roster[0]!], 'round-1');
  relay.configure('admission-a', { enabled: true, channel: 'team', transmitting: false });
  const initial = delivered.at(-1)!;
  const initialCredential = initial.configuration.iceServers[0]!.credential;
  const before = delivered.length;
  now += 299_999;
  relay.tick();
  assert.equal(delivered.length, before);
  now++;
  relay.tick();
  assert.equal(delivered.length, before + 1);
  const refreshed = delivered.at(-1)!;
  const server = refreshed.configuration.iceServers[0]!;
  assert.equal(server.username, '1700000900:admission-a');
  assert.equal(server.credential, createHmac('sha1', 'refresh-secret').update(server.username!).digest('base64'));
  assert.notEqual(server.credential, initialCredential);
  assert.equal(refreshed.enabled, true);
  assert.equal(refreshed.transmitting, false);
  relay.tick();
  assert.equal(delivered.length, before + 1);
});

test('pair generations survive directional mute changes and reject stale signaling after same-nonce re-enable', () => {
  const { relay, states, messages } = fixture();
  relay.configure('admission-a', { enabled: true, channel: 'team', transmitting: false });
  relay.configure('admission-b', { enabled: true, channel: 'team', transmitting: false });
  const first = states.get('admission-a')!.peers[0]!.generation;
  assert.equal(states.get('admission-b')!.peers[0]!.generation, first);
  relay.sync(roster.map(peer => peer.id === 'admission-a' ? { ...peer, muted: true } : peer), 'round-1');
  assert.equal(states.get('admission-a')!.peers[0]!.generation, first);
  assert.equal(states.get('admission-b')!.peers[0]!.generation, first);
  relay.sync(roster, 'round-1');
  assert.equal(states.get('admission-a')!.peers[0]!.generation, first);
  relay.configure('admission-a', { enabled: false, channel: 'team', transmitting: false });
  assert.equal(states.get('admission-b')!.peers.length, 0);
  relay.configure('admission-a', { enabled: true, channel: 'team', transmitting: false });
  const renewed = states.get('admission-a')!.peers[0]!.generation;
  assert.ok(renewed > first);
  assert.equal(states.get('admission-b')!.peers[0]!.generation, renewed);
  const before = messages.length;
  const candidate = { kind: 'candidate' as const, candidate: 'candidate:current', sdpMid: '0', sdpMLineIndex: 0 };
  assert.equal(relay.signal('admission-a', 'admission-b', first, { kind: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' }), null);
  assert.equal(relay.signal('admission-a', 'admission-b', first, candidate), null);
  assert.equal(messages.length, before, 'stale SDP and ICE must not be forwarded into the renewed relationship');
  assert.equal(relay.signal('admission-a', 'admission-b', renewed, candidate), null);
  assert.deepEqual(messages.at(-1), { id: 'admission-b', message: { type: 'voice-signal-delivery', peerId: 'admission-a', generation: renewed, signal: candidate } });
});
