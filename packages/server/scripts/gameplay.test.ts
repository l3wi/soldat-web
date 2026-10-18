import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, DEFAULT_APPEARANCE, encodeMessage, decodeMessage, teamCount, type ChatDelivery, type GameMode, type MatchRules, type Message, type PlayerAppearance } from '@soldat-web/protocol';
import { SIM_ABI_VERSION, loadSim, loadSimContent, requireStatus, type SimHost } from '@soldat-web/sim-host';
import { OnlineSession } from '../../client/src/net/session.ts';
import { createGameServer } from '../src/server.ts';
import { RawPeer, qualificationConfig, delay, type QualificationConfig } from './support.ts';

/** Real sockets and native 60Hz workers require the platform clock; fake timers
 * cannot advance worker threads or WebSocket delivery. All waits observe state. */
class GameplayPeer {
  readonly errors: string[] = [];
  readonly welcomes: Extract<Message, { type: 'welcome' }>[] = [];
  readonly events: number[] = [];
  readonly chats: ChatDelivery[] = [];
  readonly notices: string[] = [];
  readonly leaves: number[] = [];
  session?: OnlineSession;
  private timer?: NodeJS.Timeout;
  private socket?: WebSocket;
  private prediction?: SimHost;
  private confirmed?: SimHost;
  private closing = false;
  private readonly neutral = new Uint8Array(12);
  constructor(private readonly config: QualificationConfig) {}
  async connect(url: string, nickname: string, appearance: PlayerAppearance = DEFAULT_APPEARANCE): Promise<void> {
    this.prediction = await loadSim(this.config.wasm); this.confirmed = await loadSim(this.config.wasm);
    for (const host of [this.prediction, this.confirmed]) await loadSimContent(host, this.config.manifest, path => readFile(resolve(this.config.match.contentRoot, path)));
    const socket = new WebSocket(url, { rejectUnauthorized: false, perMessageDeflate: false }); this.socket = socket;
    socket.on('error', error => { if (!this.closing) this.errors.push(error.message); });
    socket.on('close', (code, reason) => { if (!this.closing) this.errors.push(`Closed ${code}: ${reason.toString()}`); });
    socket.on('message', bytes => {
      try {
        const message = decodeMessage(bytes as Buffer);
        if (message.type === 'welcome') {
          this.welcomes.push(message);
          if (this.session) {
            this.session.resetRound();
            for (const host of [this.prediction!, this.confirmed!]) requireStatus(host.loadMap(message.map), 'peer next map');
          } else {
            const rules = JSON.parse(new TextDecoder().decode(message.rules)) as Record<string, unknown>;
            for (const host of [this.prediction!, this.confirmed!]) {
              requireStatus(host.init({ ...rules, ai: true }, Number(message.matchSeed & 0xffffffffn), Number(message.matchSeed >> 32n)), 'peer init');
              requireStatus(host.loadMap(message.map), 'peer map');
            }
            this.session = new OnlineSession({ prediction: this.prediction!, confirmed: this.confirmed!, slot: message.slot, send: packet => this.send(packet), onEvent: event => this.events.push(new DataView(event.header.buffer, event.header.byteOffset).getUint32(0, true)),
              onChat: message => this.chats.push(message), onNotice: text => this.notices.push(text), onSlotLeave: slot => this.leaves.push(slot) });
          }
        } else if (this.session) this.session.receive(message);
        else if (message.type === 'ping') this.send({ type: 'pong', timestamp: message.timestamp });
        else if (message.type === 'disconnect') throw new Error(message.reason);
      } catch (error) { this.errors.push(error instanceof Error ? error.message : String(error)); }
    });
    await once(socket, 'open');
    this.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, simAbiVersion: SIM_ABI_VERSION, contentSetHash: Buffer.from(this.config.match.contentSetHash, 'hex'), nickname, weapon: 4, secondaryWeapon: 0, appearance });
    this.timer = setInterval(() => {
      try { this.session?.advance(() => this.neutral); }
      catch (error) { this.errors.push(error instanceof Error ? error.message : String(error)); }
    }, 8);
    await this.until(() => this.session?.metrics.status === 'online');
  }
  send(message: Message): void { this.socket!.send(encodeMessage(message)); }
  async until(predicate: () => boolean, timeout = 20_000): Promise<void> {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
      assert.deepEqual(this.errors, []);
      if (performance.now() >= deadline) throw new Error(`Gameplay predicate timed out: ${JSON.stringify(this.session?.metrics)}`);
      await delay(10);
    }
  }
  sprite(slot = this.session!.metrics.slot) { return this.session!.authoritativeRenderView().sprite(slot - 1); }
  async close(): Promise<void> {
    this.closing = true; clearInterval(this.timer);
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) { const closed = once(this.socket, 'close'); this.socket.close(); await closed; }
    if (this.session) this.session.dispose(); else { this.prediction?.dispose(); this.confirmed?.dispose(); }
  }
}

