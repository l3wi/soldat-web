import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeatureClientMessage, VoiceState } from '@soldat-web/protocol';
import { VoiceClient, voicePolite, voiceReceiveVolume } from './voice';

class TestTrack {
  kind = 'audio';
  enabled = true;
  stopped = false;
  onended: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  stop() { this.stopped = true; }
}
class TestStream {
  tracks: TestTrack[] = [];
  addTrack(track: TestTrack) { this.tracks.push(track); }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks; }
}
class TestAudio {
  autoplay = false;
  muted = true;
  volume = 1;
  srcObject: unknown;
  plays = 0;
  removed = false;
  setAttribute() {}
  async play() { this.plays++; }
  pause() {}
  remove() { this.removed = true; }
}
class TestConnection {
  static instances: TestConnection[] = [];
  ontrack: ((event: { track: TestTrack }) => void) | null = null;
  onicecandidate: unknown = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: unknown = null;
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: { type: 'offer' | 'answer'; sdp: string } | null = null;
  remoteDescription: unknown = null;
  replacements: (TestTrack | null)[] = [];
  candidates: unknown[] = [];
  closed = false;
  configurations: RTCConfiguration[] = [];
  restarts = 0;
  constructor() { TestConnection.instances.push(this); }
  addTransceiver() { return { sender: { replaceTrack: async (track: TestTrack | null) => { this.replacements.push(track); } } }; }
  async setLocalDescription() {
    const answer = this.signalingState === 'have-remote-offer';
    this.localDescription = { type: answer ? 'answer' : 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' };
    this.signalingState = answer ? 'stable' : 'have-local-offer';
  }
  async setRemoteDescription(description: { type: string }) {
    this.remoteDescription = description;
    this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(candidate: unknown) { this.candidates.push(candidate); }
  async getStats() { return new Map(); }
  close() { this.closed = true; }
  setConfiguration(configuration: RTCConfiguration) { this.configurations.push(configuration); }
  restartIce() { this.restarts++; }
}
const state: VoiceState = {
  selfId: 'nonce-a', enabled: true, channel: 'team', muted: false, transmitting: false,
  configuration: { enabled: true, iceServers: [], relayOnly: false },
  peers: [{ id: 'nonce-b', generation: 1, slot: 2, nickname: 'Bravo', canSend: true, canReceive: true, talking: false }],
};
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function environment() {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const audios: TestAudio[] = [];
  let requests = 0;
  let resolveCapture!: (stream: TestStream) => void;
  let rejectCapture!: (reason: Error) => void;
  const capture = new Promise<TestStream>((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  const values: Record<string, unknown> = {
    isSecureContext: true,
    navigator: { mediaDevices: { getUserMedia: () => { requests++; return capture; } } },
    document: { hidden: false, addEventListener() {}, removeEventListener() {}, createElement: () => { const audio = new TestAudio(); audios.push(audio); return audio; } },
    RTCPeerConnection: TestConnection,
    MediaStream: TestStream,
  };
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  TestConnection.instances.length = 0;
  return { audios, requests: () => requests, resolveCapture, rejectCapture, restore() {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

test('voice defaults and opt-in never capture; release cancels pending capture and disposes late tracks', async () => {
  const env = environment();
  const sent: FeatureClientMessage[] = [];
  const client = new VoiceClient({ send: message => sent.push(message), onStatus() {} });
  try {
    assert.equal(env.requests(), 0);
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    client.receive({ type: 'voice-state', state });
    assert.equal(env.requests(), 0);
    client.setTransmit(true);
    assert.equal(env.requests(), 1);
    client.setTransmit(false);
    const track = new TestTrack(), stream = new TestStream();
    stream.addTrack(track);
    env.resolveCapture(stream);
    await settle();
    assert.equal(track.stopped, true);
    assert.equal(TestConnection.instances[0]!.replacements.includes(track), false);
    assert.equal(sent.filter(message => message.type === 'voice-configure').at(-1)?.transmitting, false);
  } finally { client.dispose(); env.restore(); }
});

test('capture attaches audio track, server revocation stops it; receiver gating and local mute prevent playback', async () => {
  const env = environment();
  const client = new VoiceClient({ send() {}, onStatus() {} });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 0.5 }, 0.4);
    client.receive({ type: 'voice-state', state });
    client.setTransmit(true);
    const track = new TestTrack(), stream = new TestStream();
    stream.addTrack(track);
    env.resolveCapture(stream);
    await settle();
    const pc = TestConnection.instances[0]!;
    assert.ok(pc.replacements.includes(track));
    const incoming = new TestTrack();
    pc.ontrack!({ track: incoming });
    assert.equal(env.audios[0]!.muted, true);
    client.receive({ type: 'voice-state', state: { ...state, transmitting: true, peers: [{ ...state.peers[0]!, talking: true }] } });
    assert.equal(env.audios[0]!.muted, false);
    assert.equal(env.audios[0]!.volume, 0.2);
    client.setPeerMuted('nonce-b', true);
    assert.equal(env.audios[0]!.muted, true);
    assert.equal(incoming.enabled, false);
    client.setPeerMuted('nonce-b', false);
    assert.equal(env.audios[0]!.muted, false);
    client.receive({ type: 'voice-state', state: { ...state, muted: true, transmitting: false, peers: [{ ...state.peers[0]!, canSend: false, talking: false }] } });
    assert.equal(track.stopped, true);
    assert.equal(env.audios[0]!.removed, false);
    assert.equal(TestConnection.instances.length, 1, 'server mute preserves the listening transport');
    assert.equal(env.audios.at(-1)!.muted, true);
    client.disconnect();
    assert.ok(TestConnection.instances.every(connection => connection.closed));
    assert.ok(env.audios.every(audio => audio.srcObject === null));
  } finally { client.dispose(); env.restore(); }
});

test('simultaneous offers use nonce ordering and queue ICE until remote description', async () => {
  const env = environment();
  const sent: FeatureClientMessage[] = [];
  const client = new VoiceClient({ send: message => sent.push(message), onStatus() {} });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    client.receive({ type: 'voice-state', state });
    const pc = TestConnection.instances[0]!;
    client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 1, signal: { kind: 'candidate', candidate: 'candidate:queued', sdpMid: '0', sdpMLineIndex: 0 } });
    await settle();
    assert.equal(pc.candidates.length, 0);
    pc.onnegotiationneeded!();
    await settle();
    client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 1, signal: { kind: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
    await settle();
    assert.equal(pc.remoteDescription, null, 'impolite lower nonce ignores collided offer');
    client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 1, signal: { kind: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
    await settle();
    assert.notEqual(pc.remoteDescription, null);
    assert.equal(voicePolite('nonce-a', 'nonce-b'), false);
    assert.equal(voicePolite('nonce-b', 'nonce-a'), true);
    assert.equal(sent.some(message => message.type === 'voice-signal' && message.signal.kind === 'offer'), true);
  } finally { client.dispose(); env.restore(); }
});

test('volume clamps invalid values rather than enabling a louder fallback', () => {
  assert.equal(voiceReceiveVolume(2, 2), 1);
  assert.equal(voiceReceiveVolume(-1, 1), 0);
  assert.equal(voiceReceiveVolume(Number.NaN, 1), 0);
});

test('higher nonce waits for initial offer and answers without capture', async () => {
  const env = environment();
  const sent: FeatureClientMessage[] = [];
  const client = new VoiceClient({ send: message => sent.push(message), onStatus() {} });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    const higher: VoiceState = { ...state, selfId: 'nonce-z' };
    client.receive({ type: 'voice-state', state: higher });
    const pc = TestConnection.instances[0]!;
    const description = () => pc.localDescription;
    pc.onnegotiationneeded!();
    await settle();
    assert.equal(description(), null);
    client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 1, signal: { kind: 'candidate', candidate: 'candidate:queued', sdpMid: '0', sdpMLineIndex: 0 } });
    client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 1, signal: { kind: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
    await settle();
    assert.equal(description()?.type, 'answer');
    assert.equal(pc.candidates.length, 1);
    assert.equal(sent.some(message => message.type === 'voice-signal' && message.signal.kind === 'answer'), true);
    assert.equal(env.requests(), 0);
  } finally { client.dispose(); env.restore(); }
});

test('nonce replacement cancels in-flight permission prompt without reusing the old peer', async () => {
  const env = environment();
  const client = new VoiceClient({ send() {}, onStatus() {} });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    client.receive({ type: 'voice-state', state });
    client.setTransmit(true);
    client.receive({ type: 'voice-state', state: { ...state, selfId: 'nonce-new' } });
    const track = new TestTrack(), stream = new TestStream();
    stream.addTrack(track);
    env.resolveCapture(stream);
    await settle();
    assert.equal(track.stopped, true);
    assert.equal(TestConnection.instances[0]!.closed, true);
    assert.equal(TestConnection.instances.some(connection => connection.replacements.includes(track)), false);
  } finally { client.dispose(); env.restore(); }
});

