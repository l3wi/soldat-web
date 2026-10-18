// Verify registered upstream pins; pristine checkouts are optional unless required.
import { $ } from "bun";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pins from "../pins.json";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--require-references")) {
  console.error("Usage: bun scripts/check-pins.ts [--require-references]");
  process.exit(2);
}
const required = args.includes("--require-references");
const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
let failed = false;

for (const [name, expected] of [
  ["opensoldat", pins.opensoldat.commit],
  ["base", pins.base.commit],
] as const) {
  const path = `reference/${name}`;
  const entry = await $`git -C ${root} ls-files --stage -- ${path}`.nothrow().quiet();
  if (entry.exitCode !== 0 || entry.text().trim() !== `160000 ${expected} 0\t${path}`) {
    console.error(`${path}: expected a registered submodule pinned to ${expected}`);
    failed = true;
    continue;
  }

  const directory = `${root}/${path}`;
  const top = await $`git -C ${directory} rev-parse --show-toplevel`.nothrow().quiet();
  // Git otherwise walks upward from an empty submodule directory into this repo.
  const initialized = top.exitCode === 0 && await realpath(top.text().trim()) === await realpath(directory);
  if (!initialized) {
    const instruction = `git submodule update --init -- ${path}`;
    if (required) {
      console.error(`${path}: not initialized; run ${instruction}`);
      failed = true;
    } else {
      console.log(`${path}: ${expected} registered; optional checkout absent (${instruction})`);
    }
    continue;
  }

  const head = await $`git -C ${directory} rev-parse HEAD`.nothrow().quiet();
  if (head.exitCode !== 0 || head.text().trim() !== expected) {
    console.error(`${path}: HEAD ${head.text().trim() || "<missing>"} != pinned ${expected}`);
    failed = true;
    continue;
  }
  const changes = await $`git -C ${directory} status --porcelain --untracked-files=normal`.nothrow().quiet();
  if (changes.exitCode !== 0 || changes.text().trim()) {
    console.error(`${path}: checkout is not pristine; preserve local work before restoring the reference`);
    failed = true;
    continue;
  }
  console.log(`${path}: ${expected} ok (pristine)`);
}

process.exit(failed ? 1 : 0);
