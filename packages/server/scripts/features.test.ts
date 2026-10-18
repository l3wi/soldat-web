import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { type Message } from '@soldat-web/protocol';
import { AuthoritativeMatch } from '../src/match.ts';
import { createGameServer } from '../src/server.ts';
import type { WorkerResponse } from '../src/worker-messages.ts';
import { qualificationConfig, RawPeer, delay } from './support.ts';

test('real native worker radio exact-team solo/spectator routing, server mute, pause AFK and same-map epochs', {timeout:60000}, async()=>{
  const config=await qualificationConfig(resolve('build-out/features/native'));
  const responses:WorkerResponse[]=[];
  const match=await AuthoritativeMatch.start({...config.match,botCount:0,mapRotation:['Arena'],allowedMaps:['Arena','Arena2'],rules:{mode:'dm',world:'fixture',rng:'keyed'},afkMs:1000},response=>responses.push(response));
  try {
    for(let slot=1;slot<=3;slot++) match.receive({type:'join',slot,weapon:4,secondaryWeapon:0,nickname:`Human ${slot}`},process.hrtime.bigint());
    match.step();
    match.receive({type:'force-team',slot:3,team:5},process.hrtime.bigint());
    responses.length=0;
    match.receive({type:'radio',slot:1,category:2,direction:3},process.hrtime.bigint());
    assert.deepEqual(responses.flatMap(r=>r.type==='send'&&r.message.type==='radio-message'?[r.slot]:[]),[1,2]);
    responses.length=0;
    match.receive({type:'radio',slot:3,category:1,direction:1},process.hrtime.bigint());
    assert.ok(responses.some(r=>r.type==='send'&&r.message.type==='notice')); assert.ok(!responses.some(r=>r.type==='send'&&r.message.type==='radio-message'));
    match.receive({type:'server-mute',slot:1,muted:true},process.hrtime.bigint()); responses.length=0;
    match.receive({type:'radio',slot:1,category:1,direction:1},process.hrtime.bigint()); match.receive({type:'chat',slot:1,channel:'public',text:'blocked'},process.hrtime.bigint());
    assert.ok(!responses.some(r=>r.type==='send'&&(r.message.type==='radio-message'||r.message.type==='chat-message')));
    match.receive({type:'pause',paused:true},process.hrtime.bigint()); const tick=match.tick;
    match.step(performance.now()+600000); assert.equal(match.tick,tick);
    responses.length=0; match.receive({type:'pause',paused:false},process.hrtime.bigint()); match.step();
    assert.ok(!responses.some(r=>r.type==='reject'&&r.reason.includes('AFK')));
    responses.length=0; match.receive({type:'map-control',restart:true},process.hrtime.bigint());
    const round=responses.find(r=>r.type==='round'); assert.ok(round&&round.type==='round'); assert.equal(round.map,'Arena'); assert.equal(round.roundEpoch,1);
    assert.equal(responses.filter(r=>r.type==='send'&&r.message.type==='state').length,3);
    responses.length=0; match.receive({type:'map-control',map:'not-allowed'},process.hrtime.bigint()); assert.equal(responses.length,0);
    match.receive({type:'map-control',map:'Arena2'},process.hrtime.bigint()); assert.ok(responses.some(r=>r.type==='round'&&r.map==='Arena2'));
    responses.length=0; match.receive({type:'map-control',restart:true},process.hrtime.bigint()); assert.ok(responses.some(r=>r.type==='round'&&r.map==='Arena2'));
    responses.length=0; match.receive({type:'map-control',next:true},process.hrtime.bigint()); assert.ok(responses.some(r=>r.type==='round'&&r.map==='Arena'));
  } finally { match.dispose(); }
});