test('real WSS round handoff preserves humans, team and appearance with confirmed hashes', { timeout: 60_000 }, async () => {
  const config = await qualificationConfig(resolve('build-out/gameplay/network'));
  const errors: string[] = [];
  const server = await createGameServer({ match: { ...config.match, map: 'Arena', mapRotation: ['Arena', 'Arena2'], targetPlayers: 4, rules: { mode: 'tm', rng: 'keyed', world: 'original', timeLimitTicks: 240, scoreLimit: 0 } }, tls: config.tls, port: 0, host: '127.0.0.1', onError: error => errors.push(error.message) });
  const address = server.httpsServer.address(); assert.ok(address && typeof address !== 'string');
  const url = `wss://127.0.0.1:${address.port}`;
  const first = new GameplayPeer(config), second = new GameplayPeer(config), late = new GameplayPeer(config);
  const pants = 0x13579b;
  try {
    await first.connect(url, 'Round One'); await second.connect(url, 'Round Two');
    const firstSlot = first.session!.metrics.slot, secondSlot = second.session!.metrics.slot;
    first.send({ type: 'team-change', team: 3 });
    first.send({ type: 'appearance', appearance: { ...DEFAULT_APPEARANCE, pantsColor: pants, hairStyle: 4 } });
    await first.until(() => first.sprite().team === 3 && (first.sprite().pantsColor & 0xffffff) === pants);
    await second.until(() => second.sprite(firstSlot).team === 3 && (second.sprite(firstSlot).pantsColor & 0xffffff) === pants);
    await first.until(() => first.welcomes.length >= 2 && first.session!.metrics.status === 'online');
    await second.until(() => second.welcomes.length >= 2 && second.session!.metrics.status === 'online');
    assert.equal(first.welcomes[1]!.map, 'Arena2'); assert.equal(second.welcomes[1]!.map, 'Arena2');
    assert.equal(first.session!.metrics.slot, firstSlot); assert.equal(second.session!.metrics.slot, secondSlot);
    assert.equal(first.sprite().team, 3); assert.equal(first.sprite().playerName, 'Round One');
    assert.equal(first.sprite().pantsColor & 0xffffff, pants); assert.equal(first.sprite().hairStyle, 4);
    await late.connect(url, 'Late Round');
    assert.equal(late.welcomes[0]!.map, 'Arena2'); assert.equal(late.welcomes[0]!.roundEpoch, first.welcomes[1]!.roundEpoch);
    await first.until(() => first.session!.metrics.hashMatches >= 3);
    await second.until(() => second.session!.metrics.hashMatches >= 3);
    await late.until(() => late.session!.metrics.hashMatches >= 2);
    assert.ok(first.events.includes(0x1007), 'Confirmed match-end event must reach the player');
    for (const peer of [first, second, late]) { assert.deepEqual(peer.errors, []); assert.equal(peer.session!.metrics.hashMismatches, 0); assert.equal(peer.session!.metrics.eventGaps, 0); }
    assert.deepEqual(errors, []);
  } finally { await Promise.all([first.close(), second.close(), late.close()]); await server.close(); }
});

async function nativeMatch(config: QualificationConfig, rules: Partial<MatchRules>): Promise<SimHost> {
  const host = await loadSim(config.wasm);
  await loadSimContent(host, config.manifest, path => readFile(resolve(config.match.contentRoot, path)));
  requireStatus(host.init({ world: 'original', ai: true, rng: 'keyed', timeLimitTicks: 0, ...rules }, 123, 456), 'balance init');
  requireStatus(host.loadMap('Arena'), 'balance map');
  return host;
}

