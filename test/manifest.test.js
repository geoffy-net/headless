/**
 * The product manifest, and the skip it makes possible.
 *
 * Geoffy publishes content for one language of each product. A site that renders the product
 * component on every product page — every locale, published or not — used to make one request
 * per render, and on a translated route that request could never succeed. The manifest lists
 * what IS published, in which language, at which path, so the component can decline before
 * asking.
 *
 * The rule that must never break: a manifest we could not read skips NOTHING. Only a manifest
 * we read, that positively says "not here", stops a request.
 *
 * Tests run against `dist/` (see client.test.js for why).
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import {
  __clearGeoffyManifestMemo,
  decideFromManifest,
  fetchGeoffyManifest,
  matchContentLanguage,
} from "../dist/client.js";
import { getGeoffyProductMarkup } from "../dist/astro.js";
import { GeoffyProduct } from "../dist/next.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const MANIFEST = {
  manifestVersion: 1,
  products: [
    { handle: "blue-widget", language: "en", path: "/en/products/blue-widget" },
    { handle: "legacy", path: "/en/products/legacy" },
  ],
};

const PUBLISHED = {
  handle: "blue-widget",
  published: true,
  canonicalUrl: "https://shop.example/en/products/blue-widget",
  jsonLd: { "@type": "Product", name: "Blue widget", inLanguage: "en" },
  widgetHtml: '<section data-geoffy-product="blue-widget"></section>',
  publishedAt: "2026-09-01T00:00:00.000Z",
};

/**
 * Route by URL: the manifest answers `manifest`, a product answers `PUBLISHED`. Every request is
 * recorded so a test can prove a product request was NOT made.
 */