test('real WSS host pause/resume ordering and voice signaling burst cannot consume ordinary control budget', {timeout:60000}, async()=>{
  const config=await qualificationConfig(resolve('build-out/features/network')); const errors:string[]=[];
  const server=await createGameServer({match:{...config.match,botCount:0,mapRotation:['Arena','Arena2']},tls:config.tls,port:0,host:'127.0.0.1',authorize:request=>({host:new URL(request.url!,'https://local').searchParams.get('testHost')==='yes'}),onError:error=>errors.push(error.message)});
  const address=server.httpsServer.address(); assert.ok(address&&typeof address!=='string');
  const url=`wss://127.0.0.1:${address.port}`,host=new RawPeer(`${url}?testHost=yes`),guest=new RawPeer(url);
  try {
    await host.connect(config.match.contentSetHash,'Host'); await guest.connect(config.match.contentSetHash,'Host');
    await host.waitFor((m):m is Extract<Message,{type:'control-state'}>=>m.type==='control-state'&&m.state.host);
    const guestControl=await guest.waitFor((m):m is Extract<Message,{type:'control-state'}>=>m.type==='control-state'); assert.equal(guestControl.state.host,false);
    let start=host.messages.length; host.send({type:'admin-action',action:{kind:'pause'}});
    await host.waitFor((m):m is Extract<Message,{type:'control-state'}>=>m.type==='control-state'&&m.state.paused,start);
    const paused=host.messages.slice(start); assert.ok(paused.findIndex(m=>m.type==='state')<paused.findIndex(m=>m.type==='control-state'&&m.state.paused));
    const count=host.messages.filter(m=>m.type==='ticks').length; await delay(100); assert.equal(host.messages.filter(m=>m.type==='ticks').length,count);
    start=host.messages.length; host.send({type:'admin-action',action:{kind:'unpause'}});
    await host.waitFor((m):m is Extract<Message,{type:'control-state'}>=>m.type==='control-state'&&!m.state.paused,start);
    const resumed=host.messages.slice(start); assert.ok(resumed.findIndex(m=>m.type==='state')<resumed.findIndex(m=>m.type==='control-state'&&!m.state.paused));
    host.send({type:'voice-configure',enabled:true,channel:'public',transmitting:false}); guest.send({type:'voice-configure',enabled:true,channel:'public',transmitting:false});
    const state=await host.waitFor((m):m is Extract<Message,{type:'voice-state'}>=>m.type==='voice-state'&&m.state.enabled&&m.state.peers.length===1);
    const peerId=state.state.peers[0]!.id, generation=state.state.peers[0]!.generation; const guestAt=guest.messages.length;
    for(let i=0;i<80;i++) host.send({type:'voice-signal',peerId,generation,signal:{kind:'candidate',candidate:'candidate:1 1 UDP 1 127.0.0.1 5000 typ host',sdpMid:'0',sdpMLineIndex:0}});
    await guest.waitFor((m):m is Extract<Message,{type:'voice-signal-delivery'}>=>m.type==='voice-signal-delivery',guestAt);
    start=host.messages.length; host.send({type:'admin-action',action:{kind:'pause'}});
    await host.waitFor((m):m is Extract<Message,{type:'control-state'}>=>m.type==='control-state'&&m.state.paused,start);
    let voiceStart=guest.messages.length;
    host.send({type:'voice-configure',enabled:false,channel:'public',transmitting:false});
    await guest.waitFor((m):m is Extract<Message,{type:'voice-state'}>=>m.type==='voice-state'&&m.state.peers.length===0,voiceStart);
    const hostVoiceStart=host.messages.length;
    host.send({type:'voice-configure',enabled:true,channel:'public',transmitting:false});
    const renewed=await host.waitFor((m):m is Extract<Message,{type:'voice-state'}>=>m.type==='voice-state'&&m.state.peers.length===1&&m.state.peers[0]!.generation!==generation,hostVoiceStart);
    const renewedGeneration=renewed.state.peers[0]!.generation;
    await guest.waitFor((m):m is Extract<Message,{type:'voice-state'}>=>m.type==='voice-state'&&m.state.peers.some(peer=>peer.generation===renewedGeneration),voiceStart);
    voiceStart=guest.messages.length;
    const signal={kind:'candidate' as const,candidate:'candidate:1 1 UDP 1 127.0.0.1 5000 typ host',sdpMid:'0',sdpMLineIndex:0};
    host.send({type:'voice-signal',peerId,generation,signal});
    host.send({type:'voice-signal',peerId,generation:renewedGeneration,signal});
    await guest.waitFor((m):m is Extract<Message,{type:'voice-signal-delivery'}>=>m.type==='voice-signal-delivery'&&m.generation===renewedGeneration,voiceStart);
    assert.ok(guest.messages.slice(voiceStart).every(m=>m.type!=='voice-signal-delivery'||m.generation===renewedGeneration),'Revoked-generation signaling must not cross a renewed pair relationship');
    assert.equal(host.closed,undefined); assert.deepEqual(errors,[]);
  } finally { await Promise.all([host.close(),guest.close()]); await server.close(); }
});