test('team/public/team changes preserve the unchanged teammate connection and only remove departed audience', async () => {
  const env = environment();
  const client = new VoiceClient({ send() {}, onStatus() {} });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    const teammate = { ...state.peers[0]!, talking: true };
    client.receive({ type: 'voice-state', state: { ...state, peers: [teammate] } });
    const sameTeam = TestConnection.instances[0]!;
    const incoming = new TestTrack();
    sameTeam.ontrack!({ track: incoming });
    client.setSettings({ enabled: true, channel: 'public', receiveVolume: 1 });
    assert.equal(sameTeam.closed, false);
    const opponent = { id: 'nonce-opponent', generation: 2, slot: 3, nickname: 'Charlie', canSend: true, canReceive: false, talking: false };
    client.receive({ type: 'voice-state', state: { ...state, channel: 'public', peers: [teammate, opponent] } });
    assert.equal(TestConnection.instances.length, 2);
    assert.equal(sameTeam.closed, false);
    assert.equal(env.audios[0]!.removed, false);
    assert.equal(incoming.stopped, false);
    assert.equal(env.audios[0]!.muted, false);
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    client.receive({ type: 'voice-state', state: { ...state, peers: [teammate] } });
    assert.equal(sameTeam.closed, false);
    assert.equal(TestConnection.instances[1]!.closed, true);
    assert.equal(TestConnection.instances.length, 2, 'unchanged teammate never needs a replacement offer');
    assert.equal(env.audios[0]!.removed, false);
    assert.equal(env.requests(), 0);
  } finally { client.dispose(); env.restore(); }
});