function roster(host: SimHost) {
  const render = host.renderView(); assert.notEqual(typeof render, 'number');
  if (typeof render === 'number') throw new Error(`Render failed: ${render}`);
  return Array.from({ length: 32 }, (_, index) => render.sprite(index)).filter(sprite => sprite.flags & 1);
}

function assertBalanced(host: SimHost, mode: GameMode): void {
  const count = teamCount(mode);
  if (!count) { assert.ok(roster(host).every(sprite => sprite.team === 0 || sprite.team === 5)); return; }
  const sizes = Array.from({ length: count }, (_, index) => roster(host).filter(sprite => sprite.team === index + 1).length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `Uneven ${mode} teams: ${sizes}`);
}

test('native balancing covers all modes, spectators, denied switches and map/state epochs', { timeout: 60_000 }, async () => {
  const config = await qualificationConfig(resolve('build-out/gameplay/balance'));
  for (const mode of ['dm', 'pm', 'tm', 'ctf', 'rambo', 'inf', 'htf'] as const) {
    const host = await nativeMatch(config, { mode, balanceTeams: true });
    try {
      for (let slot = 1; slot <= 9; slot++) {
        requireStatus(host.command(0, { kind: 'join', slot, team: teamCount(mode) ? 1 : 0, control: 'authoritative', name: `Human ${slot}` }), 'balanced join');
        assertBalanced(host, mode);
      }
      requireStatus(host.command(0, { kind: 'join', slot: 10, team: 5, control: 'authoritative' }), 'spectator join');
      assert.equal(roster(host).find(sprite => sprite.slot === 10)!.team, 5);
      assertBalanced(host, mode);
      if (teamCount(mode)) {
        const before = roster(host), smallest = before.find(sprite => sprite.team === 2)!;
        const hash = host.hash();
        assert.equal(host.command(0, { kind: 'team', slot: smallest.slot, team: 1 }), -4);
        assert.equal(host.hash(), hash, 'Denied change must not mutate simulation');
        requireStatus(host.command(0, { kind: 'team', slot: 1, team: 5 }), 'watch game');
        assertBalanced(host, mode);
        requireStatus(host.command(0, { kind: 'leave', slot: 2 }), 'human departure');
        assertBalanced(host, mode);
      }
      const saved = host.saveState(); assert.ok(saved instanceof Uint8Array);
      const hash = host.hash(); requireStatus(host.step(), 'balance step');
      requireStatus(host.loadState(saved), 'balance restore'); assert.equal(host.hash(), hash);
      requireStatus(host.loadMap('Arena2'), 'balance next map');
      assertBalanced(host, mode);
      assert.equal(roster(host).find(sprite => sprite.slot === 10)!.team, 5);
    } finally { host.dispose(); }
  }
});

test('native departures prefer actual bots, replacement is atomic, and Survival does not grant a life', { timeout: 60_000 }, async () => {
  const config = await qualificationConfig(resolve('build-out/gameplay/balance-survival'));
  const host = await nativeMatch(config, { mode: 'ctf', balanceTeams: true, survival: true });
  try {
    for (let slot = 1; slot <= 5; slot++) requireStatus(host.command(0, slot === 3
      ? { kind: 'join', slot, team: 1, control: 'bot', bot: 'Admiral' }
      : { kind: 'join', slot, team: 1, control: 'authoritative', name: `Human ${slot}` }), 'balanced survival join');
    requireStatus(host.step(), 'start survival');
    const before = roster(host), bot = before.find(sprite => sprite.slot === 3)!;
    requireStatus(host.command(1, { kind: 'leave', slot: 2 }), 'departure with balancing');
    const after = roster(host);
    assert.equal(after.find(sprite => sprite.slot === 3)!.team, 2, 'True bot moves before authoritative human dummy bots');
    assert.equal(after.find(sprite => sprite.slot === 3)!.deaths, bot.deaths);
    assert.ok(after.find(sprite => sprite.slot === 3)!.flags & 2, 'Moved player waits dead for Survival round');
    for (const human of before.filter(sprite => sprite.slot !== 2 && sprite.slot !== 3))
      assert.equal(after.find(sprite => sprite.slot === human.slot)!.team, human.team);
    assertBalanced(host, 'ctf');
    const identities = after.filter(sprite => sprite.slot !== 3).map(sprite => ({ slot: sprite.slot, team: sprite.team, name: sprite.playerName }));
    requireStatus(host.command(1, { kind: 'leave', slot: 3, replacement: true }), 'replace bot departure');
    requireStatus(host.command(1, { kind: 'join', slot: 6, team: 1, control: 'authoritative', name: 'Replacement' }), 'replace bot admission');
    assertBalanced(host, 'ctf');
    for (const human of identities) {
      const current = roster(host).find(sprite => sprite.slot === human.slot)!;
      assert.equal(current.team, human.team); assert.equal(current.playerName, human.name);
    }
    assert.ok(roster(host).find(sprite => sprite.slot === 6)!.flags & 2);
  } finally { host.dispose(); }
});

