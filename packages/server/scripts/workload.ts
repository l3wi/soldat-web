import { encodeInput, type Control } from "@soldat-web/sim-host";

/** Repeatable, human-like authoritative controls; no position/damage injection. */
export function arenaControl(tick: number, player: number, combat = false): Control {
  const phase = (tick + player * 31) % 900;
  const right = phase < 210 || (phase >= 450 && phase < 610);
  const left = (phase >= 230 && phase < 430) || (phase >= 640 && phase < 790);
  return {
    Right: right, Left: left,
    Up: (phase >= 55 && phase < 75) || (phase >= 320 && phase < 340),
    Down: phase >= 470 && phase < 500,
    Jetpack: (phase >= 90 && phase < 140) || (phase >= 540 && phase < 590),
    Prone: phase === 680 || phase === 735,
    Fire: combat && phase % 180 >= 25 && phase % 180 < 60,
    Reload: combat && phase % 180 === 95,
    ThrowNade: combat && phase >= 380 && phase < 400,
    ChangeWeapon: combat && (phase === 620 || phase === 810),
    MouseAimX: Math.round((right ? 450 : -450) + 80 * Math.sin(tick / 47 + player)),
    MouseAimY: Math.round(-90 + 100 * Math.sin(tick / 83 + player)),
    MouseDist: 500,
  };
}
export function arenaInput(tick: number, player: number, combat = false, stackedCombat = false): Uint8Array {
  if (stackedCombat) return encodeInput({ Fire: tick >= 90, MouseAimX: -409, MouseAimY: -75, MouseDist: 500 });
  return encodeInput(arenaControl(tick, player, combat));
}

export function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}
export function distribution(values: readonly number[]) {
  return { count: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), p99: percentile(values, 0.99), max: values.length ? values.reduce((maximum, value) => Math.max(maximum, value), -Infinity) : null };
}