test('ICE credential renewal updates and restarts the existing connection without revoking held microphone or sinks', async () => {
  const env = environment();
  const sent: FeatureClientMessage[] = [];
  const client = new VoiceClient({ send: message => sent.push(message), onStatus() {} });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    client.receive({ type: 'voice-state', state });
    const pc = TestConnection.instances[0]!;
    pc.onnegotiationneeded!();
    await settle();
    client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 1, signal: { kind: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
    await settle();
    const description = pc.remoteDescription;
    client.setTransmit(true);
    const track = new TestTrack(), stream = new TestStream();
    stream.addTrack(track);
    env.resolveCapture(stream);
    await settle();
    client.receive({ type: 'voice-state', state: { ...state, transmitting: true } });
    const configuration = { enabled: true, relayOnly: true, iceServers: [{ urls: ['turn:relay.example:3478'], username: 'renewed', credential: 'renewed-hmac' }] };
    client.receive({ type: 'voice-state', state: { ...state, transmitting: true, configuration } });
    await settle();
    assert.equal(TestConnection.instances.length, 1);
    assert.equal(pc.closed, false);
    assert.equal(pc.remoteDescription, description);
    assert.equal(pc.restarts, 1);
    assert.deepEqual(pc.configurations[0], { iceServers: configuration.iceServers, iceTransportPolicy: 'relay' });
    assert.equal(track.stopped, false);
    assert.equal(env.audios[0]!.removed, false);
    assert.equal(env.requests(), 1);
    pc.onnegotiationneeded!();
    await settle();
    assert.equal(sent.filter(message => message.type === 'voice-signal' && message.signal.kind === 'offer').length, 2);
    client.receive({ type: 'voice-state', state: { ...state, transmitting: true, configuration } });
    await settle();
    assert.equal(pc.restarts, 1, 'unchanged credentials do not restart repeatedly');
  } finally { client.dispose(); env.restore(); }
});

test('rapid remote and local mute/unmute gate media without replacing the same-generation transport', async () => {
  const env = environment();
  const statuses: string[] = [];
  const client = new VoiceClient({ send() {}, onStatus: text => statuses.push(text) });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    const talkingPeer = { ...state.peers[0]!, talking: true };
    client.receive({ type: 'voice-state', state: { ...state, peers: [talkingPeer] } });
    const pc = TestConnection.instances[0]!;
    const incoming = new TestTrack();
    pc.ontrack!({ track: incoming });
    client.setTransmit(true);
    const microphone = new TestTrack(), stream = new TestStream();
    stream.addTrack(microphone);
    env.resolveCapture(stream);
    await settle();
    client.receive({ type: 'voice-state', state: { ...state, transmitting: true, peers: [talkingPeer] } });
    client.receive({ type: 'voice-state', state: { ...state, transmitting: true, peers: [{ ...talkingPeer, canReceive: false, talking: false }] } });
    assert.equal(env.audios[0]!.muted, true);
    assert.equal(microphone.stopped, false, 'remote mute must not revoke the allowed outgoing direction');
    client.receive({ type: 'voice-state', state: { ...state, transmitting: true, peers: [talkingPeer] } });
    assert.equal(env.audios[0]!.muted, false);
    client.receive({ type: 'voice-state', state: { ...state, muted: true, peers: [{ ...talkingPeer, canSend: false }] } });
    assert.match(statuses.at(-1)!, /muted by server/);
    assert.equal(microphone.stopped, true);
    assert.equal(pc.replacements.at(-1), null, 'lost outgoing permission detaches immediately');
    client.receive({ type: 'voice-state', state: { ...state, peers: [talkingPeer] } });
    await settle();
    assert.match(statuses.at(-1)!, /Voice unmuted/);
    assert.equal(TestConnection.instances.length, 1);
    assert.equal(pc.closed, false);
    assert.equal(env.audios[0]!.removed, false);
    assert.equal(incoming.stopped, false);
    assert.equal(env.audios[0]!.muted, false);
    assert.equal(env.requests(), 1, 'unmute never requests microphone without another PTT gesture');
  } finally { client.dispose(); env.restore(); }
});

