import { createHash, timingSafeEqual } from 'node:crypto';
import { validateTeam, type FeatureClientMessage, type GameMode, type Message } from '@soldat-web/protocol';
import { BanStore } from './bans.ts';
import { MatchVoting, type Voter } from './voting.ts';
import type { WorkerRequest } from './worker-messages.ts';
import { VoiceRelay, type VoiceOperatorConfiguration } from './voice.ts';
export interface AuthorityPlayer { id:string; address:string; slot:number; nickname:string; joinedAt:number; host:boolean; admin:boolean; muted:boolean; team:number }
export interface AuthorityOptions {
  players:()=>AuthorityPlayer[]; send:(slot:number,message:Message)=>void; disconnect:(slot:number,reason:string)=>void;
  worker:(message:WorkerRequest)=>void; maps:string[]; mode:GameMode; operatorToken?:string; bans:BanStore; voice?:VoiceOperatorConfiguration; onError:(error:Error)=>void;
}
export function validateOperatorToken(token:unknown):void { if(token!==undefined&&(typeof token!=='string'||Buffer.byteLength(token)<32||Buffer.byteLength(token)>256||/[\p{Cc}\p{Cf}]/u.test(token))) throw new Error('operatorToken must contain 32..256 UTF-8 bytes without controls'); }
export class MatchAuthority {
  private readonly voting:MatchVoting;
  private readonly voice:VoiceRelay;
  private readonly token?:Buffer;
  private readonly muted=new Set<string>();
  private readonly radioAt = new Map<string, number>();
  private readonly admitted = new Set<string>();
  private readonly local:BanStore;
  private readonly timer:NodeJS.Timeout;
  private busy=new Set<string>();
  paused=false;
  private desiredPause=false;
  private voiceEpoch = 0;
  private readonly o: AuthorityOptions;
  private constructor(o:AuthorityOptions,local:BanStore) {
    this.o = o;
    this.local=local; validateOperatorToken(o.operatorToken);
    if(o.operatorToken) this.token=createHash('sha256').update(o.operatorToken).digest();
    this.voice=new VoiceRelay({send:(id,message)=>{ const p=o.players().find(p=>p.id===id); if(p) o.send(p.slot,message); },...(o.voice?{configuration:o.voice}:{})});
    this.voting=new MatchVoting(()=>this.publish(),(proposal,targetId)=>{
      if(proposal.kind==='map') o.worker({type:'map-control',map:proposal.map});
      else {
        const target=o.players().find(p=>p.id===targetId);
        if(target&&!target.host&&!target.admin) void this.local.add(target.address,target.nickname,60,proposal.reason,false).then(() => {
          const admitted = o.players().find(player => player.id === target.id);
          if (admitted) o.disconnect(admitted.slot,'Vote-kicked; match rejoin blocked for one hour');
        }).catch(error => {
          o.onError(error instanceof Error ? error : new Error(String(error)));
          for (const player of o.players()) this.notice(player.slot,'Vote passed, but the match ban could not be applied.');
        });
      }
    });
    this.timer=setInterval(() => { this.voting.tick(); this.voice.tick(); },1000); this.timer.unref();
  }
  static async create(options:AuthorityOptions):Promise<MatchAuthority> { return new MatchAuthority(options,await BanStore.load()); }
  blocked(address:string):boolean { return this.o.bans.contains(address)||this.local.contains(address); }
  private notice(slot:number,text:string,id?:string):void {
    if (id && !this.o.players().some(player => player.slot === slot && player.id === id)) return;
    this.o.send(slot,{type:'notice',text});
  }
  publish():void {
    for(const p of this.o.players()) {
      const vote = this.voting.state(p.id);
      if (vote && (p.team === 5 || p.muted)) vote.canVote = false;
      this.o.send(p.slot,{type:'control-state',state:{host:p.host,admin:p.admin,paused:this.paused,muted:p.muted,vote}});
    }
  }
  membership(epoch?:number):void {
    if (epoch !== undefined) this.voiceEpoch = epoch;
    const players=this.o.players();
    for(const p of players) {
      if (this.admitted.has(p.id)) continue;
      this.admitted.add(p.id);
      if(this.muted.has(p.address)) { p.muted=true; this.o.worker({type:'server-mute',slot:p.slot,muted:true}); }
    }
    this.voting.membership(this.voters()); this.voice.sync(players,this.voiceEpoch); this.publish();
  }
  departed(id:string):void { this.voice.remove(id); this.radioAt.delete(id); this.admitted.delete(id); this.busy.delete(id); this.membership(); }
  round(epoch:number):void { this.voting.cancel('Map changed.'); this.membership(epoch); }
  pauseChanged(paused:boolean):void { this.paused=paused; this.desiredPause=paused; this.publish(); }
  private voters():Voter[] { return this.o.players().filter(p => p.team !== 5).map(p=>({...p,protected:p.host||p.admin})); }
  async receive(p:AuthorityPlayer,m:FeatureClientMessage):Promise<void> {
    if (!this.o.players().some(player => player === p)) return;
    if(m.type==='voice-signal') { const denial=this.voice.signal(p.id,m.peerId,m.generation,m.signal); if(denial) this.notice(p.slot,denial); return; }
    if(m.type==='voice-configure') { const denial=this.voice.configure(p.id,m); if(denial) this.notice(p.slot,denial); return; }
    if(m.type==='admin-auth') {
      const digest=createHash('sha256').update(m.token).digest();
      if(!this.token||!timingSafeEqual(this.token,digest)) { this.notice(p.slot,'Administrator authentication failed.'); return; }
      p.admin=true; this.membership(); this.notice(p.slot,'Authenticated as server operator.'); return;
    }
    if(m.type==='admin-logout') { p.admin=false; this.membership(); this.notice(p.slot,'Operator privileges cleared.'); return; }
    if(m.type==='gesture'||m.type==='self-kill') { if(this.paused||this.desiredPause) { this.notice(p.slot,'The match is paused.'); return; } this.o.worker(m.type==='gesture'?{type:'gesture',slot:p.slot,gesture:m.gesture}:{type:'player-kill',slot:p.slot}); return; }
    if(m.type==='radio') {
      if(p.muted) this.notice(p.slot,'You are server-muted.');
      else if(p.team===5) this.notice(p.slot,'Spectators cannot send team radio.');
      else if(Date.now()-(this.radioAt.get(p.id)??-Infinity)<3000) this.notice(p.slot,'Wait three seconds between radio messages.');
      else { this.radioAt.set(p.id,Date.now()); this.o.worker({type:'radio',slot:p.slot,category:m.category,direction:m.direction}); }
      return;
    }
    if(m.type==='vote-start') {
      if(m.proposal.kind==='map'&&!this.o.maps.includes(m.proposal.map)) { this.notice(p.slot,'Map is not in this match’s compatible catalog.'); return; }
      const voter=this.voters().find(v=>v.id===p.id);
      if(!voter || p.muted) { this.notice(p.slot,'Spectators and server-muted players cannot start votes.'); return; }
      const denial=this.voting.start(voter,m.proposal,this.voters()); if(denial) this.notice(p.slot,denial); return;
    }
    if(m.type==='vote-cast') {
      if(p.muted || p.team === 5) { this.notice(p.slot,'Spectators and server-muted players cannot vote.'); return; }
      const denial=this.voting.cast(p.id,m.id,m.choice); if(denial) this.notice(p.slot,denial); return;
    }
    if(m.type!=='admin-action') return;
    if(!p.host&&!p.admin) { this.notice(p.slot,'Host or operator privileges are required.'); return; }
    if(this.busy.has(p.id)) { this.notice(p.slot,'Wait for your pending administration action.'); return; }
    const a=m.action;
    const target='slot' in a?this.o.players().find(q=>q.slot===a.slot):undefined;
    if('slot' in a&&(!target||target.id===p.id||(!p.admin&&(target.host||target.admin)))) { this.notice(p.slot,'Invalid or protected administrator target.'); return; }
    try {
      switch(a.kind) {
        case 'bans': this.o.send(p.slot,{type:'admin-bans',bans:[...(p.admin?this.o.bans.summaries():[]),...this.local.summaries()]}); break;
        case 'unban': {
          this.busy.add(p.id);
          const local=this.local.summaries().some(b=>b.id===a.id);
          if(!local&&!p.admin) { this.notice(p.slot,'Hosts can only remove their match’s bans.'); break; }
          const removed=await (local?this.local:this.o.bans).remove(a.id);
          this.notice(p.slot,removed?'Ban removed.':'Unknown ban ID.',p.id); break;
        }
        case 'ban': {
          this.busy.add(p.id);
          const global = p.admin;
          const store=global?this.o.bans:this.local;
          await store.add(target!.address,target!.nickname,a.minutes,a.reason,global);
          const admitted = this.o.players().find(player => player.id === target!.id);
          if (admitted) this.o.disconnect(admitted.slot,'Banned by administrator');
          this.notice(p.slot,global?'Global ban applied.':'Match-only ban applied.',p.id); break;
        }
        case 'kick': this.o.disconnect(target!.slot,'Kicked by administrator'); break;
        case 'mute': case 'unmute': {
          if(a.kind==='mute') {
            if(this.muted.size>=256&&!this.muted.has(target!.address)) { this.notice(p.slot,'Match mute capacity reached; unmute a source first.'); break; }
            this.muted.add(target!.address);
          } else this.muted.delete(target!.address);
          target!.muted = a.kind === 'mute';
          this.o.worker({type:'server-mute',slot:target!.slot,muted:target!.muted});
          this.membership(); this.notice(p.slot,a.kind==='mute'?'Player server-muted.':'Player server-unmuted.'); break;
        }
        case 'team': try { validateTeam(a.team,this.o.mode); this.o.worker({type:'force-team',slot:target!.slot,team:a.team}); } catch { this.notice(p.slot,'Invalid team for this game mode.'); } break;
        case 'kill': this.o.worker({type:'player-kill',slot:target!.slot}); break;
        case 'map': if(!this.o.maps.includes(a.map)) this.notice(p.slot,'Map is not in this match’s compatible catalog.'); else this.o.worker({type:'map-control',map:a.map}); break;
        case 'nextmap': this.o.worker({type:'map-control',next:true}); break;
        case 'restart': this.o.worker({type:'map-control',restart:true}); break;
        case 'pause': case 'unpause': this.desiredPause=a.kind==='pause'; this.o.worker({type:'pause',paused:this.desiredPause}); break;
      }
    } catch(error) { this.o.onError(error instanceof Error?error:new Error(String(error))); if(this.o.players().some(q=>q.id===p.id)) this.notice(p.slot,'Administration action failed; no success was recorded.'); }
    finally { this.busy.delete(p.id); }
  }
  close():void { clearInterval(this.timer); this.voice.close(); }
}
