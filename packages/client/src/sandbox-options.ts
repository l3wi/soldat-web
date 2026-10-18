import { DEFAULT_MATCH_RULES, GAME_MODES, normalizeMatchRules, teamCount, type GameMode, type MatchRules } from "@soldat-web/protocol";
import type { ContentIndex } from "./content";

export interface SandboxOptions extends MatchRules {
  bots: number;
  team: number;
  botTeam: "balanced" | "alpha" | "bravo" | "charlie" | "delta";
  botDifficulty: number;
  mapRotation: string[];
}

export const DEFAULT_SANDBOX: Readonly<SandboxOptions> = {
  ...DEFAULT_MATCH_RULES, weapons: [...DEFAULT_MATCH_RULES.weapons],
  mode: "dm", bots: 4, team: 1, botTeam: "balanced", botDifficulty: 100, mapRotation: [],
};

/** The shell backdrop has no authoritative/local soldier. */
export const ATTRACT_SANDBOX: Readonly<SandboxOptions> = {
  ...DEFAULT_SANDBOX, bots: 8,
};

/** Names of the pinned original server/configs/bots profiles, not invented AI classes. */
export const BOT_PROFILES = [
  "Admiral", "Billy", "Blain", "Boogie Man", "Commando", "D Dave", "Danko", "Dutch",
  "John", "Kruger", "Poncho", "Roach", "Sgt. Mac", "Sniper", "Stevie", "Terminator",
] as const;

export function sandboxBotTeam(options: SandboxOptions, index: number): number {
  const teams = teamCount(options.mode);
  if (!teams) return 0;
  const assigned = ["alpha", "bravo", "charlie", "delta"].indexOf(options.botTeam) + 1;
  if (assigned > 0) return Math.min(assigned, teams);
  // Count the local player too: opponents take the other teams first.
  return (options.team + index) % teams + 1;
}

export function sandboxRules(options: SandboxOptions): MatchRules {
  const { bots: _bots, team: _team, botTeam: _botTeam, mapRotation: _rotation, ...rules } = options;
  return normalizeMatchRules(rules);
}

export function validateSandbox(options: SandboxOptions): void {
  const teams = teamCount(options.mode);
  if (!GAME_MODES.includes(options.mode) || !Number.isInteger(options.bots) || options.bots < 0 || options.bots > 31 ||
      !Number.isInteger(options.team) || options.team < 1 || options.team > Math.max(2, teams) ||
      !["balanced", "alpha", "bravo", ...(teams === 4 ? ["charlie", "delta"] : [])].includes(options.botTeam) ||
      !Number.isInteger(options.botDifficulty) || options.botDifficulty < 0 || options.botDifficulty > 300 ||
      !Array.isArray(options.mapRotation) || options.mapRotation.length > 32 || new Set(options.mapRotation).size !== options.mapRotation.length || options.mapRotation.some(map => typeof map !== "string" || !map.length))
    throw new RangeError("Invalid sandbox options");
  try { sandboxRules(options); } catch (error) { throw new RangeError("Invalid sandbox rules", { cause: error }); }
}

export function compatibleSandboxMaps(index: Pick<ContentIndex, "maps">, mode: GameMode, requireBots = false): string[] {
  return Object.entries(index.maps).filter(([, map]) => map.modes.includes(mode) && (!requireBots || map.botCapable))
    .map(([name]) => name).sort((a, b) => a.localeCompare(b));
}
