/**
 * Astro entry points.
 *
 * Astro is the easier of the two frameworks to serve honestly, because its default is
 * server rendering — there is no client/server component split to get wrong, and a `.astro`
 * component is server-rendered unless the author explicitly opts out.
 *
 * The trade is that Astro has no built-in equivalent of `revalidateTag`. A site on the
 * Vercel adapter gets incremental regeneration with a bypass token; a fully static build
 * gets neither, and its content changes only when the site rebuilds.
 *
 * Geoffy neither asks for a render mode nor triggers builds, so there is no setting here to get
 * wrong. Astro's two shapes differ only in WHEN a publish surfaces, which is a fact about the
 * build rather than a setting: a server-rendered site picks it up when its cache expires, a
 * static one at its next build. See "How updates reach your page" in the Astro section of the
 * README.
 */

import {
  compareCanonical,
  fetchGeoffyProduct,
  fetchGeoffyText,
  type GeoffyClientOptions,
  type GeoffyProductArtifact,
  handleGeoffyProxy,
  serializeJsonLd,
} from "./client";

export interface GeoffyProductMarkup {
  /** A complete `<script type="application/ld+json">` element. Put it in `<head>`. */
  jsonLdScript: string;
  /** The visible widget, styles included. Render with `set:html`. */
  widgetHtml: string;
  artifact: GeoffyProductArtifact;
}

/**
 * Fetch and pre-render both surfaces for one product.
 *
 * Returns `null` when there is nothing published or Geoffy is unreachable, so the calling
 * component renders nothing and the merchant's page is unaffected.
 *
 *   ---
 *   import { getGeoffyProductMarkup } from "@geoffy/headless/astro";
 *   const geoffy = await getGeoffyProductMarkup({ siteKey: import.meta.env.GEOFFY_SITE_KEY }, handle);
 *   ---
 *   {geoffy && <Fragment set:html={geoffy.jsonLdScript} slot="head" />}
 *   {geoffy && <div data-geoffy-widget set:html={geoffy.widgetHtml} />}
 *
 * Both surfaces are returned together and there is no accessor for one alone, for the same
 * reason the Next component renders them as a pair: structured data without the visible
 * widget is a claim to a crawler that a shopper cannot see.
 *
 * ## `page.canonicalUrl`
 *
 * Pass this page's own canonical and a page that is not the one Geoffy published against gets
 * `null` — the same answer as "nothing published", which the calling component already renders
 * nothing for. Geoffy publishes against ONE canonical URL per product, so without it this
 * renders another page's content wherever it is mounted: the other language on a translated
 * route, or another product entirely where two routes end in the same handle.
 *
 * **Deliberate asymmetry with the Next component**, which leaves an inert `data-geoffy-skipped`
 * marker so a bare page can be diagnosed from view-source. There is nowhere to put one here
 * without changing the call shape every Astro integration already uses, and a returned object
 * with empty markup renders an empty `data-geoffy-widget` div — a Geoffy attribute on a page we
 * just declined to touch. `null` is the honest answer for this shape.
 */
export async function getGeoffyProductMarkup(
  opts: GeoffyClientOptions,
  handle: string,
  page: { canonicalUrl?: string } = {},
): Promise<GeoffyProductMarkup | null> {
  const artifact = await fetchGeoffyProduct(opts, handle);
  if (!artifact) return null;

  // Absent means "no opinion offered". `unknown` renders — an unreadable canonical is no
  // grounds to blank a working page.
  if (
    page.canonicalUrl &&
    compareCanonical(page.canonicalUrl, artifact.canonicalUrl) === "mismatch"
  ) {
    return null;
  }

  return {
    jsonLdScript: `<script type="application/ld+json" data-geoffy>${serializeJsonLd(
      artifact.jsonLd,
    )}</script>`,
    widgetHtml: artifact.widgetHtml,
    artifact,
  };
}

/**
 * Endpoint factory for the site-wide text files.
 *
 *   // src/pages/llms.txt.ts
 *   import { createGeoffyTextEndpoint } from "@geoffy/headless/astro";
 *   export const GET = createGeoffyTextEndpoint({ siteKey: import.meta.env.GEOFFY_SITE_KEY }, "llms.txt");
 *
 * A file named `llms.txt.ts` under `src/pages/` serves `/llms.txt`. Astro matches real
 * files before dynamic routes, so — unlike a framework rewrite — this cannot be swallowed
 * by a catch-all route such as `[...lang]`.
 */
export function createGeoffyTextEndpoint(
  opts: GeoffyClientOptions,
  file: "llms.txt" | "llms-full.txt" | "agents.md",
) {
  return async function GET(): Promise<Response> {
    const body = await fetchGeoffyText(opts, file);
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
 * Mount the whole Geoffy namespace on your own domain. One file, once.
 *
 *   // src/pages/apps/geoffy/[...path].ts
 *   import { createGeoffyProxyEndpoint } from "@geoffy/headless/astro";
 *
 *   export const prerender = false;   // REQUIRED — see below
 *   export const GET = createGeoffyProxyEndpoint({ siteKey: import.meta.env.GEOFFY_SITE_KEY });
 *
 * Serves your per-product plain-text twins, your discovery sitemap and your buying-guide
 * pages from your domain rather than ours, and it is the last route this package will ask you
 * to add — a surface Geoffy ships later appears under the same namespace with no upgrade.
 *
 * **`export const prerender = false` is required, and its absence BREAKS THE BUILD.** This is
 * a rest-param route; a prerendered dynamic route with no `getStaticPaths()` fails
 * `astro build` outright with "getStaticPaths() function required for dynamic routes". Astro 5
 * prerenders by default, so without that line the merchant's deploy stops — which is the one
 * outcome this package exists never to cause.
 *
 * A fully prerendered site cannot serve this route at all — do not add the file. On-demand
 * rendering (an adapter plus `prerender = false` here) is what serves it.
 */
export function createGeoffyProxyEndpoint(opts: GeoffyClientOptions) {
  return async function GET(context: { request: Request }): Promise<Response> {
    return handleGeoffyProxy(opts, context.request);
  };
}