test('real WSS balancing denial keeps connection and confirmed hashes, chat follows authoritative teams', { timeout: 60_000 }, async () => {
  const config = await qualificationConfig(resolve('build-out/gameplay/balance-chat-network'));
  const errors: string[] = [];
  const server = await createGameServer({ match: { ...config.match, targetPlayers: 4, rules: { mode: 'ctf', balanceTeams: true, rng: 'keyed', timeLimitTicks: 0 } }, tls: config.tls, port: 0, host: '127.0.0.1', onError: error => errors.push(error.message) });
  const address = server.httpsServer.address(); assert.ok(address && typeof address !== 'string');
  const url = `wss://127.0.0.1:${address.port}`, peers = Array.from({ length: 4 }, () => new GameplayPeer(config));
  try {
    for (let index = 0; index < peers.length; index++) await peers[index]!.connect(url, index ? `Human ${index}` : 'Zoë');
    const first = peers[0]!, opposite = peers.find(peer => peer.sprite().team !== first.sprite().team)!;
    first.send({ type: 'team-change', team: opposite.sprite().team });
    await first.until(() => first.notices.length === 1);
    for (let index = 0; index < 5; index++) first.send({ type: 'team-change', team: opposite.sprite().team });
    await first.until(() => first.notices.length >= 6);
    assert.ok(first.notices.some(text => text.includes('Please wait')), 'Rapid harmless denials must return notices instead of disconnecting');
    assert.equal(first.session!.metrics.status, 'online');
    const team = first.sprite().team;
    first.session!.sendChat('team', 'team secret');
    await first.until(() => first.chats.some(message => message.text === 'team secret'));
    await delay(100);
    for (const peer of peers) assert.equal(peer.chats.some(message => message.text === 'team secret'), peer.sprite().team === team);
    const delivery = first.chats.find(message => message.text === 'team secret')!;
    assert.equal(delivery.slot, first.session!.metrics.slot); assert.equal(delivery.nickname, 'Zoë');
    first.session!.sendChat('public', '/kick 1');
    for (const peer of peers) await peer.until(() => peer.chats.some(message => message.text === '/kick 1'));
    const spectator = peers[1]!, otherSpectator = peers[2]!;
    spectator.send({ type: 'team-change', team: 5 }); otherSpectator.send({ type: 'team-change', team: 5 });
    await spectator.until(() => spectator.sprite().team === 5);
    await otherSpectator.until(() => otherSpectator.sprite().team === 5);
    spectator.session!.sendChat('team', 'spectator secret');
    await otherSpectator.until(() => otherSpectator.chats.some(message => message.text === 'spectator secret'));
    await delay(100);
    assert.ok(!first.chats.some(message => message.text === 'spectator secret'));
    await first.until(() => first.session!.metrics.hashMatches >= 3);
    for (const peer of peers) { assert.deepEqual(peer.errors, []); assert.equal(peer.session!.metrics.hashMismatches, 0); }
    assert.deepEqual(errors, []);
  } finally { await Promise.all(peers.map(peer => peer.close())); await server.close(); }
});

