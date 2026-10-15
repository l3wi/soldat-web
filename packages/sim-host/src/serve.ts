const bundle = await Bun.build({ entrypoints: [new URL("./browser.ts", import.meta.url).pathname],
  target: "browser", write: false });
if (!bundle.success || !bundle.outputs[0]) throw new Error("Browser spike bundle failed");
const results: unknown[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 4173),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><title>G0.2 Pascal WASM spike</title><h1>Pascal WASM determinism spike</h1><pre>Running…</pre><script type="module" src="/browser.js"></script></html>', { headers: { "content-type": "text/html" } });
    if (path === "/browser.js") return new Response(bundle.outputs[0], { headers: { "content-type": "text/javascript" } });
    if (path === "/spike.wasm") return new Response(Bun.file(new URL("../../../build-out/spike/spike.wasm", import.meta.url)), { headers: { "content-type": "application/wasm" } });
    if (path === "/result" && request.method === "POST") {
      const result: unknown = await request.json();
      results.push(result);
      console.log(JSON.stringify(result));
      return new Response("recorded");
    }
    if (path === "/results") return Response.json(results);
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Spike server: ${server.url}`);
