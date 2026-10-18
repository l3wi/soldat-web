// GameMenus.pas:153–170,435–478. Indices are Guns[] menu indices, not weapon NUMs.
export const LIMBO_WEAPONS = [
  { num: 1, name: "Desert Eagles", image: "DEAGLES" },
  { num: 2, name: "HK MP5", image: "MP5" },
  { num: 3, name: "Ak-74", image: "AK74" },
  { num: 4, name: "Steyr AUG", image: "STEYR" },
  { num: 5, name: "Spas-12", image: "SPAS" },
  { num: 6, name: "Ruger 77", image: "RUGER" },
  { num: 7, name: "M79", image: "M79" },
  { num: 8, name: "Barrett M82A1", image: "BARRETT" },
  { num: 9, name: "FN Minimi", image: "MINIMI" },
  { num: 10, name: "XM214 Minigun", image: "MINIGUN" },
  { num: 0, name: "USSOCOM", image: "SOCOM" },
  { num: 11, name: "Combat Knife", image: "KNIFE" },
  { num: 12, name: "Chainsaw", image: "CHAINSAW" },
  { num: 13, name: "LAW", image: "LAW" },
] as const;

/** ControlGame.MenuKeyDown: bare 1–0 primary; Ctrl+1–4 secondary. */
export function limboKeyIndex(code: string, ctrl = false, shift = false, alt = false, meta = false): number {
  if (shift || alt || meta || !/^Digit[0-9]$/.test(code)) return -1;
  const digit = Number(code.slice(5));
  const index = digit === 0 ? 9 : digit - 1;
  return ctrl ? (index < 4 ? index + 10 : -1) : index;
}

/** One-based native WeaponActive/WeaponSel arrays; frozen normal rules enable all 14. */
export function limboWeaponEnabled(index: number, active?: readonly number[], selection?: readonly number[]): boolean {
  return Number.isInteger(index) && index >= 0 && index < LIMBO_WEAPONS.length &&
    (active === undefined || active[index + 1] === 1) &&
    (selection === undefined || selection[index + 1] === 1);
}

export function limboRowY(index: number): number { return 154 + 18 * (index + Number(index >= 10)); }
export function limboHitIndex(x: number, y: number): number {
  if (x < 35 || x > 270) return -1;
  for (let i = 0; i < LIMBO_WEAPONS.length; i++) {
    const top = limboRowY(i);
    if (y >= top && y <= top + 16) return i;
  }
  return -1;
}

/** LimboLock persists across lives. Alive Tab changes auto-show, not an inventory cheat.
 * Auto-show happens on the first life and on each death; respawn keeps the current
 * visibility, so a choice made while dead does not reopen the menu until the next death. */
export class LimboMenu {
  active = false;
  locked = false;
  primary = 4;
  secondary = 0;
  dead = false;
  private observed = false;
  resetRound(): void { this.observed = false; this.active = false; this.dead = false; }
  observe(dead: boolean, primary: number, secondary: number): void {
    if (!this.observed) {
      if (primary >= 1 && primary <= 10) this.primary = primary;
      if (secondary === 0 || (secondary >= 11 && secondary <= 13)) this.secondary = secondary;
    }
    if (!this.observed || (dead && !this.dead)) this.spawn();
    this.dead = dead;
    this.observed = true;
  }
  spawn(): void { this.active = !this.locked; }
  toggle(): void {
    if (this.dead) {
      this.active = !this.active;
      this.locked = !this.active;
    } else {
      this.active = false;
      this.locked = !this.locked;
    }
  }
  selected(index: number): boolean {
    const weapon = LIMBO_WEAPONS[index];
    return weapon !== undefined && weapon.num === (index < 10 ? this.primary : this.secondary);
  }
  choose(index: number): void {
    const weapon = LIMBO_WEAPONS[index];
    if (!weapon) return;
    if (index < 10) { this.primary = weapon.num; this.active = false; }
    else this.secondary = weapon.num;
  }
}