test('same-nonce replacement relationship rejects stale-generation SDP and ICE while accepting current generation', async () => {
  const env = environment();
  const sent: FeatureClientMessage[] = [];
  const client = new VoiceClient({ send: message => sent.push(message), onStatus() {} });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    const higher = { ...state, selfId: 'nonce-z' };
    client.receive({ type: 'voice-state', state: higher });
    client.receive({ type: 'voice-state', state: { ...higher, peers: [] } });
    client.receive({ type: 'voice-state', state: { ...higher, peers: [{ ...state.peers[0]!, generation: 2 }] } });
    const pc = TestConnection.instances[1]!;
    assert.equal(TestConnection.instances[0]!.closed, true);
    for (const signal of [
      { kind: 'candidate' as const, candidate: 'candidate:stale', sdpMid: '0', sdpMLineIndex: 0 },
      { kind: 'offer' as const, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
      { kind: 'answer' as const, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    ]) client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 1, signal });
    await settle();
    assert.equal(pc.remoteDescription, null);
    assert.equal(pc.candidates.length, 0);
    client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 2, signal: { kind: 'candidate', candidate: 'candidate:current', sdpMid: '0', sdpMLineIndex: 0 } });
    client.receive({ type: 'voice-signal-delivery', peerId: 'nonce-b', generation: 2, signal: { kind: 'offer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' } });
    await settle();
    assert.equal(pc.candidates.length, 1);
    assert.equal(sent.some(message => message.type === 'voice-signal' && message.generation === 2 && message.signal.kind === 'answer'), true);
    assert.equal(pc.closed, false);
  } finally { client.dispose(); env.restore(); }
});

test('suspend and server reset clear transmitting status only when they actually stop a held capture', async () => {
  for (const reason of ['suspend', 'server-reset']) {
    const env = environment();
    const statuses: string[] = [];
    const client = new VoiceClient({ send() {}, onStatus: text => statuses.push(text) });
    try {
      client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
      client.receive({ type: 'voice-state', state });
      client.setTransmit(true);
      const track = new TestTrack(), stream = new TestStream();
      stream.addTrack(track);
      env.resolveCapture(stream);
      await settle();
      assert.match(statuses.at(-1)!, /^Transmitting/);
      if (reason === 'suspend') client.suspend();
      else client.receive({ type: 'voice-state', state: { ...state, enabled: false, peers: [] } });
      assert.equal(track.stopped, true);
      assert.match(statuses.at(-1)!, /^Voice ready/);
    } finally { client.dispose(); env.restore(); }
  }
});

test('permission and network errors survive unrelated peer updates and no-op release/suspend', async () => {
  const env = environment();
  const statuses: string[] = [];
  const client = new VoiceClient({ send() {}, onStatus: text => statuses.push(text) });
  try {
    client.setSettings({ enabled: true, channel: 'team', receiveVolume: 1 });
    client.receive({ type: 'voice-state', state });
    client.setTransmit(true);
    env.rejectCapture(new DOMException('Denied', 'NotAllowedError'));
    await settle();
    assert.match(statuses.at(-1)!, /permission denied/);
    client.receive({ type: 'voice-state', state: { ...state, peers: [{ ...state.peers[0]!, talking: true }] } });
    client.suspend();
    client.setTransmit(false);
    assert.match(statuses.at(-1)!, /permission denied/);
    const pc = TestConnection.instances[0]!;
    pc.connectionState = 'failed';
    (pc.onconnectionstatechange as () => void)();
    assert.match(statuses.at(-1)!, /failed/);
    client.receive({ type: 'voice-state', state });
    client.suspend();
    client.setTransmit(false);
    assert.match(statuses.at(-1)!, /failed/);
  } finally { client.dispose(); env.restore(); }
});
