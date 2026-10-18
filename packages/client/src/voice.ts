import type { FeatureClientMessage, FeatureServerMessage, VoiceChannel, VoicePeer, VoiceSignal, VoiceState } from '@soldat-web/protocol';

export interface VoicePreferences { enabled: boolean; channel: VoiceChannel; receiveVolume: number }
export interface VoiceClientOptions {
  send(message: FeatureClientMessage): void;
  onStatus(text: string): void;
  onTransmit?(active: boolean): void;
}
interface Peer {
  policy: VoicePeer;
  pc: RTCPeerConnection;
  sender: RTCRtpSender;
  audio: HTMLAudioElement;
  stream: MediaStream;
  candidates: RTCIceCandidateInit[];
  operations: Promise<void>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  answering: boolean;
  closed: boolean;
}
export const MAX_PENDING_VOICE_CANDIDATES = 64;
/** Nonce ordering is stable even when native slots are reused. */
export function voicePolite(selfId: string, peerId: string): boolean { return selfId > peerId; }
export function voiceReceiveVolume(volume: number, masterVolume: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(volume) && Number.isFinite(masterVolume) ? volume * masterVolume : 0));
}

/** Browser-native WebRTC audio. Construction/enabling never requests microphone access. */
export class VoiceClient {
  private settings: VoicePreferences = { enabled: false, channel: 'team', receiveVolume: 1 };
  private masterVolume = 1;
  private state: VoiceState | undefined;
  private readonly peers = new Map<string, Peer>();
  private readonly locallyMuted = new Set<string>();
  private microphone: MediaStream | undefined;
  private captureGeneration = 0;
  private held = false;
  private disposed = false;
  private configurationKey = '';
  private configured = '';
  private readonly blur = (): void => { this.suspend(); };
  private readonly visibility = (): void => { if (document.hidden) this.suspend(); };

