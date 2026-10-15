// Verifies local reference checkouts match pins.json. Exits non-zero on mismatch.
import { $ } from "bun";
import pins from "../pins.json";

const root = new URL("..", import.meta.url).pathname;
let failed = false;

for (const [name, expected] of [
  ["opensoldat", pins.opensoldat.commit],
  ["base", pins.base.commit],
] as const) {
  const dir = `${root}reference/${name}`;
  const head = (await $`git -C ${dir} rev-parse HEAD`.nothrow().quiet().text()).trim();
  if (head !== expected) {
    console.error(`reference/${name}: HEAD ${head || "<missing>"} != pinned ${expected}`);
    failed = true;
  } else {
    console.log(`reference/${name}: ${head} ok`);
  }
}

process.exit(failed ? 1 : 0);
