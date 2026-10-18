import assert from 'node:assert/strict';
import test from 'node:test';
import { MatchAuthority, type AuthorityPlayer } from './authority.ts';
import { BanStore } from './bans.ts';

test('match and global address bans eject only the selected admission, preserving already-admitted NAT peers and host unban access',async()=>{
  for(const global of [false,true]) {
    const roster:AuthorityPlayer[]=Array.from({length:3},(_,i)=>({id:`nonce-${i}`,address:'127.0.0.1',slot:i+1,nickname:`Human ${i}`,joinedAt:0,host:i===0,admin:i===0&&global,muted:false,team:0}));
    const kicked:number[]=[]; const bans=await BanStore.load();
    const authority=await MatchAuthority.create({players:()=>roster,send:()=>{},disconnect:slot=>kicked.push(slot),worker:()=>{},maps:['Arena'],mode:'dm',bans,onError:error=>assert.fail(error.message)});
    try {
      authority.membership();
      await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'ban',slot:2,minutes:60,reason:'abuse'}});
      assert.deepEqual(kicked,[2]); assert.equal(authority.blocked('127.0.0.1'),true); assert.equal(bans.contains('127.0.0.1'),global);
      await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'mute',slot:3}});
      assert.equal(roster[0]!.muted,false); assert.equal(roster[1]!.muted,false); assert.equal(roster[2]!.muted,true);
    } finally { authority.close(); }
  }
});