  constructor(private readonly options: VoiceClientOptions) {
    if (typeof window !== 'undefined') window.addEventListener('blur', this.blur);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.visibility);
  }
  setSettings(settings: VoicePreferences, masterVolume = 1): void {
    if (this.disposed) return;
    const changed = settings.enabled !== this.settings.enabled || settings.channel !== this.settings.channel;
    this.settings = { ...settings, receiveVolume: voiceReceiveVolume(settings.receiveVolume, 1) };
    this.masterVolume = voiceReceiveVolume(masterVolume, 1);
    if (changed) this.stopCapture();
    if (!settings.enabled) this.closePeers();
    for (const peer of this.peers.values()) this.applyPlayback(peer);
    this.configure();
    if (!this.settings.enabled) this.options.onStatus('Voice disabled');
    else if (changed) this.options.onStatus('Voice enabled — hold push-to-talk to request microphone access');
    void this.resumePlayback();
  }
  receive(message: FeatureServerMessage): void {
    if (this.disposed) return;
    if (message.type === 'voice-signal-delivery') {
      const peer = this.peers.get(message.peerId);
      if (peer && peer.policy.generation === message.generation) this.enqueue(peer, () => this.acceptSignal(peer, message.signal));
      return;
    }
    if (message.type !== 'voice-state') return;
    const previous = this.state;
    const state = message.state;
    const key = JSON.stringify(state.configuration);
    const configurationChanged = !!previous && previous.selfId === state.selfId && key !== this.configurationKey;
    if ((previous && previous.selfId !== state.selfId) || !state.enabled) {
      this.stopCapture();
      this.closePeers();
    } else if (state.muted || (previous?.transmitting && !state.transmitting)) {
      this.stopCapture();
    }
    this.state = state;
    this.configurationKey = key;
    if (this.settings.enabled && state.muted && !previous?.muted) this.options.onStatus('Voice transmission muted by server');
    else if (this.settings.enabled && previous?.muted && !state.muted) this.options.onStatus('Voice unmuted — hold push-to-talk to speak');
    if (!this.settings.enabled || !state.enabled || !state.configuration.enabled) {
      this.stopCapture();
      this.closePeers();
      // Rounds revoke server opt-in; restore listening but never restore a held PTT.
      if (this.settings.enabled && !state.enabled) { this.configured = ''; this.configure(); }
      return;
    }
    if (typeof RTCPeerConnection === 'undefined') { this.options.onStatus('Voice unavailable: this browser does not support WebRTC'); return; }
    if (state.configuration.relayOnly && !state.configuration.iceServers.some(server => server.urls.some(url => /^turns?:/i.test(url)))) {
      this.options.onStatus('Voice unavailable: relay-only mode requires an operator-configured TURN server');
      this.stopCapture();
      this.closePeers();
      return;
    }
    const ids = new Set(state.peers.filter(peer => peer.id !== state.selfId && (peer.canSend || peer.canReceive)).map(peer => peer.id));
    for (const id of this.locallyMuted) if (!ids.has(id)) this.locallyMuted.delete(id);
    for (const [id, peer] of this.peers) if (!ids.has(id)) this.closePeer(id, peer);
    for (const policy of state.peers) {
      if (!ids.has(policy.id)) continue;
      let peer = this.peers.get(policy.id);
      if (peer && peer.policy.generation !== policy.generation) {
        this.closePeer(policy.id, peer);
        peer = undefined;
      }
      try {
        if (!peer) { peer = this.createPeer(policy); this.peers.set(policy.id, peer); }
        else if (configurationChanged) {
          const pc = peer.pc;
          this.enqueue(peer, async () => {
            pc.setConfiguration({ iceServers: state.configuration.iceServers, iceTransportPolicy: state.configuration.relayOnly ? 'relay' : 'all' });
            pc.restartIce();
          });
        }
        const sendingChanged = peer.policy.canSend !== policy.canSend;
        peer.policy = policy;
        const currentPeer = peer;
        if (sendingChanged) {
          if (!policy.canSend) {
            // Revoke this recipient immediately, independently of pending SDP work.
            void currentPeer.sender.replaceTrack(null).catch(error => {
              if (!currentPeer.closed) this.options.onStatus(`Voice sender unavailable: ${this.errorText(error)}`);
            });
          } else {
            this.enqueue(currentPeer, () => currentPeer.sender.replaceTrack(this.held && currentPeer.policy.canSend ? this.microphone?.getAudioTracks()[0] ?? null : null));
          }
        }
        this.applyPlayback(peer);
      } catch (error) { this.options.onStatus(`Voice connection unavailable: ${this.errorText(error)}`); }
    }
    if (this.held && ![...this.peers.values()].some(peer => peer.policy.canSend)) this.stopCapture();
    this.configure();
  }
  /** Call directly from PTT key/pointer down; this is the only microphone entry point. */
  setTransmit(active: boolean): void {
    if (this.disposed) return;
    if (!active) {
      this.stopCapture();
      this.configure();
      return;
    }
    if (this.held) return;
    if (!this.settings.enabled) { this.options.onStatus('Enable voice under Settings → Taunts & console controls before using push-to-talk'); return; }
    if (!this.state?.enabled || this.state.muted) { this.options.onStatus(this.state?.muted ? 'Voice transmission muted by server' : 'Voice is not connected'); return; }
    if (![...this.peers.values()].some(peer => peer.policy.canSend)) { this.options.onStatus('No eligible voice recipients in this channel'); return; }
    if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.options.onStatus('Microphone requires HTTPS or localhost and browser microphone support'); return;
    }
    this.held = true;
    const generation = ++this.captureGeneration;
    this.configure();
    void this.resumePlayback();
    this.options.onStatus('Requesting microphone — allow access in browser permissions');
    void navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }).then(stream => {
      if (this.disposed || generation !== this.captureGeneration || !this.held || !this.state?.enabled || this.state.muted) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.microphone = stream;
      const track = stream.getAudioTracks()[0];
      if (!track) { this.stopCapture(); this.configure(); this.options.onStatus('Microphone supplied no audio track; select an available input device'); return; }
      track.onended = () => { if (this.microphone === stream) { this.stopCapture(); this.configure(); this.options.onStatus('Microphone disconnected — reconnect it and press push-to-talk again'); } };
      for (const peer of this.peers.values()) if (peer.policy.canSend) this.enqueue(peer, () => peer.sender.replaceTrack(this.held && peer.policy.canSend ? this.microphone?.getAudioTracks()[0] ?? null : null));
      this.options.onTransmit?.(true);
      this.options.onStatus(`Transmitting to ${this.settings.channel} voice — release push-to-talk to stop`);
    }).catch(error => {
      if (generation !== this.captureGeneration) return;
      this.stopCapture();
      this.configure();
      const name = error instanceof DOMException ? error.name : '';
      this.options.onStatus(name === 'NotAllowedError' ? 'Microphone permission denied — allow microphone access in browser site settings, then press push-to-talk again' :
        name === 'NotFoundError' ? 'No microphone found — connect an input device, then press push-to-talk again' : `Microphone unavailable: ${this.errorText(error)}`);
    });
  }
  /** Receiver-only mute is local to this admission nonce, never a server moderation action. */
  setPeerMuted(peerId: string, muted: boolean): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    if (muted) this.locallyMuted.add(peerId);
    else this.locallyMuted.delete(peerId);
    this.applyPlayback(peer);
  }
  /** Blur/menu/release stops capture immediately while opted-in listening may continue. */
  suspend(): void { this.stopCapture(); this.configure(); }
  disconnect(): void {
    this.stopCapture();
    this.closePeers();
    this.locallyMuted.clear();
    this.state = undefined;
    this.configured = '';
    this.configurationKey = '';
    this.options.onStatus('Voice disconnected');
  }
  dispose(): void {
    if (this.disposed) return;
    this.disconnect();
    this.disposed = true;
    if (typeof window !== 'undefined') window.removeEventListener('blur', this.blur);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.visibility);
  }
  async resumePlayback(): Promise<void> {
    for (const peer of this.peers.values()) {
      if (!peer.policy.canReceive || !peer.policy.talking || !peer.stream.getAudioTracks().length) continue;
      try { await peer.audio.play(); }
      catch { if (!peer.closed) this.options.onStatus('Voice playback blocked — press push-to-talk or enable voice again to allow audio'); }
    }
  }
  /** Real browser RTP stats, useful for diagnostics without exposing microphone streams. */
  async getStats(): Promise<{ id: string; stats: RTCStatsReport }[]> {
    return Promise.all([...this.peers].map(async ([id, peer]) => ({ id, stats: await peer.pc.getStats() })));
  }
  private configure(): void {
    if (!this.state || this.disposed) return;
    const message = { type: 'voice-configure' as const, enabled: this.settings.enabled, channel: this.settings.channel, transmitting: this.held };
    const key = JSON.stringify(message);
    if (key === this.configured) return;
    this.configured = key;
    this.options.send(message);
  }
  private stopCapture(): void {
    const wasActive = this.held || !!this.microphone;
    this.held = false;
    this.captureGeneration++;
    for (const track of this.microphone?.getTracks() ?? []) { track.onended = null; track.stop(); }
    this.microphone = undefined;
    // stop() disables capture synchronously; replaceTrack removes the stopped sender track.
    for (const peer of this.peers.values()) this.enqueue(peer, () => peer.sender.replaceTrack(null));
    this.options.onTransmit?.(false);
    if (wasActive) this.options.onStatus(this.state?.muted ? 'Voice transmission muted by server' : 'Voice ready — hold push-to-talk to speak');
  }
  private createPeer(policy: VoicePeer): Peer {
    const state = this.state!;
    const pc = new RTCPeerConnection({ iceServers: state.configuration.iceServers, iceTransportPolicy: state.configuration.relayOnly ? 'relay' : 'all' });
    const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    const stream = new MediaStream();
    audio.srcObject = stream;
    const peer: Peer = { policy, pc, sender: transceiver.sender, audio, stream, candidates: [], operations: Promise.resolve(), makingOffer: false, ignoreOffer: false, answering: false, closed: false };
    this.applyPlayback(peer);
    pc.ontrack = event => {
      if (peer.closed || event.track.kind !== 'audio') return;
      stream.addTrack(event.track);
      event.track.onunmute = () => { if (!peer.closed) { this.applyPlayback(peer); void this.resumePlayback(); } };
      this.applyPlayback(peer);
      void this.resumePlayback();
    };
    pc.onicecandidate = event => {
      if (!peer.closed && event.candidate) this.options.send({ type: 'voice-signal', peerId: policy.id, generation: policy.generation, signal: { kind: 'candidate', candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid, sdpMLineIndex: event.candidate.sdpMLineIndex } });
    };
    pc.onnegotiationneeded = () => this.enqueue(peer, async () => {
      // Only the lower admission nonce starts a fresh connection. Perfect
      // negotiation below still handles subsequent simultaneous renegotiation.
      if (!pc.remoteDescription && voicePolite(this.state!.selfId, policy.id)) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (!peer.closed && pc.localDescription) this.sendDescription(peer, pc.localDescription);
      } finally { peer.makingOffer = false; }
    });
    pc.onconnectionstatechange = () => {
      if (peer.closed) return;
      if (pc.connectionState === 'failed') {
        if (![...this.peers.values()].some(candidate => candidate.policy.canSend && candidate.pc.connectionState !== 'failed')) { this.stopCapture(); this.configure(); }
        this.options.onStatus(`Voice connection to ${peer.policy.nickname} failed — configure TURN for restrictive networks`);
      }
    };
    const track = this.microphone?.getAudioTracks()[0];
    if (track && this.held && policy.canSend) this.enqueue(peer, () => peer.sender.replaceTrack(this.held && peer.policy.canSend ? this.microphone?.getAudioTracks()[0] ?? null : null));
    return peer;
  }
  private enqueue(peer: Peer, operation: () => Promise<void>): void {
    peer.operations = peer.operations.then(async () => { if (!peer.closed) await operation(); }).catch(error => {
      if (!peer.closed) this.options.onStatus(`Voice connection error: ${this.errorText(error)}`);
    });
  }
  private async acceptSignal(peer: Peer, signal: VoiceSignal): Promise<void> {
    const pc = peer.pc;
    if (signal.kind === 'candidate') {
      if (peer.ignoreOffer) return;
      const candidate: RTCIceCandidateInit = { candidate: signal.candidate, sdpMid: signal.sdpMid, sdpMLineIndex: signal.sdpMLineIndex };
      if (pc.remoteDescription) await pc.addIceCandidate(candidate);
      else {
        if (peer.candidates.length >= MAX_PENDING_VOICE_CANDIDATES) throw new Error('Too many queued ICE candidates');
        peer.candidates.push(candidate);
      }
      return;
    }
    const ready = !peer.makingOffer && (pc.signalingState === 'stable' || peer.answering);
    const collision = signal.kind === 'offer' && !ready;
    peer.ignoreOffer = collision && !voicePolite(this.state!.selfId, peer.policy.id);
    if (peer.ignoreOffer) { peer.candidates.length = 0; return; }
    peer.answering = signal.kind === 'answer';
    try { await pc.setRemoteDescription({ type: signal.kind, sdp: signal.sdp }); }
    finally { peer.answering = false; }
    for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
    if (signal.kind === 'offer') {
      await pc.setLocalDescription();
      if (!peer.closed && pc.localDescription) this.sendDescription(peer, pc.localDescription);
    }
  }
  private sendDescription(peer: Peer, description: RTCSessionDescription): void {
    if (description.type === 'offer' || description.type === 'answer') this.options.send({ type: 'voice-signal', peerId: peer.policy.id, generation: peer.policy.generation, signal: { kind: description.type, sdp: description.sdp } });
  }
  private applyPlayback(peer: Peer): void {
    const audible = this.settings.enabled && peer.policy.canReceive && peer.policy.talking && !this.locallyMuted.has(peer.policy.id);
    peer.audio.muted = !audible;
    peer.audio.volume = voiceReceiveVolume(this.settings.receiveVolume, this.masterVolume);
    for (const track of peer.stream.getAudioTracks()) track.enabled = audible;
    if (audible && peer.stream.getAudioTracks().length) void peer.audio.play().catch(() => {
      if (!peer.closed) this.options.onStatus('Voice playback blocked — press push-to-talk or enable voice again to allow audio');
    });
  }
  private closePeer(id: string, peer: Peer): void {
    peer.closed = true;
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.candidates.length = 0;
    peer.audio.pause();
    peer.audio.srcObject = null;
    peer.audio.remove();
    for (const track of peer.stream.getTracks()) { track.onunmute = null; track.stop(); }
    if (this.peers.get(id) === peer) this.peers.delete(id);
  }
  private closePeers(): void { for (const [id, peer] of this.peers) this.closePeer(id, peer); }
  private errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
}
