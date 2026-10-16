import type { MatchConfiguration } from "./worker-messages.ts";

export const MAX_PLAYERS = 32;
export const WEAPON_CHOICE_BURST = 4;
export const WEAPON_CHOICES_PER_SECOND = 2;
/** Stock profile basenames; the simulation owns their names, appearance and loadouts. */
export const BOT_PROFILES = ["Admiral", "Billy", "Blain", "Boogie Man", "Commando", "D Dave", "Danko", "Dutch", "John", "Kruger", "Poncho", "Roach", "Sgt. Mac", "Sniper", "Stevie", "Terminator"] as const;

export function configureMatch(config: MatchConfiguration): MatchConfiguration & { botCount: number } {
  const botCount = config.botCount === undefined ? 0 : config.botCount;
  if (!Number.isInteger(botCount) || botCount < 0 || botCount >= MAX_PLAYERS) throw new RangeError("botCount must be an integer in 0..31");
  if (config.targetPlayers !== undefined && (!Number.isInteger(config.targetPlayers) || config.targetPlayers < 1 || config.targetPlayers > MAX_PLAYERS)) throw new RangeError("targetPlayers must be an integer in 1..32");
  if (config.rules.mode !== undefined && config.rules.mode !== "dm" && config.rules.mode !== "ctf") throw new RangeError("Match mode must be dm or ctf");
  const difficulty = config.rules.botDifficulty;
  if (difficulty !== undefined && (typeof difficulty !== "number" || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 300)) throw new RangeError("botDifficulty must be an integer in 0..300");
  if (config.rules.world !== undefined && config.rules.world !== "original" && config.rules.world !== "fixture") throw new RangeError("world must be original or fixture");
  return { ...config, botCount, rules: { ...config.rules, ai: true, world: config.rules.world ?? "original" } };
}

/** Humans allocate upward from one; this fixed high-slot reservation never changes. */
export function reservedBotSlots(botCount: number): number[] {
  return Array.from({ length: botCount }, (_, index) => MAX_PLAYERS - botCount + index + 1);
}
