export interface SandboxOptions {
  mode: "dm" | "ctf";
  bots: number;
  team: 1 | 2;
  botTeam: "balanced" | "alpha" | "bravo";
  botDifficulty: number;
}

export const DEFAULT_SANDBOX: Readonly<SandboxOptions> = {
  mode: "dm", bots: 4, team: 1, botTeam: "balanced", botDifficulty: 100,
};

/** The shell backdrop has no authoritative/local soldier. */
export const ATTRACT_SANDBOX: Readonly<SandboxOptions> = {
  mode: "dm", bots: 8, team: 1, botTeam: "balanced", botDifficulty: 100,
};

/** Names of the pinned original server/configs/bots profiles, not invented AI classes. */
export const BOT_PROFILES = [
  "Admiral", "Billy", "Blain", "Boogie Man", "Commando", "D Dave", "Danko", "Dutch",
  "John", "Kruger", "Poncho", "Roach", "Sgt. Mac", "Sniper", "Stevie", "Terminator",
] as const;

export function sandboxBotTeam(options: SandboxOptions, index: number): number {
  if (options.mode === "dm") return 0;
  if (options.botTeam === "alpha") return 1;
  if (options.botTeam === "bravo") return 2;
  // Count the local player too: the first opponent joins the other team.
  return index % 2 === 0 ? 3 - options.team : options.team;
}

export function validateSandbox(options: SandboxOptions): void {
  if ((options.mode !== "dm" && options.mode !== "ctf") || !Number.isInteger(options.bots) || options.bots < 0 || options.bots > 31 ||
      (options.team !== 1 && options.team !== 2) || !["balanced", "alpha", "bravo"].includes(options.botTeam) ||
      !Number.isInteger(options.botDifficulty) || options.botDifficulty < 0 || options.botDifficulty > 300)
    throw new RangeError("Invalid sandbox options");
}
