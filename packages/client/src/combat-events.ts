import { SIM_GAMEPLAY_EVENTS, SIM_GAMEPLAY_PAYLOAD, type RenderView } from "@soldat-web/sim-host";
import type { HudKillEvent, HudPresentation } from "./render/hud";

/** Bounded presentation history fed only by ABI3 native network-shim deaths.
 * Online callers feed the once-only confirmed reliable stream, never replay. */
export class CombatEvents {
  readonly kills: HudKillEvent[] = [];
  readonly presentation: HudPresentation = { killFeedAvailable: true, killEvents: this.kills };
  clear(): void { this.kills.length = 0; }
  drain(bytes: Uint8Array, length: number, world: RenderView): void {
    const data = new DataView(bytes.buffer, bytes.byteOffset, length);
    for (let offset = 0; offset < length;) {
      if (length - offset < 20) throw new Error("Truncated combat event header");
      const kind = data.getUint32(offset, true), tick = data.getUint32(offset + 4, true);
      const source = data.getUint32(offset + 8, true), target = data.getUint32(offset + 12, true);
      const payload = data.getUint32(offset + 16, true), end = offset + 20 + payload;
      if (end > length) throw new Error("Truncated combat event payload");
      // ABI3 death, emitted at ServerSpriteDied's native death-send boundary.
      if (kind === SIM_GAMEPLAY_EVENTS.DEATH) {
        if (payload !== SIM_GAMEPLAY_PAYLOAD.death.bytes) throw new Error("Unsupported native death event");
        const killer = source > 0 && source <= world.slots ? world.sprite(source - 1).playerName : "World";
        const victim = target > 0 && target <= world.slots ? world.sprite(target - 1).playerName : "";
        this.kills.push({ tick, killer: killer || `Slot ${source}`, victim: victim || `Slot ${target}`,
          weapon: data.getInt32(offset + 20, true), killBullet: data.getInt32(offset + 24, true), suicide: source === target, killerKills: data.getInt32(offset + 36, true),
          killerTeam: data.getInt32(offset + 40, true), victimTeam: data.getInt32(offset + 44, true) });
        if (this.kills.length > 32) this.kills.shift();
      }
      offset = end;
    }
  }
}