test('real WSS solo teamchat, forged delivery and dedicated chat flood policy', { timeout: 60_000 }, async () => {
  const config = await qualificationConfig(resolve('build-out/gameplay/chat-security'));
  const disconnects: { slot: number; reason: string }[] = [];
  const server = await createGameServer({ match: { ...config.match, targetPlayers: 3, rules: { mode: 'dm', timeLimitTicks: 0 } }, tls: config.tls, port: 0, host: '127.0.0.1',
    onDisconnect: (slot, _code, reason) => disconnects.push({ slot, reason }) });
  const address = server.httpsServer.address(); assert.ok(address && typeof address !== 'string');
  const url = `wss://127.0.0.1:${address.port}`;
  const first = new RawPeer(url), second = new RawPeer(url), spectator = new RawPeer(url);
  try {
    const [one, , three] = await Promise.all([first.connect(config.match.contentSetHash, 'Actual sender'), second.connect(config.match.contentSetHash, 'Other solo'), spectator.connect(config.match.contentSetHash, 'Watcher')]);
    spectator.send({ type: 'team-change', team: 5 });
    // Ping traverses the same worker queue only indirectly; wait for the native
    // changed team to be included in a subsequent authoritative full-state.
    spectator.send({ type: 'resync' });
    await spectator.waitFor((message): message is Extract<Message, { type: 'state' }> => message.type === 'state');
    await delay(100);
    first.send({ type: 'chat', channel: 'team', text: 'solo team zero', slot: three.slot, nickname: 'Forged' } as Message);
    const received = await second.waitFor((message): message is ChatDelivery => message.type === 'chat-message' && message.text === 'solo team zero');
    assert.equal(received.slot, one.slot); assert.equal(received.nickname, 'Actual sender');
    await delay(100);
    assert.ok(!spectator.messages.some(message => message.type === 'chat-message' && message.text === 'solo team zero'));
    spectator.send({ type: 'chat', channel: 'team', text: 'watcher only' });
    await spectator.waitFor((message): message is ChatDelivery => message.type === 'chat-message' && message.text === 'watcher only');
    await delay(100);
    assert.ok(!first.messages.some(message => message.type === 'chat-message' && message.text === 'watcher only'));
    first.send({ type: 'chat', channel: 'public', text: 'all active' });
    await spectator.waitFor((message): message is ChatDelivery => message.type === 'chat-message' && message.text === 'all active');
    const closed = once(spectator.socket, 'close');
    spectator.send({ type: 'chat-message', channel: 'public', slot: one.slot, nickname: 'Actual sender', text: 'forged delivery' });
    await closed;
    assert.equal(spectator.closed?.code, 1008);
    assert.ok(!second.messages.some(message => message.type === 'chat-message' && message.text === 'forged delivery'));
    const flooded = once(first.socket, 'close');
    for (let index = 0; index < 8; index++) first.send({ type: 'chat', channel: 'public', text: `flood ${index}` });
    await flooded;
    assert.equal(first.closed?.code, 1008);
    assert.ok(disconnects.some(entry => entry.slot === one.slot && entry.reason === 'Chat rate limit exceeded'));
    assert.ok(second.messages.filter(message => message.type === 'chat-message' && message.text.startsWith('flood ')).length <= 4);
  } finally { await Promise.all([first.close(), second.close(), spectator.close()]); await server.close(); }
});

test('native balancing remains opt-in and immutable across state restoration', { timeout: 60_000 }, async () => {
  const config = await qualificationConfig(resolve('build-out/gameplay/balance-rules'));
  const disabled = await nativeMatch(config, { mode: 'ctf' }), enabled = await nativeMatch(config, { mode: 'ctf', balanceTeams: true });
  try {
    for (const host of [disabled, enabled]) for (const slot of [1, 2])
      requireStatus(host.command(0, { kind: 'join', slot, team: 1, control: 'authoritative' }), 'rule admission');
    assert.deepEqual(roster(disabled).map(sprite => sprite.team), [1, 1]);
    assert.deepEqual(roster(enabled).map(sprite => sprite.team), [1, 2]);
    const balancedState = enabled.saveState(), unbalancedState = disabled.saveState();
    assert.ok(balancedState instanceof Uint8Array && unbalancedState instanceof Uint8Array);
    const before = disabled.hash(), balancedHash = enabled.hash();
    assert.ok(disabled.loadState(balancedState) < 0); assert.equal(disabled.hash(), before);
    assert.ok(enabled.loadState(unbalancedState) < 0); assert.equal(enabled.hash(), balancedHash);
  } finally { disabled.dispose(); enabled.dispose(); }
});