function stubOrigin({ manifest = { status: 200, body: MANIFEST } } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith("/manifest.json")) {
      if (manifest.throws) throw new Error("network down");
      return new Response(JSON.stringify(manifest.body), {
        status: manifest.status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify(PUBLISHED), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    productRequests: () => calls.filter((c) => c.url.includes("/products/")).length,
  };
}

beforeEach(() => {
  __clearGeoffyManifestMemo();
});

/** The language match rule, case by case. */
const CONTENT_LANGUAGE_MATCH_CASES = [
  ["en", "en", "match"],
  ["en-US", "en-GB", "match"],
  ["en_GB", "en", "match"],
  ["EN", "en-gb", "match"],
  ["sr", "sr-RS", "match"],
  ["sr-Latn-RS", "sr", "match"],
  ["it", "en", "mismatch"],
  ["ar", "en-GB", "mismatch"],
  ["de-DE", "sr", "mismatch"],
  ["pt-BR", "pt-PT", "match"],
  [null, "en", "unknown"],
  ["", "en", "unknown"],
  ["english", "en", "unknown"],
  ["en", null, "unknown"],
  ["en", "not a tag", "unknown"],
];

describe("matchContentLanguage — the match rule", () => {
  for (const [page, content, verdict] of CONTENT_LANGUAGE_MATCH_CASES) {
    it(`page ${JSON.stringify(page)} vs content ${JSON.stringify(content)} → ${verdict}`, () => {
      assert.equal(matchContentLanguage(page, content), verdict);
    });
  }
});

describe("fetchGeoffyManifest", () => {
  it("returns the manifest, cached under the tag every product publish purges", async () => {
    const { calls } = stubOrigin();
    assert.deepEqual(await fetchGeoffyManifest({ siteKey: "sk" }), MANIFEST);
    assert.ok(calls[0].url.endsWith("/headless/sk/manifest.json"), calls[0].url);
    assert.deepEqual(calls[0].init.next.tags, ["geoffy:root-files"]);
  });

  for (const [label, manifest] of [
    ["a non-OK status", { status: 503, body: {} }],
    ["an unknown manifest version", { status: 200, body: { manifestVersion: 2, products: [] } }],
    ["a missing product list", { status: 200, body: { manifestVersion: 1 } }],
    ["an entry with no handle", { status: 200, body: { manifestVersion: 1, products: [{ path: "/x" }] } }],
    ["a network failure", { throws: true }],
  ]) {
    it(`returns null for ${label}`, async () => {
      stubOrigin({ manifest });
      assert.equal(await fetchGeoffyManifest({ siteKey: "sk" }), null);
    });
  }
});

describe("decideFromManifest", () => {
  it("renders a listed handle with no page facts to compare", () => {
    assert.deepEqual(decideFromManifest(MANIFEST, "blue-widget"), { render: true });
  });

  it("skips a handle the manifest does not list", () => {
    assert.deepEqual(decideFromManifest(MANIFEST, "robot-za-lakiranje"), {
      render: false,
      reason: "not-published",
    });
  });

  it("skips a listed handle on a page in another language", () => {
    assert.deepEqual(decideFromManifest(MANIFEST, "blue-widget", { locale: "sr-RS" }), {
      render: false,
      reason: "language-mismatch",
    });
  });

  it("renders when the entry's language is unknown, whatever the page locale", () => {
    assert.deepEqual(decideFromManifest(MANIFEST, "legacy", { locale: "sr" }), { render: true });
  });

  it("skips a listed handle whose page is not the published path", () => {
    assert.deepEqual(
      decideFromManifest(MANIFEST, "blue-widget", {
        canonicalUrl: "https://shop.example/sv/products/blue-widget",
      }),
      { render: false, reason: "canonical-mismatch" },
    );
  });
});

describe("GeoffyProduct (Next) — manifest first, fail open", () => {
  it("makes NO product request for a handle the manifest does not list", async () => {
    const origin = stubOrigin();
    const out = await GeoffyProduct({ siteKey: "sk", handle: "robot-za-lakiranje" });
    assert.equal(out, null);
    assert.equal(origin.calls.length, 1); // the manifest, and only the manifest
    assert.equal(origin.productRequests(), 0);
  });

  it("makes NO product request on a translated page, and leaves the skip marker", async () => {
    const origin = stubOrigin();
    const out = await GeoffyProduct({ siteKey: "sk", handle: "blue-widget", locale: "de" });
    assert.equal(origin.productRequests(), 0);
    assert.ok(out, "a marker element, not null");
    assert.match(JSON.stringify(out.props), /language-mismatch/);
  });

  it("fetches and renders a listed handle on a page in its language", async () => {
    const origin = stubOrigin();
    const out = await GeoffyProduct({ siteKey: "sk", handle: "blue-widget", locale: "en-GB" });
    assert.equal(origin.productRequests(), 1);
    assert.ok(out);
    assert.match(JSON.stringify(out), /data-geoffy-product=/);
  });

  it("falls back to the per-handle request when the manifest cannot be read", async () => {
    const origin = stubOrigin({ manifest: { status: 503, body: {} } });
    const out = await GeoffyProduct({ siteKey: "sk", handle: "robot-za-lakiranje" });
    assert.equal(origin.productRequests(), 1);
    assert.ok(out, "a published page still renders when Geoffy's manifest is down");
  });
});

describe("getGeoffyProductMarkup (Astro) — manifest first, fail open", () => {
  it("makes no product request for an unlisted handle", async () => {
    const origin = stubOrigin();
    assert.equal(await getGeoffyProductMarkup({ siteKey: "sk" }, "robot-za-lakiranje"), null);
    assert.equal(origin.productRequests(), 0);
  });

  it("returns null without a product request on a translated page", async () => {
    const origin = stubOrigin();
    const out = await getGeoffyProductMarkup({ siteKey: "sk" }, "blue-widget", { locale: "sv" });
    assert.equal(out, null);
    assert.equal(origin.productRequests(), 0);
  });

  it("renders a listed handle, and still renders when the manifest is unreachable", async () => {
    let origin = stubOrigin();
    assert.ok(await getGeoffyProductMarkup({ siteKey: "sk" }, "blue-widget", { locale: "en" }));
    assert.equal(origin.productRequests(), 1);

    __clearGeoffyManifestMemo();
    origin = stubOrigin({ manifest: { throws: true } });
    assert.ok(await getGeoffyProductMarkup({ siteKey: "sk" }, "blue-widget"));
    assert.equal(origin.productRequests(), 1);
  });
});
