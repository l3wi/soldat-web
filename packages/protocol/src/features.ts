export type GestureKind = 'smoke' | 'tabac' | 'takeoff' | 'victory';
export type VoiceChannel = 'public' | 'team';
export type RadioChoice = 1 | 2 | 3;

export type AdminAction =
  | { kind: 'kick'; slot: number; reason: string }
  | { kind: 'ban'; slot: number; minutes: number; reason: string }
  | { kind: 'unban'; id: string }
  | { kind: 'bans' }
  | { kind: 'mute' | 'unmute'; slot: number }
  | { kind: 'team'; slot: number; team: number }
  | { kind: 'kill'; slot: number }
  | { kind: 'map'; map: string }
  | { kind: 'nextmap' | 'restart' | 'pause' | 'unpause' };

export interface BanSummary {
  id: string; nickname: string; reason: string; expiresAt: number; global: boolean;
}
export type VoteProposal = { kind: 'kick'; slot: number; reason: string } | { kind: 'map'; map: string };
export interface VoteState {
  id: number; proposal: VoteProposal; initiator: string; targetLabel: string;
  yes: number; no: number; eligible: number; required: number; remainingMs: number;
  myVote: 'yes' | 'no' | null; canVote: boolean;
  phase: 'active' | 'passed' | 'failed' | 'cancelled'; reason: string;
}
export interface ControlState {
  host: boolean; admin: boolean; paused: boolean; muted: boolean; vote: VoteState | null;
}

export interface IceServerConfiguration { urls: string[]; username?: string; credential?: string }
export interface VoiceConfiguration { enabled: boolean; iceServers: IceServerConfiguration[]; relayOnly: boolean }
export interface VoicePeer {
  generation: number;
  id: string; slot: number; nickname: string; canSend: boolean; canReceive: boolean; talking: boolean;
}
export interface VoiceState {
  selfId: string;
  transmitting: boolean;
  enabled: boolean; channel: VoiceChannel; muted: boolean; peers: VoicePeer[]; configuration: VoiceConfiguration;
}
export type VoiceSignal =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null };

export type FeatureClientMessage =
  | { type: 'gesture'; gesture: GestureKind }
  | { type: 'self-kill' }
  | { type: 'admin-auth'; token: string }
  | { type: 'admin-logout' }
  | { type: 'admin-action'; action: AdminAction }
  | { type: 'vote-start'; proposal: VoteProposal }
  | { type: 'vote-cast'; id: number; choice: 'yes' | 'no' }
  | { type: 'radio'; category: RadioChoice; direction: RadioChoice }
  | { type: 'voice-configure'; enabled: boolean; channel: VoiceChannel; transmitting: boolean }
  | { type: 'voice-signal'; peerId: string; generation: number; signal: VoiceSignal };
export type FeatureServerMessage =
  | { type: 'control-state'; state: ControlState }
  | { type: 'admin-bans'; bans: BanSummary[] }
  | { type: 'radio-message'; slot: number; nickname: string; category: RadioChoice; direction: RadioChoice }
  | { type: 'voice-state'; state: VoiceState }
  | { type: 'voice-signal-delivery'; peerId: string; generation: number; signal: VoiceSignal };
