import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeHtml, scriptJson, seoDocuments, seoHead, seoPlugin, seoPolicy, validateSiteUrl } from "./seo.ts";

function attributes(html: string, tag: string): Record<string, string>[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))].map(match =>
    Object.fromEntries([...match[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)].map(attribute => [attribute[1]!, attribute[2]!])),
  );
}
function meta(html: string, name: string): string | undefined {
  return attributes(html, "meta").find(attribute => attribute.name === name || attribute.property === name)?.content;
}
function structuredData(html: string): { "@context": string; "@graph": Record<string, unknown>[] } {
  const source = html.match(/<script type="application\/ld\+json">([^]*?)<\/script>/)?.[1];
  assert.ok(source, "JSON-LD is present in the initial HTML");
  return JSON.parse(source);
}

async function transform(originalUrl: string, policy = seoPolicy(true, { SITE_URL: "https://soldat.example.com" })): Promise<string> {
  const hook = seoPlugin(policy).transformIndexHtml;
  assert.ok(hook && typeof hook === "object" && "handler" in hook);
  const html = await hook.handler('<!doctype html><html><head><!-- seo:head --></head><body><div id="root"></div></body></html>', {
    path: "/index.html", filename: "/client/index.html", originalUrl,
  });
  assert.equal(typeof html, "string");
  return html as string;
}

