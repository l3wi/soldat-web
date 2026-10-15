// Small runtime schemas for the owned oracle JSONL/fixture boundary; no mechanics.
export type Observation =
  | { kind: 'health-loss' | 'self-boost'; slot: number; after?: number }
  | { kind: 'posture'; slot: number; posture: string }
  | { kind: 'pickup'; slot: number; style: number }
  | { kind: 'hit-circle'; slot: number; circle: number }
  | { kind: 'shot-count'; slot: number; weapon: number; start: number; end: number; count: number }
  | { kind: 'respawn-weapon'; slot: number; weapon: number; secondaryWeapon: number }
  | { kind: 'collision-winner' | 'collision-rejected' | 'collision-accepted'; collisionKind: string; start: number; end: number }
  | { kind: 'grenade-release'; frame: number; emitted: boolean }
  | { kind: 'bullet-style' | 'thing-style' | 'flag-held' | 'flag-released' | 'flag-return'; style: number }
  | { kind: 'decay'; count: number }
  | { kind: 'bullet-disappeared'; after: number }
  | { kind: 'no-grenade-window'; start: number; end: number }
  | { kind: 'ricochet' | 'reload' | 'capture' };
export interface CombatFixture {
  ticks: number; mapPath: string; mapSha256: string; contentSetHash: string;
  rules: { mode: string; rng: string };
  metadata: { requiredObservations: Observation[]; limitations: string[] };
}
interface FloatValue { decimal: number }
interface TraceSprite {
  id: number; dead: boolean; health: FloatValue; vest: FloatValue; position: number; bonusStyle: number;
  particle: { pos: [FloatValue, FloatValue]; velocity: [FloatValue, FloatValue] };
  body: { frame: number }; weapon: { reload: number; num: number; ammo: number }; secondaryWeapon: { num: number }; tertiaryWeapon: { num: number; ammo: number };
}
export interface CollisionObservation {
  bullet: number; kind: string; entity: number; where: number; sequence: number;
  accepted: boolean; winner: boolean;
  x: FloatValue; y: FloatValue; distance: FloatValue; priorLimit: FloatValue;
}
export interface CombatTraceRow {
  type: 'state'; tick: number; stage: string; teamScores: number[];
  sprites: TraceSprite[];
  bullets: { id: number; style: number; degradeCount: number; ricochetCount: number }[];
  things: { style: number; holdingSprite: number; inBase: boolean }[];
  combatHits: { target: number; where: number }[];
  combatCollisions: CollisionObservation[];
}
function isFloat(value: unknown): value is FloatValue {
  return value !== null && typeof value === 'object' && 'decimal' in value && typeof value.decimal === 'number' && Number.isFinite(value.decimal);
}
function isVector(value: unknown): value is [FloatValue, FloatValue] {
  return Array.isArray(value) && value.length === 2 && value.every(isFloat);
}
export function parseCombatTraceRow(text: string): CombatTraceRow | null {
  // The pinned local harness owns this shape; validate each consumed field below.
  const row = JSON.parse(text) as CombatTraceRow | { type: 'header' };
  if (row === null || typeof row !== 'object') throw new Error('Expected oracle record');
  if (row.type === 'header') return null;
  if (row.type !== 'state' || !Number.isInteger(row.tick) || typeof row.stage !== 'string' || !Array.isArray(row.sprites) || !Array.isArray(row.bullets) || !Array.isArray(row.things) || !Array.isArray(row.teamScores) || !row.teamScores.every(v => typeof v === 'number') || !Array.isArray(row.combatHits)) throw new Error('Expected combat-enabled oracle state');
  for (const sprite of row.sprites) {
    if (!sprite || !Number.isInteger(sprite.id) || typeof sprite.dead !== 'boolean' || !isFloat(sprite.health) || !isFloat(sprite.vest) || !Number.isInteger(sprite.position) || !Number.isInteger(sprite.bonusStyle) || !sprite.particle || !isVector(sprite.particle.pos) || !isVector(sprite.particle.velocity) || !sprite.body || !Number.isInteger(sprite.body.frame) || !sprite.weapon || typeof sprite.weapon.reload !== 'number' || !Number.isInteger(sprite.weapon.num) || !Number.isInteger(sprite.weapon.ammo) || !sprite.secondaryWeapon || !Number.isInteger(sprite.secondaryWeapon.num) || !sprite.tertiaryWeapon || !Number.isInteger(sprite.tertiaryWeapon.num) || !Number.isInteger(sprite.tertiaryWeapon.ammo)) throw new Error('Malformed oracle sprite');
  }
  for (const bullet of row.bullets) if (!bullet || !['id', 'style', 'degradeCount', 'ricochetCount'].every(key => Number.isInteger(Reflect.get(bullet, key)))) throw new Error('Malformed oracle bullet');
  for (const thing of row.things) if (!thing || !Number.isInteger(thing.style) || !Number.isInteger(thing.holdingSprite) || typeof thing.inBase !== 'boolean') throw new Error('Malformed oracle thing');
  for (const hit of row.combatHits) if (!hit || !Number.isInteger(hit.target) || !Number.isInteger(hit.where)) throw new Error('Malformed/overflowed hit diagnostics');
  if (!Array.isArray(row.combatCollisions)) throw new Error('Missing collision diagnostics; rebuild oracle');
  for (const collision of row.combatCollisions) if (!collision || !['map', 'collider', 'sprite', 'thing'].includes(collision.kind) || !Number.isInteger(collision.bullet) || !Number.isInteger(collision.entity) || !Number.isInteger(collision.where) || !Number.isInteger(collision.sequence) || typeof collision.accepted !== 'boolean' || typeof collision.winner !== 'boolean' || !isFloat(collision.x) || !isFloat(collision.y) || !isFloat(collision.distance) || !isFloat(collision.priorLimit)) throw new Error('Malformed/overflowed collision diagnostics');
  return row;
}
export function parseCombatFixture(text: string): CombatFixture {
  // Authored by generate-combat.ts; reject malformed/stale fixture contracts below.
  const fixture = JSON.parse(text) as CombatFixture;
  if (!fixture || !Number.isInteger(fixture.ticks) || typeof fixture.mapPath !== 'string' || typeof fixture.mapSha256 !== 'string' || typeof fixture.contentSetHash !== 'string' || !fixture.rules || typeof fixture.rules.mode !== 'string' || typeof fixture.rules.rng !== 'string' || !fixture.metadata || !Array.isArray(fixture.metadata.requiredObservations) || !Array.isArray(fixture.metadata.limitations) || !fixture.metadata.limitations.every(v => typeof v === 'string')) throw new Error('Malformed combat fixture');
  const fields: Record<string, string[]> = { 'health-loss': ['slot'], 'self-boost': ['slot'], pickup: ['slot', 'style'], posture: ['slot'], 'hit-circle': ['slot', 'circle'], 'shot-count': ['slot', 'weapon', 'start', 'end', 'count'], 'respawn-weapon': ['slot', 'weapon', 'secondaryWeapon'], 'grenade-release': ['frame'], 'bullet-style': ['style'], 'thing-style': ['style'], 'flag-held': ['style'], 'flag-released': ['style'], 'flag-return': ['style'], decay: ['count'], 'bullet-disappeared': ['after'], 'no-grenade-window': ['start', 'end'], ricochet: [], reload: [], capture: [] };
  fields['collision-winner'] = ['start', 'end'];
  fields['collision-rejected'] = ['start', 'end'];
  fields['collision-accepted'] = ['start', 'end'];
  for (const predicate of fixture.metadata.requiredObservations) {
    if (!predicate || typeof predicate.kind !== 'string' || !Object.hasOwn(fields, predicate.kind) || !fields[predicate.kind]!.every(key => typeof Reflect.get(predicate, key) === 'number') || (predicate.kind === 'posture' && typeof predicate.posture !== 'string') || (predicate.kind === 'grenade-release' && typeof predicate.emitted !== 'boolean')) throw new Error('Malformed observation predicate');
    if ('collisionKind' in predicate && !['map', 'collider', 'sprite', 'thing'].includes(predicate.collisionKind)) throw new Error('Invalid collision kind');
  }
  return fixture;
}
