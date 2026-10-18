import { ProtocolError } from './messages.ts';
import type { FeatureClientMessage, FeatureServerMessage } from './features.ts';
import { wellFormed } from './text.ts';
const encoder = new TextEncoder();
export const CLIENT_FEATURE_TYPES = ['gesture', 'self-kill', 'admin-auth', 'admin-logout', 'admin-action', 'vote-start', 'vote-cast', 'radio', 'voice-configure', 'voice-signal'] as const;
export const SERVER_FEATURE_TYPES = ['control-state', 'admin-bans', 'radio-message', 'voice-state', 'voice-signal-delivery'] as const;
export const FEATURE_TYPES = [...CLIENT_FEATURE_TYPES, ...SERVER_FEATURE_TYPES];
export const MAX_FEATURE_BYTES = 60000;
type Obj = Record<string, any>;
function fail(): never { throw new ProtocolError('VALUE', 'Invalid feature payload'); }
function object(v: unknown, fields: string[]): asserts v is Obj { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) fail(); }
function str(v: unknown, max: number, empty = false): asserts v is string { if (typeof v !== 'string' || (!empty && !v.length) || !wellFormed(v) || encoder.encode(v).length > max || /[\p{Cc}\p{Cf}]/u.test(v)) fail(); }
function num(v: unknown, min: number, max: number): void { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail(); }
function bool(v: unknown): void { if (typeof v !== 'boolean') fail(); }
function one(v: unknown, values: unknown[]): void { if (!values.includes(v)) fail(); }
function proposal(v: unknown): void { object(v, ['kind','slot','reason','map']); if (v.kind === 'kick') { num(v.slot,1,32); str(v.reason,256,true); if ('map' in v) fail(); } else if (v.kind === 'map') { str(v.map,128); if ('slot' in v || 'reason' in v) fail(); } else fail(); }
function action(v: unknown): void {
  object(v,['kind','slot','reason','minutes','id','team','map']);
  const fields: Record<string,string[]> = {kick:['slot','reason'],ban:['slot','reason','minutes'],unban:['id'],bans:[],mute:['slot'],unmute:['slot'],team:['slot','team'],kill:['slot'],map:['map'],nextmap:[],restart:[],pause:[],unpause:[]};
  if (typeof v.kind !== 'string' || !Object.hasOwn(fields, v.kind) || Object.keys(v).some(k => k !== 'kind' && !fields[v.kind]!.includes(k))) fail();
  for (const key of fields[v.kind]!) if (!(key in v)) fail();
  if ('slot' in v) num(v.slot,1,32); if ('reason' in v) str(v.reason,256,true); if ('minutes' in v) num(v.minutes,1,43200); if ('id' in v) str(v.id,64); if ('team' in v) num(v.team,0,5); if ('map' in v) str(v.map,128);
}
function signal(v: unknown): void {
  object(v,['kind','sdp','candidate','sdpMid','sdpMLineIndex']);
  if (v.kind === 'offer' || v.kind === 'answer') { if (Object.keys(v).some(k=>!['kind','sdp'].includes(k)) || typeof v.sdp !== 'string' || !wellFormed(v.sdp) || encoder.encode(v.sdp).length > 32768 || !v.sdp.length) fail(); }
  else if (v.kind === 'candidate') { if ('sdp' in v) fail(); str(v.candidate,2048,true); if (v.sdpMid !== null) str(v.sdpMid,128,true); if (v.sdpMLineIndex !== null) num(v.sdpMLineIndex,0,255); } else fail();
}
function vote(v: unknown): void {
  object(v,['id','proposal','initiator','targetLabel','yes','no','eligible','required','remainingMs','myVote','canVote','phase','reason']);
  num(v.id,1,0xffffffff); proposal(v.proposal); str(v.initiator,48); str(v.targetLabel,128); for (const key of ['yes','no','eligible','required']) num(v[key],0,32); num(v.remainingMs,0,20000); one(v.myVote,['yes','no',null]); bool(v.canVote); one(v.phase,['active','passed','failed','cancelled']); str(v.reason,256,true);
}
export function validateFeature(value: unknown): asserts value is FeatureClientMessage | FeatureServerMessage {
  object(value,['type','gesture','token','action','proposal','id','choice','category','direction','enabled','channel','transmitting','peerId','generation','signal','state','bans','slot','nickname']);
  const m = value;
  const fields: Record<string,string[]> = {gesture:['gesture'],'self-kill':[],'admin-auth':['token'],'admin-logout':[],'admin-action':['action'],'vote-start':['proposal'],'vote-cast':['id','choice'],radio:['category','direction'],'voice-configure':['enabled','channel','transmitting'],'voice-signal':['peerId','generation','signal'],'control-state':['state'],'admin-bans':['bans'],'radio-message':['slot','nickname','category','direction'],'voice-state':['state'],'voice-signal-delivery':['peerId','generation','signal']};
  if (typeof m.type !== 'string' || !Object.hasOwn(fields, m.type) || Object.keys(m).some(k=>k!=='type'&&!fields[m.type]!.includes(k))) fail();
  for(const key of fields[m.type]!) if (!(key in m)) fail();
  switch(m.type) {
    case 'gesture': one(m.gesture,['smoke','tabac','takeoff','victory']); break;
    case 'admin-auth': str(m.token,256); break;
    case 'admin-action': action(m.action); break;
    case 'vote-start': proposal(m.proposal); break;
    case 'vote-cast': num(m.id,1,0xffffffff); one(m.choice,['yes','no']); break;
    case 'radio-message': num(m.slot,1,32); str(m.nickname,48);
    case 'radio': num(m.category,1,3); num(m.direction,1,3); break;
    case 'voice-configure': bool(m.enabled); bool(m.transmitting); one(m.channel,['public','team']); break;
    case 'voice-signal': case 'voice-signal-delivery': str(m.peerId,64); num(m.generation,1,Number.MAX_SAFE_INTEGER); signal(m.signal); break;
    case 'control-state': { const s=m.state; object(s,['host','admin','paused','muted','vote']); for(const key of ['host','admin','paused','muted']) bool(s[key]); if(s.vote!==null) vote(s.vote); break; }
    case 'admin-bans': if(!Array.isArray(m.bans)||m.bans.length>512) fail(); for(const b of m.bans) { object(b,['id','nickname','reason','expiresAt','global']); str(b.id,64); str(b.nickname,48); str(b.reason,256,true); num(b.expiresAt,0,Number.MAX_SAFE_INTEGER); bool(b.global); } break;
    case 'voice-state': {
      const s=m.state; object(s,['selfId','enabled','transmitting','channel','muted','peers','configuration']);
      str(s.selfId,64); bool(s.enabled); bool(s.transmitting); bool(s.muted); one(s.channel,['public','team']);
      if(!Array.isArray(s.peers)||s.peers.length>31) fail();
      for(const p of s.peers) {
        object(p,['id','generation','slot','nickname','canSend','canReceive','talking']);
        str(p.id,64); num(p.generation,1,Number.MAX_SAFE_INTEGER); num(p.slot,1,32); str(p.nickname,48); bool(p.canSend); bool(p.canReceive); bool(p.talking);
      }
      const c=s.configuration; object(c,['enabled','iceServers','relayOnly']); bool(c.enabled); bool(c.relayOnly);
      if(!Array.isArray(c.iceServers)||c.iceServers.length>9) fail();
      for(const ice of c.iceServers) {
        object(ice,['urls','username','credential']);
        if(!Array.isArray(ice.urls)||ice.urls.length>8) fail();
        for(const url of ice.urls) str(url,1024);
        if(ice.username!==undefined) str(ice.username,512,true);
        if(ice.credential!==undefined) str(ice.credential,512,true);
      }
      break;
    }
  }
}
export function isClientFeature(message: {type:string}): message is FeatureClientMessage { return (CLIENT_FEATURE_TYPES as readonly string[]).includes(message.type); }
export function isServerFeature(message: {type:string}): message is FeatureServerMessage { return (SERVER_FEATURE_TYPES as readonly string[]).includes(message.type); }
