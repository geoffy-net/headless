/**
 * Next.js App Router entry points.
 *
 * Every export here is server-only. There is deliberately no `"use client"` anywhere in
 * this package and no hook: content rendered on the client is invisible to the AI crawlers
 * this product exists to reach, so a client component would compile, render, look correct
 * in a browser, and deliver nothing.
 */

import {
  compareCanonical,
  fetchGeoffyProduct,
  fetchGeoffyText,
  type GeoffyClientOptions,
  GEOFFY_NAMESPACE_TAG,
  handleGeoffyProxy,
  serializeJsonLd,
  skippedMarker,
} from "./client";

export interface GeoffyProductProps extends GeoffyClientOptions {
  /** The product handle — the same value your product route already has. */
  handle: string;
  /**
   * This page's own canonical — the value you already compute for `generateMetadata`. May be
   * absolute or a bare path.
   *
   * Optional, and worth passing. Geoffy publishes against ONE canonical URL per product, and
   * this component otherwise renders wherever it is mounted: on a page that is not that URL it
   * will render another page's content — the other language on a translated route, or another
   * product entirely where two routes end in the same handle. Pass this and it renders nothing
   * there instead.
   */
  canonicalUrl?: string;
}

/**
 * Renders the visible widget and the structured data for one product.
 *
 * Renders `null` when Geoffy has nothing published, or is unreachable. Put it wherever on
 * the product page you want the widget to appear; the structured data travels with it and
 * that pairing is not configurable, because a page that carries one without the other makes
 * claims to a crawler that a shopper cannot see.
 *
 *   export default async function Page({ params }) {
 *     const { handle } = await params;
 *     return (
 *       <>
 *         <YourProductUI />
 *         <GeoffyProduct siteKey={process.env.GEOFFY_SITE_KEY!} handle={handle} />
 *       </>
 *     );
 *   }
 */
export async function GeoffyProduct({ handle, canonicalUrl, ...opts }: GeoffyProductProps) {
  const artifact = await fetchGeoffyProduct(opts, handle);
  if (!artifact) return null;

  // Only when the caller supplied a canonical. Absent means "no opinion offered", which is
  // the behaviour every existing integration already has.
  const verdict = canonicalUrl
    ? compareCanonical(canonicalUrl, artifact.canonicalUrl)
    : "match";

  const detail = `page ${canonicalUrl} · published against ${artifact.canonicalUrl}`;

  // A mismatch renders NOTHING but the marker. Every other failure in this package renders
  // nothing at all, so the marker is what stops "we declined" and "nothing is published" from
  // being the same picture when somebody reads the source to find out why the page is bare.
  if (verdict === "mismatch") {
    // biome-ignore lint/security/noDangerouslySetInnerHtml: an inert marker this package built
    // from its own strings, escaped by `serializeJsonLd`. It renders no merchant input beyond
    // a URL the caller handed us.
    return (
      <div
        data-geoffy-skipped=""
        dangerouslySetInnerHTML={{ __html: skippedMarker("canonical-mismatch", detail) }}
      />
    );
  }

  return (
    <>
      {/* `unknown` renders normally — an unreadable canonical is no grounds to blank a working
          page — but it must not look like a guard that ran and passed. */}
      {verdict === "unknown" && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: as above.
        <div
          data-geoffy-skipped=""
          dangerouslySetInnerHTML={{ __html: skippedMarker("canonical-unreadable", detail) }}
        />
      )}
      {/*
        Server-rendered into the HTML. This must not become a `next/script` with a client
        strategy: that injects the tag after hydration, and a crawler that does not run
        JavaScript never sees it.
      */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a JSON-LD script element has
          no React equivalent — its content is character data, not children. The value is
          serialised by `serializeJsonLd`, which escapes `<` so no string in the node can
          close the tag early, and the node itself is built by Geoffy's server-side emitter
          from vocabulary-gated fields rather than from raw merchant input. */}
      <script
        type="application/ld+json"
        data-geoffy=""
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(artifact.jsonLd) }}
      />
      {/*
        The widget's CSS travels INSIDE this HTML as a <style> element. Do not run it
        through a sanitiser that strips <style> — the widget then renders unstyled on a
        live storefront, which is a failure that looks like a design bug and gets
        diagnosed as one.
      */}
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: the widget IS HTML — a
          server-rendered fragment produced by Geoffy's own renderer, which escapes every
          merchant-supplied value on the way in. It is not user input reaching a page; it is
          our output reaching the page it was rendered for. Re-parsing it into React
          elements here would fork the renderer and break the widget/JSON-LD parity check
          that guarantees the two surfaces say the same thing. */}
      <div data-geoffy-widget="" dangerouslySetInnerHTML={{ __html: artifact.widgetHtml }} />
    </>
  );
}

