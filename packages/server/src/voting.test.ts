import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchVoting, type Voter } from './voting.ts';
const voters:Voter[]=Array.from({length:5},(_,i)=>({id:`nonce-${i}`,address:`127.0.0.${i+1}`,slot:i+1,nickname:`Human ${i}`,joinedAt:0,protected:false}));
test('votes freeze real human admission identities, reject duplicates and late joins, and require original60% quorum',()=>{
  let now=10000,passes=0;
  const vote=new MatchVoting(()=>{},()=>passes++,()=>now);
  assert.equal(vote.start(voters[0]!,{kind:'map',map:'Arena'},voters),null);
  const state=vote.state(voters[0]!.id)!; assert.equal(state.required,3); assert.equal(state.eligible,5); assert.equal(state.yes,1);
  assert.match(vote.cast(voters[0]!.id,state.id,'no')!,/already/);
  assert.match(vote.cast('late-nonce',state.id,'yes')!,/eligible/);
  assert.equal(vote.cast(voters[1]!.id,state.id,'yes'),null); assert.equal(passes,0);
  assert.equal(vote.cast(voters[2]!.id,state.id,'yes'),null); assert.equal(passes,1); assert.equal(vote.state('any')!.phase,'passed');
  assert.match(vote.start(voters[1]!,{kind:'map',map:'Arena'},voters)!,/two minutes/);
  now=130000; assert.equal(vote.start(voters[1]!,{kind:'map',map:'Arena'},voters),null);
});
test('minimum and establishment exclude fresh admissions without penalizing shared NAT',()=>{
  const vote=new MatchVoting(()=>{},()=>{},()=>10000);
  assert.match(vote.start(voters[0]!,{kind:'map',map:'Arena'},voters.slice(0,2))!,/three/);
  assert.match(vote.start({...voters[0]!,joinedAt:1},{kind:'map',map:'Arena'},voters)!,/ten seconds/);
  assert.equal(vote.start(voters[0]!,{kind:'map',map:'Arena'},voters.map(v=>({...v,address:'127.0.0.1'}))),null);
});
test('kick target departure/slot reuse or gaining host/operator protection cancels instead of targeting the replacement',()=>{
  const vote=new MatchVoting(()=>{},()=>assert.fail('must not execute'),()=>10000);
  const proposal={kind:'kick' as const,slot:2,reason:'abuse'};
  assert.equal(vote.start(voters[0]!,proposal,voters),null);
  vote.membership(voters.map(v=>v.slot===2?{...v,id:'replacement-nonce'}:v));
  assert.equal(vote.state('any')!.phase,'cancelled'); assert.match(vote.state('any')!.reason,/left/);
  const protectedVote=new MatchVoting(()=>{},()=>assert.fail('must not execute'),()=>10000);
  assert.match(protectedVote.start(voters[0]!,proposal,voters.map(v=>({...v,protected:v.slot===2})))!,/cannot/);
  assert.equal(protectedVote.start(voters[0]!,proposal,voters),null);
  protectedVote.membership(voters.map(v=>({...v,protected:v.slot===2}))); assert.equal(protectedVote.state('any')!.phase,'cancelled');
});
test('deadline and impossible quorum produce deterministic visible failures; map cancellation keeps ballots closed',()=>{
  let now=10000; const vote=new MatchVoting(()=>{},()=>assert.fail('must not pass'),()=>now);
  vote.start(voters[0]!,{kind:'map',map:'Arena'},voters); now=30000; vote.tick(); assert.equal(vote.state('any')!.phase,'failed'); assert.equal(vote.state('any')!.remainingMs,0);
  now=130000; vote.start(voters[0]!,{kind:'map',map:'Arena'},voters); const id=vote.state('any')!.id;
  for(const v of voters.slice(1,4)) vote.cast(v.id,id,'no'); assert.equal(vote.state('any')!.phase,'failed');
  now=250000; vote.start(voters[0]!,{kind:'map',map:'Arena'},voters); vote.cancel('Map changed.'); assert.equal(vote.state('any')!.phase,'cancelled'); assert.match(vote.cast(voters[1]!.id,vote.state('any')!.id,'yes')!,/no longer/);
});

test('three established friends behind one NAT can kick with two yes votes but target cannot ballot',()=>{
  const friends=voters.slice(0,3).map(v=>({...v,address:'127.0.0.1'})); let passed=false;
  const vote=new MatchVoting(()=>{},()=>{passed=true;},()=>10000);
  assert.equal(vote.start(friends[0]!,{kind:'kick',slot:2,reason:''},friends),null);
  const state=vote.state(friends[1]!.id)!; assert.equal(state.eligible,3); assert.equal(state.required,2); assert.equal(state.canVote,false);
  assert.match(vote.cast(friends[1]!.id,state.id,'yes')!,/target/);
  assert.equal(vote.cast(friends[2]!.id,state.id,'yes'),null); assert.equal(passed,true);
});
