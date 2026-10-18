import type { VoteProposal, VoteState } from '@soldat-web/protocol';
export interface Voter { id:string; address:string; slot:number; nickname:string; joinedAt:number; protected:boolean }
interface Ballot { id:number; proposal:VoteProposal; initiator:string; targetLabel:string; targetId?:string; electorate:Set<string>; votes:Map<string,'yes'|'no'>; required:number; deadline:number; phase:VoteState['phase']; reason:string }
/** Original 20-second voting / 2-minute cooldown and 60% quorum, with frozen admission identities. */
export class MatchVoting {
  private ballot?:Ballot;
  private nextId=0;
  private lastStart=-Infinity;
  private readonly changed: () => void;
  private readonly passed: (proposal:VoteProposal,targetId?:string) => void;
  private readonly now: () => number;
  constructor(changed:()=>void, passed:(proposal:VoteProposal,targetId?:string)=>void, now:()=>number=Date.now) {
    this.changed=changed; this.passed=passed; this.now=now;
  }
  start(initiator:Voter, proposal:VoteProposal, players:Voter[]):string|null {
    const now=this.now();
    if(this.ballot?.phase==='active') return 'A vote is already running.';
    if(now-this.lastStart<120000) return 'Please wait two minutes between votes.';
    if(now-initiator.joinedAt<10000) return 'Join the match for ten seconds before starting a vote.';
    // Freeze established admission nonces: NAT addresses are not human identity.
    const electorate=new Set(players.filter(player=>now-player.joinedAt>=10000).map(player=>player.id));
    if(electorate.size<3) return 'Voting requires at least three established human players.';
    if(!electorate.has(initiator.id)) return 'This connection was not eligible when voting started.';
    const target=proposal.kind==='kick'?players.find(p=>p.slot===proposal.slot):undefined;
    if(proposal.kind==='kick'&&(!target||target.id===initiator.id||target.protected)) return 'That player cannot be vote-kicked.';
    this.lastStart=now;
    this.ballot={id:++this.nextId,proposal,initiator:initiator.nickname,targetLabel:target?.nickname??(proposal.kind==='map'?proposal.map:''),...(target?{targetId:target.id}:{}),electorate,votes:new Map([[initiator.id,'yes']]),required:Math.ceil(electorate.size*.6),deadline:now+20000,phase:'active',reason:''};
    this.changed(); this.evaluate(); return null;
  }
  cast(id:string,voteId:number,choice:'yes'|'no'):string|null {
    const b=this.ballot;
    if(!b||b.phase!=='active'||b.id!==voteId||this.now()>=b.deadline) return 'That vote is no longer active.';
    if(!b.electorate.has(id)) return 'You were not eligible when this vote started.';
    if(id === b.targetId) return 'The kick target cannot cast a ballot.';
    if(b.votes.has(id)) return 'Your ballot has already been recorded.';
    b.votes.set(id,choice); this.changed(); this.evaluate(); return null;
  }
  state(id:string):VoteState|null {
    const b=this.ballot; if(!b) return null;
    const yes=[...b.votes.values()].filter(v=>v==='yes').length;
    return {id:b.id,proposal:b.proposal,initiator:b.initiator,targetLabel:b.targetLabel,yes,no:b.votes.size-yes,eligible:b.electorate.size,required:b.required,remainingMs:Math.max(0,b.deadline-this.now()),myVote:b.votes.get(id)??null,canVote:b.phase==='active'&&b.electorate.has(id)&&id!==b.targetId&&!b.votes.has(id),phase:b.phase,reason:b.reason};
  }
  tick():void { if(this.ballot?.phase==='active') { this.evaluate(); this.changed(); } }
  membership(players:Voter[]):void { const b=this.ballot; if(b?.phase==='active'&&b.targetId) { const target=players.find(p=>p.id===b.targetId); if(!target||target.protected) this.cancel(!target?'Target left the match.':'Target gained administrator protection.'); } }
  cancel(reason:string):void { if(this.ballot?.phase==='active') { this.ballot.phase='cancelled'; this.ballot.reason=reason; this.changed(); } }
  private evaluate():void {
    const b=this.ballot; if(!b||b.phase!=='active') return;
    const yes=[...b.votes.values()].filter(v=>v==='yes').length;
    if(yes>=b.required) { b.phase='passed'; b.reason='Vote passed.'; this.changed(); this.passed(b.proposal,b.targetId); }
    else if(this.now()>=b.deadline||yes+b.electorate.size-b.votes.size-(b.targetId&&b.electorate.has(b.targetId)?1:0)<b.required) { b.phase='failed'; b.reason=this.now()>=b.deadline?'Voting time expired without quorum.':'Not enough yes votes remain.'; this.changed(); }
  }
}