/**
 * Route handler factory for the site-wide text files.
 *
 * Use it once per file:
 *
 *   // app/llms.txt/route.ts
 *   import { createGeoffyTextRoute } from "@geoffy/headless/next";
 *   export const GET = createGeoffyTextRoute({ siteKey: process.env.GEOFFY_SITE_KEY! }, "llms.txt");
 *
 * A route handler rather than a rewrite in `next.config.js`, on purpose. A rewrite is one
 * line shorter and one trap deeper: rewrites must sit in `beforeFiles` to win against a
 * catch-all segment such as `app/[lang]`, and a catch-all that swallows `/llms.txt` returns
 * your home page with HTTP 200 — which reads to a crawler as a successful answer rather
 * than a missing file.
 */
export function createGeoffyTextRoute(
  opts: GeoffyClientOptions,
  file: "llms.txt" | "llms-full.txt" | "agents.md",
) {
  return async function GET(): Promise<Response> {
    const body = await fetchGeoffyText(opts, file);

    // 404 rather than an empty 200. An empty file served successfully tells an agent that
    // this site has nothing to say; a 404 tells it to come back.
    if (body === null) {
      return new Response("Not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      },
    });
  };
}

/**
 * The cache-life profile this route hands Next 16's `revalidateTag`, and the reason it is not
 * the `"max"` that Next's own examples recommend.
 *
 * The second argument does NOT say how long to keep the data. `revalidateTag` marks the tag
 * stale immediately in every case; the profile says only how long STALE content may still be
 * served while the revalidation runs behind it. So `"max"` — a one-year window — means the
 * first visitor after a publish is still served the pre-publish page, which is exactly the
 * delay this route exists to remove. `{ expire: 0 }` serves no stale content, so the next
 * request blocks and gets the new content.
 *
 * That is Next's own guidance for an invalidation arriving from outside a Server Action:
 * `updateTag` is unavailable in a Route Handler, and a webhook should pass `{ expire: 0 }`.
 *
 * It is also what the deprecated one-argument `revalidateTag(tag)` already does, so this
 * changes no behaviour for a site on Next 16 — it stops relying on a deprecated call that
 * Next says may be removed. On Next 15 the argument is ignored, harmlessly.
 */
const EXPIRE_NOW = { expire: 0 } as const;

/**
 * The endpoint Geoffy calls to tell your site a product changed.
 *
 *   // app/api/geoffy/revalidate/route.ts   <- this exact path
 *   import { revalidateTag } from "next/cache";
 *   import { createGeoffyRevalidateRoute } from "@geoffy/headless/next";
 *   export const POST = createGeoffyRevalidateRoute({ secret: process.env.GEOFFY_REVALIDATE_SECRET!, revalidateTag });
 *
 * ⚠️ **The path is part of the contract.** Geoffy builds the address it calls from the domain
 * you verified — `https://<public domain>/api/geoffy/revalidate` — and there is no field
 * anywhere to override it. Mounting this handler at any other path means nothing ever calls it,
 * silently, because a failed invalidation is survivable and is not reported as a publish
 * failure. It was a URL a merchant typed into Geoffy's settings once; that field is
 * gone.
 *
 * `GEOFFY_REVALIDATE_SECRET` is issued BY Geoffy and shown on the site's settings page — it is
 * copied out, not invented. Rotating it there takes effect immediately, so the environment has
 * to be updated and redeployed or this route starts rejecting real calls as forged.
 *
 * `revalidateTag` is passed in rather than imported here so this package does not depend on
 * a specific Next version's module layout. Pass it BARE — the profile Next 16 wants is supplied
 * here, by `EXPIRE_NOW` above, so a merchant never has to reason about cache semantics to mount
 * a webhook.
 *
 * Losing this call is survivable by design — the revalidate window refreshes the page
 * anyway. It exists to turn "within the hour" into "within seconds", not to be the only
 * path by which content goes live.
 */
