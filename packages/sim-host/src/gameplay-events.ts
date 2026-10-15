/** Stable ABI 3 gameplay kinds; bit 31 is clear, so replay retains them.
 * Original legacy packet-event IDs remain in their separate low-number range.
 * Payload fields are little-endian i32, in the order documented in sim-abi.md.
 */
export const SIM_GAMEPLAY_EVENTS = {
  DEATH: 0x1001,
  FLAG_INFO: 0x1002,
  THING_TAKEN: 0x1003,
  THING_STATE: 0x1004,
  RESPAWN: 0x1005,
  TEAM_SCORES: 0x1006,
  MATCH_END: 0x1007,
} as const;

export const SIM_GAMEPLAY_PAYLOAD = {
  death: { bytes: 28, weapon: 0, killBullet: 4, bulletStyle: 8, where: 12, killerKills: 16, killerTeam: 20, victimTeam: 24 },
  flagInfo: { bytes: 4, style: 0 },
  thingTaken: { bytes: 8, style: 0, ammo: 4 },
  thingState: { bytes: 20, style: 0, owner: 4, holdingSprite: 8, inBase: 12, timeout: 16 },
  respawn: { bytes: 12, team: 0, weapon: 4, secondaryWeapon: 8 },
  teamScores: { bytes: 24, scores: 0, count: 6 },
  matchEnd: { bytes: 32, counter: 0, gameMode: 4, scores: 8, count: 6 },
} as const;
