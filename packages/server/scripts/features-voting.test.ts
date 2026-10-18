import assert from 'node:assert/strict';
import { once } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { type Message } from '@soldat-web/protocol';
import { createGameServer } from '../src/server.ts';
import { qualificationConfig, RawPeer, delay } from './support.ts';

test('three real shared-NAT WSS humans can pass map or kick votes; kick ban prevents immediate retry', {timeout:60000}, async(t)=>{
  const config=await qualificationConfig(resolve('build-out/features/voting'));
  for(const kind of ['map','kick'] as const) {
    const errors:string[]=[];
    const server=await createGameServer({match:{...config.match,botCount:0,mapRotation:['Arena'],allowedMaps:['Arena','Arena2']},tls:config.tls,host:'127.0.0.1',port:0,onError:error=>errors.push(error.message)});
    const address=server.httpsServer.address(); assert.ok(address&&typeof address!=='string');
    const url=`wss://127.0.0.1:${address.port}`,peers=Array.from({length:3},()=>new RawPeer(url));
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      for (const peer of peers) peer.socket.terminate();
      await server.close();
    };
    t.after(cleanup);
    try {
      // Deliberately complete all upgrades before hello: connect() must handle
      // sockets whose open event happened during another peer's admission.
      await Promise.all(peers.map(peer => once(peer.socket, 'open', { signal: AbortSignal.timeout(5000) })));
      const welcomes=[];
      for(let i=0;i<3;i++) welcomes.push(await peers[i]!.connect(config.match.contentSetHash,`Human ${i}`));
      await delay(10100);
      const start=peers[0]!.messages.length;
      peers[0]!.send({type:'vote-start',proposal:kind==='map'?{kind:'map',map:'Arena2'}:{kind:'kick',slot:welcomes[1]!.slot,reason:'team abuse'}});
      const vote=await peers[0]!.waitFor((m):m is Extract<Message,{type:'control-state'}>=>m.type==='control-state'&&m.state.vote?.phase==='active',start);
      assert.equal(vote.state.vote!.eligible,3); assert.equal(vote.state.vote!.required,2);
      if(kind==='kick') {
        const targetState=await peers[1]!.waitFor((m):m is Extract<Message,{type:'control-state'}>=>m.type==='control-state'&&m.state.vote?.id===vote.state.vote!.id);
        assert.equal(targetState.state.vote!.canVote,false);
      }
      const closed=kind==='kick'?once(peers[1]!.socket,'close',{signal:AbortSignal.timeout(5000)}):undefined;
      peers[2]!.send({type:'vote-cast',id:vote.state.vote!.id,choice:'yes'});
      if(kind==='map') {
        const next=await peers[0]!.waitFor((m):m is Extract<Message,{type:'welcome'}>=>m.type==='welcome'&&m.map==='Arena2',start);
        assert.equal(next.roundEpoch,1);
      } else {
        const [code,reason]=await closed!; assert.equal(code,1008); assert.match(reason.toString(),/one hour/);
        assert.equal(peers[0]!.closed,undefined); assert.equal(peers[2]!.closed,undefined);
        const retry=new RawPeer(url);
        try { await assert.rejects(retry.connect(config.match.contentSetHash,'Retry')); } finally { await retry.close(); }
      }
      assert.deepEqual(errors,[]);
    } finally { await cleanup(); }
  }
});
