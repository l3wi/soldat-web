import { ProtocolError } from './messages.ts';

export const GAME_MODES = ['dm', 'pm', 'tm', 'ctf', 'rambo', 'inf', 'htf'] as const;
export type GameMode = typeof GAME_MODES[number];
export interface PlayerAppearance {
  shirtColor: number; pantsColor: number; skinColor: number; hairColor: number; jetColor: number;
  hairStyle: number; headStyle: number; chainStyle: number;
}
export interface MatchRules {
  mode: GameMode; realistic: boolean; survival: boolean; advance: boolean; advanceAmount: number;
  bulletTime: boolean; bonusFrequency: number; bonusFlamer: boolean; bonusPredator: boolean;
  bonusBerserker: boolean; bonusVest: boolean; bonusCluster: boolean; friendlyFire: boolean;
  stationaryGuns: boolean; sniperLine: boolean; timeLimitTicks: number; scoreLimit: number; weapons: number[];
  balanceTeams?: boolean;
  rng?: 'original' | 'keyed'; ai?: boolean; botDifficulty?: number; world?: 'original' | 'fixture'; tickRate?: number; traceCombat?: boolean;
}
export const DEFAULT_APPEARANCE: Readonly<PlayerAppearance> = Object.freeze({ shirtColor: 0xeeeeee, pantsColor: 0x202090, skinColor: 0xffd2a0, hairColor: 0x808080, jetColor: 0xffffff, hairStyle: 0, headStyle: 0, chainStyle: 0 });
export const DEFAULT_MATCH_RULES: Readonly<MatchRules> = Object.freeze({ mode: 'dm', balanceTeams: false, realistic: false, survival: false, advance: false, advanceAmount: 2, bulletTime: false, bonusFrequency: 0, bonusFlamer: true, bonusPredator: true, bonusBerserker: true, bonusVest: true, bonusCluster: true, friendlyFire: false, stationaryGuns: false, sniperLine: false, timeLimitTicks: 360000, scoreLimit: 0, weapons: Object.freeze(Array.from({ length: 14 }, (_, i) => i)) as unknown as number[] });
function fail(message: string): never { throw new ProtocolError('VALUE', message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected gameplay object');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, key: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) fail(`Invalid ${key}: expected ${min}..${max}`);
}
export function isGameMode(value: unknown): value is GameMode { return GAME_MODES.includes(value as GameMode); }
export function teamCount(mode: GameMode): number { return mode === 'tm' ? 4 : mode === 'ctf' || mode === 'inf' || mode === 'htf' ? 2 : 0; }
export function validateTeam(team: unknown, mode?: GameMode): asserts team is number {
  integer(team, 0, 5, 'team');
  if (mode && team !== 5 && (teamCount(mode) ? (team as number) < 1 || (team as number) > teamCount(mode) : team !== 0)) fail('Team is not available in this mode');
}
export function validateAppearance(value: unknown): asserts value is PlayerAppearance {
  const object = record(value), keys = Object.keys(DEFAULT_APPEARANCE);
  if (Object.keys(object).length !== keys.length || Object.keys(object).some(key => !keys.includes(key))) fail('Invalid appearance fields');
  for (const key of ['shirtColor', 'pantsColor', 'skinColor', 'hairColor', 'jetColor']) integer(object[key], 0, 0xffffff, key);
  integer(object.hairStyle, 0, 4, 'hairStyle'); integer(object.headStyle, 0, 2, 'headStyle'); integer(object.chainStyle, 0, 2, 'chainStyle');
}
/** Fill omitted settings only; reject malformed or unknown settings rather than silently ignoring them. */
export function normalizeMatchRules(value: unknown = {}): MatchRules {
  const object = record(value);
  const extra = ['rng', 'ai', 'botDifficulty', 'world', 'tickRate', 'traceCombat'];
  for (const key of Object.keys(object)) if (!Object.hasOwn(DEFAULT_MATCH_RULES, key) && !extra.includes(key)) fail(`Unknown rule ${key}`);
  const result = { ...DEFAULT_MATCH_RULES, ...object } as MatchRules;
  if (!isGameMode(result.mode)) fail('Invalid game mode');
  for (const key of ['balanceTeams', 'realistic', 'survival', 'advance', 'bulletTime', 'bonusFlamer', 'bonusPredator', 'bonusBerserker', 'bonusVest', 'bonusCluster', 'friendlyFire', 'stationaryGuns', 'sniperLine', 'ai', 'traceCombat']) {
    if (key in result && typeof result[key as keyof MatchRules] !== 'boolean') fail(`Invalid ${key}`);
  }
  integer(result.advanceAmount, 1, 9999, 'advanceAmount'); integer(result.bonusFrequency, 0, 5, 'bonusFrequency');
  integer(result.timeLimitTicks, 0, 0x7fffffff, 'timeLimitTicks'); integer(result.scoreLimit, 0, 9999, 'scoreLimit');
  if (!Array.isArray(result.weapons) || result.weapons.length > 14 || new Set(result.weapons).size !== result.weapons.length) fail('Invalid enabled weapons');
  for (const weapon of result.weapons) integer(weapon, 0, 13, 'weapon');
  if (result.botDifficulty !== undefined) integer(result.botDifficulty, 0, 300, 'botDifficulty');
  if (result.tickRate !== undefined && result.tickRate !== 60) fail('Tick rate must be 60');
  if (result.rng !== undefined && result.rng !== 'original' && result.rng !== 'keyed') fail('Invalid rng');
  if (result.world !== undefined && result.world !== 'original' && result.world !== 'fixture') fail('Invalid world');
  result.weapons = [...result.weapons];
  return result;
}