describe("build-time SEO policy", () => {
  it("normalizes valid HTTPS DNS origins and accepts explicit staging policy", () => {
    assert.equal(validateSiteUrl("https://Game.Example.com/"), "https://game.example.com");
    assert.equal(validateSiteUrl("https://game.example.com:443"), "https://game.example.com");
    assert.equal(validateSiteUrl("https://game.example.com:8443/"), "https://game.example.com:8443");
    const staging = seoPolicy(true, { SITE_URL: "https://stage.example.com", SITE_INDEXABLE: "false" });
    assert.equal(staging.origin, "https://stage.example.com");
    assert.equal(staging.indexable, false);
    assert.equal(meta(seoHead(staging), "robots"), "noindex, nofollow");
    assert.equal(seoDocuments(staging).sitemap, undefined);
    assert.match(seoDocuments(staging).robots, /^User-agent: \*\nDisallow: \/\n$/);
  });

  it("fails closed on malformed, non-root, local or literal-IP configuration", () => {
    for (const origin of [
      "", "example.com", "/", "http://game.example.com", "https://game.example.com/play", "https://game.example.com/../",
      "https://game.example.com?lobby=secret", "https://game.example.com?", "https://game.example.com/#game", "https://game.example.com#",
      "https://user:password@game.example.com", "https://@game.example.com", " https://game.example.com", "https://game.example.com\n",
      "https://game.example.com\\", "https://localhost", "https://play.localhost", "https://game.local", "https://game.internal",
      "https://game.home", "https://game.lan", "https://127.0.0.1", "https://127.1", "https://0x7f000001",
      "https://10.0.0.1", "https://172.16.0.1", "https://192.168.1.2", "https://169.254.1.1", "https://0.0.0.0",
      "https://[::1]", "https://[fd00::1]", "https://8.8.8.8", "https://-bad.example.com", "https://bad_.example.com",
    ]) assert.throws(() => validateSiteUrl(origin), /SITE_URL/, origin);
    for (const indexing of ["", "yes", "0", "FALSE", " true"]) {
      assert.throws(() => seoPolicy(true, { SITE_URL: "https://game.example.com", SITE_INDEXABLE: indexing }), /SITE_INDEXABLE/);
    }
    assert.throws(() => seoPolicy(true, { SITE_INDEXABLE: "true" }), /requires SITE_URL/);
  });

  it("never publishes absolute deployment URLs or indexing permission in development or unconfigured builds", () => {
    for (const policy of [seoPolicy(false, {}), seoPolicy(false, { SITE_URL: "https://game.example.com", SITE_INDEXABLE: "true" }), seoPolicy(true, {})]) {
      const html = seoHead(policy);
      assert.equal(policy.indexable, false);
      assert.equal(policy.origin, undefined);
      assert.equal(meta(html, "robots"), "noindex, nofollow");
      assert.equal(attributes(html, "link").find(link => link.rel === "canonical"), undefined);
      for (const name of ["og:url", "og:image", "twitter:image"]) assert.equal(meta(html, name), undefined);
      assert.equal(seoDocuments(policy).sitemap, undefined);
      assert.match(seoDocuments(policy).robots, /Disallow: \/\n/);
      assert.ok(!structuredData(html)["@graph"].some(node => "url" in node));
    }
  });

  it("renders complete absolute social metadata and linked genuine schema entities without inventing an organization", () => {
    const policy = seoPolicy(true, { SITE_URL: "https://game.example.com" });
    const html = seoHead(policy);
    const root = `${policy.origin}/`;
    assert.equal(attributes(html, "link").find(link => link.rel === "canonical")?.href, root);
    assert.equal(meta(html, "og:url"), root);
    assert.equal(meta(html, "og:image"), `${root}og-image.png`);
    assert.equal(meta(html, "twitter:image"), `${root}og-image.png`);
    assert.equal(meta(html, "og:image:type"), "image/png");
    assert.equal(Number(meta(html, "og:image:width")), 1200);
    assert.equal(Number(meta(html, "og:image:height")), 630);
    assert.ok(meta(html, "og:image:alt")?.includes("real Capture the Flag gameplay"));
    assert.equal(meta(html, "twitter:image:alt"), meta(html, "og:image:alt"));
    assert.equal(meta(html, "twitter:card"), "summary_large_image");
    assert.equal(meta(html, "twitter:site"), undefined);
    assert.equal(meta(html, "twitter:creator"), undefined);
    assert.equal(meta(html, "robots"), "index, follow");
    assert.equal(meta(html, "og:description"), meta(html, "description"));
    assert.equal(meta(html, "twitter:title"), meta(html, "og:title"));
    assert.match(meta(html, "description")!, /unofficial/i);
    const schema = structuredData(html);
    assert.equal(schema["@context"], "https://schema.org");
    assert.deepEqual(schema["@graph"].map(node => node["@type"]).sort(), ["VideoGame", "WebSite"]);
    const game = schema["@graph"].find(node => node["@type"] === "VideoGame")!;
    const website = schema["@graph"].find(node => node["@type"] === "WebSite")!;
    assert.equal(game.url, root);
    assert.equal(game.image, `${root}og-image.png`);
    assert.deepEqual(website.about, { "@id": game["@id"] });
    assert.ok(!("aggregateRating" in game) && !("publisher" in game));
  });

  it("canonicalizes lobby, private and tracking requests to the same deployment root without leaking their values", async () => {
    for (const request of ["/", "/?lobby=SECRET", "/?join=PRIVATE&token=hidden", "/?utm_source=share#lobby", "/index.html?room=SECRET"]) {
      const html = await transform(request);
      assert.equal(attributes(html, "link").find(link => link.rel === "canonical")?.href, "https://soldat.example.com/");
      assert.equal(meta(html, "og:url"), "https://soldat.example.com/");
      assert.ok(!html.includes("SECRET") && !html.includes("PRIVATE") && !html.includes("hidden"));
    }
  });

  it("keeps invites and rendering resources crawlable while advertising only the canonical root", () => {
    const policy = seoPolicy(true, { SITE_URL: "https://game.example.com" });
    const documents = seoDocuments(policy);
    const locations = [...documents.sitemap!.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1]);
    assert.deepEqual(locations, [`${policy.origin}/`]);
    assert.match(documents.sitemap!, /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/);
    assert.match(documents.robots, new RegExp(`Sitemap: ${policy.origin}/sitemap\\.xml`));
    const blocked = documents.robots.split("\n").filter(line => line.startsWith("Disallow: "))
      .map(line => new RegExp("^" + line.slice("Disallow: ".length).split("*")
        .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")));
    for (const path of [
      "/?lobby=SECRET", "/?join=PRIVATE&token=hidden", "/index.html?room=SECRET",
      "/assets/index-AbC123_x.js", "/assets/index-AbC123_x.css", "/assets/sim-hash.wasm",
      "/content/index.json", "/content/objects/image.webp", "/mockups/assets/play-regular.ttf", "/og-image.png",
    ]) {
      assert.equal(blocked.some(rule => rule.test(path)), false, path);
    }
    for (const path of ["/api/regions", "/debug"]) assert.equal(blocked.some(rule => rule.test(path)), true, path);
  });

  it("escapes arbitrary HTML attributes and script data without altering JSON meaning", () => {
    assert.equal(escapeHtml('&<>"\''), "&amp;&lt;&gt;&quot;&#39;");
    const payload = { title: '</script><img src=x onerror="alert(1)">&\u2028\u2029', nested: ["<", ">", "&"] };
    const encoded = scriptJson(payload);
    assert.ok(!/[<>&\u2028\u2029]/.test(encoded));
    assert.deepEqual(JSON.parse(encoded), payload);
    assert.ok(!encoded.includes("</script>"));
    assert.equal(attributes(`<meta content="${escapeHtml(payload.title)}" />`, "meta").length, 1);
  });
});
