import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Message } from '@soldat-web/protocol';
import { MatchAuthority, validateOperatorToken, type AuthorityPlayer } from './authority.ts';
import { BanStore } from './bans.ts';
import type { WorkerRequest } from './worker-messages.ts';
const token='c32deaf9758c683b3d3d1b8214e5f84a';
function players():AuthorityPlayer[] { return Array.from({length:3},(_,i)=>({id:`nonce-${i}`,address:`127.0.0.${i+1}`,slot:i+1,nickname:i===1?'Host':'Player',joinedAt:0,host:i===0,admin:false,muted:false,team:0})); }
test('no default operator secret, no nickname authority, host match-only bans and operator global bans/unban use opaque IDs',async()=>{
  assert.throws(()=>validateOperatorToken('short'),/32/);
  const roster=players(),sent:{slot:number;message:Message}[]=[],commands:WorkerRequest[]=[],kicked:number[]=[];
  const bans=await BanStore.load();
  const authority=await MatchAuthority.create({players:()=>roster,send:(slot,message)=>sent.push({slot,message}),disconnect:slot=>kicked.push(slot),worker:m=>commands.push(m),maps:['Arena','Arena2'],mode:'dm',operatorToken:token,bans,onError:error=>assert.fail(error.message)});
  try {
    authority.membership();
    await authority.receive(roster[1]!,{type:'admin-action',action:{kind:'pause'}}); assert.equal(commands.length,0);
    await authority.receive(roster[1]!,{type:'admin-auth',token:'wrong'}); assert.equal(roster[1]!.admin,false);
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'ban',slot:3,minutes:10,reason:'local'}});
    assert.equal(authority.blocked(roster[2]!.address),true); assert.equal(bans.contains(roster[2]!.address),false);
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'bans'}});
    const local=sent.flatMap(m=>m.message.type==='admin-bans'?m.message.bans:[]).at(-1)!; assert.equal(local.global,false); assert.equal('address' in local,false);
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'unban',id:local.id}}); assert.equal(authority.blocked(roster[2]!.address),false);
    await authority.receive(roster[1]!,{type:'admin-auth',token}); assert.equal(roster[1]!.admin,true);
    await authority.receive(roster[1]!,{type:'admin-action',action:{kind:'ban',slot:3,minutes:10,reason:'global'}}); assert.equal(bans.contains(roster[2]!.address),true); assert.ok(kicked.includes(3));
    const global=bans.summaries()[0]!;
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'unban',id:global.id}}); assert.equal(bans.contains(roster[2]!.address),true);
    await authority.receive(roster[1]!,{type:'admin-action',action:{kind:'unban',id:global.id}}); assert.equal(bans.contains(roster[2]!.address),false);
    await authority.receive(roster[1]!,{type:'admin-logout'}); assert.equal(roster[1]!.admin,false);
    assert.equal(JSON.stringify(sent).includes(token),false);
  } finally { authority.close(); }
});
test('native map/team commands are allowlisted and pause state only changes on worker acknowledgement; server mute suppresses radio',async()=>{
  const roster=players(),commands:WorkerRequest[]=[],sent:Message[]=[];
  const authority=await MatchAuthority.create({players:()=>roster,send:(_slot,m)=>sent.push(m),disconnect:()=>{},worker:m=>commands.push(m),maps:['Arena','Arena2'],mode:'ctf',bans:await BanStore.load(),onError:error=>assert.fail(error.message)});
  try {
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'map',map:'../../bad'}}); assert.equal(commands.length,0);
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'team',slot:2,team:0}}); assert.equal(commands.length,0);
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'team',slot:2,team:2}}); assert.deepEqual(commands.pop(),{type:'force-team',slot:2,team:2});
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'pause'}}); assert.equal(authority.paused,false); authority.pauseChanged(true); assert.equal(authority.paused,true);
    await authority.receive(roster[1]!,{type:'gesture',gesture:'smoke'}); assert.ok(!commands.some(m=>m.type==='gesture'));
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'mute',slot:2}}); assert.equal(roster[1]!.muted,true); const before=commands.length;
    await authority.receive(roster[1]!,{type:'radio',category:1,direction:1}); assert.equal(commands.length,before);
    const replacement={...roster[1]!,id:'new-admission',muted:false}; roster[1]=replacement; authority.membership(); assert.equal(replacement.muted,true);
    await authority.receive(roster[0]!,{type:'admin-action',action:{kind:'unmute',slot:2}}); assert.equal(replacement.muted,false);
    await authority.receive(replacement,{type:'radio',category:3,direction:2}); assert.deepEqual(commands.at(-1),{type:'radio',slot:2,category:3,direction:2});
    assert.ok(sent.some(m=>m.type==='notice'));
  } finally { authority.close(); }
});
test('ban persistence serializes concurrent changes, reloads IPv6 quota identities and removes real IDs; malformed disk is rejected',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'soldat-bans-')); const file=join(directory,'bans.json');
  try {
    const store=await BanStore.load(file);
    const [a,b]=await Promise.all([store.add('127.0.0.1','One',10,'first',true),store.add('2001:db8:abcd:12::/64','Two',10,'second',true)]);
    assert.equal((await BanStore.load(file)).summaries().length,2);
    assert.equal(await store.remove(a.id),true); assert.equal(await store.remove('unknown'),false);
    const loaded=await BanStore.load(file); assert.equal(loaded.contains('127.0.0.1'),false); assert.equal(loaded.contains('2001:db8:abcd:12::/64'),true); assert.equal(loaded.summaries()[0]!.id,b.id);
    const raw=JSON.parse(await readFile(file,'utf8')); raw[0].global=false; await writeFile(file,JSON.stringify(raw)); await assert.rejects(BanStore.load(file),/Invalid ban file/);
  } finally { await rm(directory,{recursive:true,force:true}); }
});
