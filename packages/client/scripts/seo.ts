import { isIP } from "node:net";
import type { Plugin } from "vite";

const title = "Soldat Online | Unofficial Browser 2D Shooter";
const description = "Play Soldat Online, an unofficial OpenSoldat browser shooter with jetpacks, seven modes, friend games and bots. Desktop keyboard and mouse required.";
const imageAlt = "Soldat Online — an unofficial 2D multiplayer shooter, shown over real Capture the Flag gameplay.";

export interface SeoPolicy {
  /** Undefined outside production builds, even when SITE_URL is supplied. */
  origin?: string;
  indexable: boolean;
}

/** Deployment origins intentionally support public DNS names, not IP literals. */
export function validateSiteUrl(value: string): string {
  const invalid = () => new Error("SITE_URL must be an absolute HTTPS root origin with a public DNS hostname, no credentials, path, query or fragment (for example https://game.example.com)");
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(value)) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const host = url.hostname.toLowerCase();
  const labels = host.split(".");
  if (url.protocol !== "https:" || url.username || url.password || value.includes("@")
    || url.pathname !== "/" || url.search || url.hash || isIP(host) || host.startsWith("[")
    || host.length > 253 || labels.length < 2
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^[a-z][a-z0-9-]*$/.test(labels[labels.length - 1]!)
    || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host)) throw invalid();
  return url.origin;
}

export function seoPolicy(productionBuild: boolean, environment: { SITE_URL?: string; SITE_INDEXABLE?: string }): SeoPolicy {
  const configured = environment.SITE_URL === undefined ? undefined : validateSiteUrl(environment.SITE_URL);
  const indexing = environment.SITE_INDEXABLE;
  if (indexing !== undefined && indexing !== "true" && indexing !== "false") {
    throw new Error("SITE_INDEXABLE must be true or false when supplied");
  }
  if (indexing === "true" && !configured) throw new Error("SITE_INDEXABLE=true requires SITE_URL");
  const origin = productionBuild ? configured : undefined;
  return { origin, indexable: Boolean(origin) && indexing !== "false" };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

/** JSON is data, but a literal closing script tag still terminates an HTML script. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function seoHead(policy: SeoPolicy): string {
  const root = policy.origin ? `${policy.origin}/` : undefined;
  const image = policy.origin ? `${policy.origin}/og-image.png` : undefined;
  const meta = (attribute: "name" | "property", name: string, content: string) =>
    `<meta ${attribute}="${escapeHtml(name)}" content="${escapeHtml(content)}" />`;
  const game = {
    "@type": "VideoGame", name: "Soldat Online", description,
    genre: "Shooter", applicationCategory: "GameApplication", operatingSystem: "Web browser",
    gamePlatform: "Desktop web browser", inLanguage: "en",
    ...(root ? { "@id": `${root}#game`, url: root, image, mainEntityOfPage: root } : {}),
  };
  const website = {
    "@type": "WebSite", name: "Soldat Online", description, inLanguage: "en",
    ...(root ? { "@id": `${root}#website`, url: root, about: { "@id": `${root}#game` } } : { about: game }),
  };
  return [
    `<title>${escapeHtml(title)}</title>`,
    meta("name", "description", description),
    meta("name", "viewport", "width=device-width, initial-scale=1"),
    meta("name", "color-scheme", "dark"),
    meta("name", "theme-color", "#171d13"),
    '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    meta("name", "robots", policy.indexable ? "index, follow" : "noindex, nofollow"),
    ...(root ? [`<link rel="canonical" href="${escapeHtml(root)}" />`] : []),
    meta("property", "og:site_name", "Soldat Online"),
    meta("property", "og:type", "website"),
    meta("property", "og:locale", "en_US"),
    meta("property", "og:title", title),
    meta("property", "og:description", description),
    ...(root && image ? [
      meta("property", "og:url", root), meta("property", "og:image", image),
      meta("property", "og:image:type", "image/png"),
      meta("property", "og:image:width", "1200"), meta("property", "og:image:height", "630"),
      meta("property", "og:image:alt", imageAlt),
    ] : []),
    meta("name", "twitter:card", "summary_large_image"),
    meta("name", "twitter:title", title), meta("name", "twitter:description", description),
    ...(image ? [meta("name", "twitter:image", image), meta("name", "twitter:image:alt", imageAlt)] : []),
    `<script type="application/ld+json">${scriptJson({ "@context": "https://schema.org", "@graph": root ? [website, game] : [website] })}</script>`,
  ].join("\n    ");
}

export function seoDocuments(policy: SeoPolicy): { robots: string; sitemap?: string } {
  if (!policy.indexable || !policy.origin) return { robots: "User-agent: *\nDisallow: /\n" };
  const root = `${policy.origin}/`;
  return {
    robots: [
      "User-agent: *", "Allow: /",
      "# Keep rendering resources and invite previews crawlable; this is not access control.",
      "# Research HTML carries its own noindex metadata.",
      "Disallow: /debug", "Disallow: /api/",
      "", `Sitemap: ${root}sitemap.xml`, "",
    ].join("\n"),
    sitemap: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeHtml(root)}</loc></url></urlset>\n`,
  };
}

/** Emitted Rollup assets exist before gameAssets.writeBundle precompresses output. */
export function seoPlugin(policy: SeoPolicy): Plugin {
  const documents = seoDocuments(policy);
  return {
    name: "soldat-seo",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!html.includes("<!-- seo:head -->")) throw new Error("Missing SEO head insertion point");
        return html.replace("<!-- seo:head -->", seoHead(policy));
      },
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "robots.txt", source: documents.robots });
      if (documents.sitemap) this.emitFile({ type: "asset", fileName: "sitemap.xml", source: documents.sitemap });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        response.setHeader("X-Robots-Tag", "noindex, nofollow");
        const path = (request.url ?? "/").split(/[?#]/, 1)[0];
        if (path !== "/robots.txt" && path !== "/sitemap.xml") return next();
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
        }
        response.setHeader("Cache-Control", "no-store");
        if (path === "/sitemap.xml") { response.statusCode = 404; response.end(); return; }
        const robots = seoDocuments({ indexable: false }).robots;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.setHeader("Content-Length", Buffer.byteLength(robots));
        response.end(request.method === "HEAD" ? undefined : robots);
      });
    },
  };
}
