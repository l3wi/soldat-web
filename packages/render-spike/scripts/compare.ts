import { PNG } from "pngjs";
import { readFile } from "node:fs/promises";
import { receiptPath } from "../../../scripts/receipt-paths.mjs";
export async function compare(
  referencePath: string,
  actualPath: string,
  threshold = 8,
) {
  const [reference, actual] = await Promise.all(
    [referencePath, actualPath].map(async (path) =>
      PNG.sync.read(await readFile(path)),
    ),
  );
  if (reference.width !== actual.width || reference.height !== actual.height)
    throw Error(
      `Resolution mismatch ${reference.width}x${reference.height} / ${actual.width}x${actual.height}`,
    );
  let differing = 0,
    maxDelta = 0,
    totalDelta = 0;
  for (let p = 0; p < reference.data.length; p += 4) {
    let differs = false;
    for (let c = 0; c < 4; c++) {
      const delta = Math.abs(reference.data[p + c]! - actual.data[p + c]!);
      maxDelta = Math.max(delta, maxDelta);
      totalDelta += delta;
      if (delta > threshold) differs = true;
    }
    if (differs) differing++;
  }
  const pixels = reference.width * reference.height;
  return {
    reference: receiptPath(referencePath),
    actual: receiptPath(actualPath),
    width: reference.width,
    height: reference.height,
    threshold,
    differing,
    pixels,
    percent: (differing / pixels) * 100,
    maxDelta,
    meanChannelDelta: totalDelta / (pixels * 4),
    pass: differing / pixels <= 0.01,
  };
}
if (import.meta.main) {
  const [reference, actual] = process.argv.slice(2);
  if (!reference || !actual)
    throw Error("Usage: bun scripts/compare.ts reference.png actual.png");
  const result = await compare(reference, actual);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.pass ? 0 : 1;
}
