import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, ProtocolError, decodeMessage, encodeMessage, isClientFeature, isServerFeature, type Message } from '../src/index.ts';

test('wire7 features roundtrip with explicit client/server direction', () => {
  assert.equal(PROTOCOL_VERSION,7);
  const messages:Message[]=[
    {type:'gesture',gesture:'victory'}, {type:'self-kill'}, {type:'admin-auth',token:'a'.repeat(32)}, {type:'admin-logout'},
    {type:'admin-action',action:{kind:'ban',slot:32,minutes:43200,reason:'reason'}},
    {type:'vote-start',proposal:{kind:'map',map:'Arena'}}, {type:'vote-cast',id:1,choice:'no'}, {type:'radio',category:3,direction:2},
    {type:'voice-configure',enabled:true,channel:'team',transmitting:false},
    {type:'voice-signal',peerId:'nonce',generation:1,signal:{kind:'offer',sdp:'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n'}},
    {type:'control-state',state:{host:false,admin:true,paused:true,muted:false,vote:null}}, {type:'admin-bans',bans:[]},
    {type:'radio-message',slot:1,nickname:'Human',category:1,direction:2},
    {type:'voice-state',state:{selfId:'self',transmitting:false,enabled:true,channel:'team',muted:false,
      peers:[{id:'peer',generation:1,slot:2,nickname:'Human',canSend:true,canReceive:true,talking:false}],
      configuration:{enabled:true,iceServers:[],relayOnly:false}}},
    {type:'voice-signal-delivery',peerId:'peer',generation:Number.MAX_SAFE_INTEGER,signal:{kind:'candidate',candidate:'',sdpMid:null,sdpMLineIndex:null}},
  ];
  for(const message of messages) { assert.deepEqual(decodeMessage(encodeMessage(message)),message); assert.notEqual(isClientFeature(message),isServerFeature(message)); }
});
test('feature validation rejects forged capability fields, extra payload, limits, and mismatched type envelopes',()=>{
  for(const message of [{type:'gesture',gesture:'smoke',slot:2},{type:'admin-auth',token:'x',host:true},{type:'radio',category:0,direction:1},{type:'voice-signal',peerId:'x',generation:1,signal:{kind:'offer',sdp:'x'.repeat(32769)}},{type:'admin-action',action:{kind:'ban',slot:1,minutes:43201,reason:''}},{type:'vote-cast',id:1,choice:'maybe'}]) assert.throws(()=>encodeMessage(message as Message),ProtocolError);
  for (const kind of [['pause'], 'constructor', '__proto__', { toString: 'pause' }]) {
    assert.throws(() => encodeMessage({ type: 'admin-action', action: { kind } } as unknown as Message), ProtocolError);
  }
  const packet=encodeMessage({type:'gesture',gesture:'smoke'}); packet[2]=encodeMessage({type:'self-kill'})[2]!;
  assert.throws(()=>decodeMessage(packet),ProtocolError);
  const wire6=encodeMessage({type:'self-kill'}); new DataView(wire6.buffer).setUint16(0,6,true); assert.throws(()=>decodeMessage(wire6),ProtocolError);
});
test('ban summaries remain bounded and can list both full global and local stores without truncating IDs',()=>{
  const bans=Array.from({length:512},(_,i)=>({id:`ban-${i}`,nickname:'n'.repeat(48),reason:'\\'.repeat(256),expiresAt:123456789,global:i<256}));
  const message:Message={type:'admin-bans',bans}; assert.deepEqual(decodeMessage(encodeMessage(message)),message);
});

test('voice generations are required positive safe integers on peer policies and both signaling directions',()=>{
  for(const type of ['voice-signal','voice-signal-delivery'] as const) {
    const valid:Message={type,peerId:'peer',generation:1,signal:{kind:'candidate',candidate:'',sdpMid:null,sdpMLineIndex:null}};
    for(const generation of [undefined,null,0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'1']) {
      const invalid={...valid,generation};
      assert.throws(()=>encodeMessage(invalid as unknown as Message),ProtocolError);
      // Build untrusted bytes without using the encoder's validation path.
      const template=encodeMessage(valid), payload=new TextEncoder().encode(JSON.stringify(invalid));
      const packet=new Uint8Array(12+payload.length);
      packet.set(template.subarray(0,8));
      const view=new DataView(packet.buffer); view.setUint32(4,payload.length+4,true); view.setUint32(8,payload.length,true); packet.set(payload,12);
      assert.throws(()=>decodeMessage(packet),ProtocolError);
    }
  }
  for(const generation of [undefined,null,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'1']) {
    const message={type:'voice-state',state:{selfId:'self',transmitting:false,enabled:true,channel:'team',muted:false,
      peers:[{id:'peer',generation,slot:2,nickname:'Human',canSend:true,canReceive:true,talking:false}],
      configuration:{enabled:true,iceServers:[],relayOnly:false}}};
    assert.throws(()=>encodeMessage(message as unknown as Message),ProtocolError);
  }
});