export function createGeoffyRevalidateRoute(config: {
  secret: string;
  // The second parameter is optional so BOTH versions of Next's own `revalidateTag` stay
  // assignable and the merchant can keep passing it bare: Next 15's is `(tag: string) => void`,
  // and Next 16 widened it to `(tag: string, profile: string | CacheLifeConfig)`. This route
  // supplies the profile itself (see the call sites below), so the merchant never chooses one.
  revalidateTag: (tag: string, profile?: string | { expire?: number }) => void;
}) {
  return async function POST(request: Request): Promise<Response> {
    // The header carries an HMAC of the body, never the secret itself. A raw secret could be
    // replayed by anyone who observed it, and a redirect on this endpoint would forward it
    // verbatim to a third origin. Binding the signature to the body also means a captured
    // header cannot be reused for a different product.
    const provided = request.headers.get("x-geoffy-signature") ?? "";
    const body = await request.text();

    if (!config.secret || !(await signatureMatches(config.secret, body, provided))) {
      return new Response("Unauthorized\n", { status: 401 });
    }

    let payload: { handle?: string; scope?: string };
    try {
      payload = JSON.parse(body) as { handle?: string; scope?: string };
    } catch {
      return new Response("Bad request\n", { status: 400 });
    }

    // Two shapes, because Geoffy sends two. A product names itself; a guide changes the
    // namespace as a whole and sends `{ scope: "namespace" }` — there is no product handle to
    // send. Accepting only `handle` meant every guide publish answered 400 and the namespace
    // was never purged at all, so guides went live within the hour instead of within seconds
    // while both sides believed the wiring was complete.
    const { handle, scope } = payload;
    if (!handle && scope !== "namespace") return new Response("Bad request\n", { status: 400 });

    if (handle) {
      config.revalidateTag(`geoffy:product:${handle}`, EXPIRE_NOW);
      config.revalidateTag("geoffy:root-files", EXPIRE_NOW);
    }

    // Always, for both shapes: a product publish changes that product's markdown twin and the
    // sitemap that lists it, and both are served through the namespace. Purging only the
    // product tag would leave the twin stale behind a fresh widget.
    config.revalidateTag(GEOFFY_NAMESPACE_TAG, EXPIRE_NOW);
    return new Response(JSON.stringify({ revalidated: true }), {
      headers: { "content-type": "application/json" },
    });
  };
}

/**
 * Compare the signature in constant time, via WebCrypto so this stays runtime-agnostic —
 * the same file has to work on Node and on an edge runtime, and `node:crypto` is not
 * available on the latter.
 *
 * Both sides are digested before comparison, so the compare is over two fixed-length values
 * and leaks neither the secret's length nor an early-exit position.
 */
async function signatureMatches(secret: string, body: string, provided: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = `sha256=${[...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;

  // Digest both sides so the loop below always runs over equal-length inputs.
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i += 1) diff |= (av[i] ?? 0) ^ (bv[i] ?? 0);
  return diff === 0;
}

/**
 * Mount the whole Geoffy namespace on your own domain. One file, once.
 *
 *   // app/apps/geoffy/[...path]/route.ts
 *   import { createGeoffyProxyRoute } from "@geoffy/headless/next";
 *   export const GET = createGeoffyProxyRoute({ siteKey: process.env.GEOFFY_SITE_KEY! });
 *   export const revalidate = 3600;
 *
 * That serves your per-product plain-text twins, your discovery sitemap and your buying-guide
 * pages from your domain instead of ours, and it is the last route this package will ask you
 * to add — anything Geoffy ships later appears under the same namespace with no upgrade.
 *
 * `apps` and `geoffy` are static segments, so this wins against a root catch-all such as
 * `app/[lang]` without any config. That is the opposite of the rewrite problem described on
 * `createGeoffyTextRoute`: rewrites lose that race, route segments win it.
 *
 * The freshness window is `revalidateSeconds` on the options object, NOT a route-segment
 * `export const revalidate`. This handler reads `request.url`, which makes the route dynamic,
 * so the segment export has no cached response to govern. What is cached is the fetch inside,
 * and that is what `revalidateSeconds` sets.
 */
export function createGeoffyProxyRoute(opts: GeoffyClientOptions) {
  return async function GET(request: Request): Promise<Response> {
    return handleGeoffyProxy(opts, request);
  };
}
