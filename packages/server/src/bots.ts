import type { MatchConfiguration } from "./worker-messages.ts";
import { normalizeMatchRules } from "@soldat-web/protocol";

export const MAX_PLAYERS = 32;
export const WEAPON_CHOICE_BURST = 4;
export const WEAPON_CHOICES_PER_SECOND = 2;
/** Stock profile basenames; the simulation owns their names, appearance and loadouts. */
export const BOT_PROFILES = ["Admiral", "Billy", "Blain", "Boogie Man", "Commando", "D Dave", "Danko", "Dutch", "John", "Kruger", "Poncho", "Roach", "Sgt. Mac", "Sniper", "Stevie", "Terminator"] as const;

export function configureMatch(config: MatchConfiguration): MatchConfiguration & { botCount: number } {
  const botCount = config.botCount === undefined ? 0 : config.botCount;
  if (!Number.isInteger(botCount) || botCount < 0 || botCount >= MAX_PLAYERS) throw new RangeError("botCount must be an integer in 0..31");
  if (config.targetPlayers !== undefined && (!Number.isInteger(config.targetPlayers) || config.targetPlayers < 1 || config.targetPlayers > MAX_PLAYERS)) throw new RangeError("targetPlayers must be an integer in 1..32");
  const rules = normalizeMatchRules(config.rules);
  if (config.mapRotation !== undefined && (!Array.isArray(config.mapRotation) || config.mapRotation.length < 1 || config.mapRotation.length > 32 || new Set(config.mapRotation).size !== config.mapRotation.length || !config.mapRotation.includes(config.map) || config.mapRotation.some(map => typeof map !== "string" || !map || Buffer.byteLength(map) > 128))) throw new RangeError("Invalid map rotation");
  const allowedMaps = config.allowedMaps === undefined ? config.mapRotation ?? [config.map] : config.allowedMaps;
  if (!Array.isArray(allowedMaps) || allowedMaps.length < 1 || allowedMaps.length > 4096 || new Set(allowedMaps).size !== allowedMaps.length || !allowedMaps.includes(config.map) || allowedMaps.some(map => typeof map !== "string" || !map || Buffer.byteLength(map) > 128) || (config.mapRotation ?? [config.map]).some(map => !allowedMaps.includes(map))) throw new RangeError("Invalid allowed map catalog");
  return { ...config, botCount, rules: { ...rules, ai: true, world: rules.world ?? "original" } };
}

/** Humans allocate upward from one; this fixed high-slot reservation never changes. */
export function reservedBotSlots(botCount: number): number[] {
  return Array.from({ length: botCount }, (_, index) => MAX_PLAYERS - botCount + index + 1);
}
