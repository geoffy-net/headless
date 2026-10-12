/**
 * A page whose site owns its structured data.
 *
 * A site can tell Geoffy not to add structured data ("Structured data: Never" in the dashboard),
 * or a page can already carry its own node of the same type. Geoffy then answers the visible
 * widget with `jsonLd: null`. That is a rendered state, not a missing one: the widget must still
 * render, and no structured-data script may appear.
 *
 * The pairing rule still holds the other way round: structured data with no widget never renders.
 *
 * Tests run against `dist/` (see client.test.js for why).
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { getGeoffyContentMarkup, getGeoffyProductMarkup } from "../dist/astro.js";
import {
  __clearGeoffyManifestMemo,
  fetchGeoffyContent,
  fetchGeoffyProduct,
} from "../dist/client.js";
import { GeoffyContent, GeoffyProduct } from "../dist/next.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  __clearGeoffyManifestMemo();
});

const WIDGET_ONLY = {
  handle: "msc-data-science",
  published: true,
  canonicalUrl: "https://uni.example/en/programmes/msc-data-science",
  jsonLd: null,
  widgetHtml: '<section data-geoffy-product="msc-data-science" data-geoffy-kind="programme"></section>',
  publishedAt: "2026-10-12T10:00:00.000Z",
};

/** The manifest is unreachable, so every render makes the per-page request it always made. */
function answer(body) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/manifest.json")) return new Response("{}", { status: 503 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("fetchGeoffyProduct with no structured data", () => {
  it("returns the widget when the answer says null for the structured data", async () => {
    answer(WIDGET_ONLY);
    const out = await fetchGeoffyProduct({ siteKey: "sk" }, "msc-data-science");
    assert.ok(out, "a widget-only answer is a payload, not nothing");
    assert.equal(out.jsonLd, null);
    assert.equal(out.widgetHtml, WIDGET_ONLY.widgetHtml);
  });

  it("still refuses an answer that leaves the structured data out altogether", async () => {
    // `null` is the server saying "none on this page". A missing key says nothing, so it stays
    // a malformed answer, as before.
    const { jsonLd: _absent, ...noKey } = WIDGET_ONLY;
    answer(noKey);
    assert.equal(await fetchGeoffyProduct({ siteKey: "sk" }, "msc-data-science"), null);
  });

  it("still refuses structured data without the widget", async () => {
    answer({ ...WIDGET_ONLY, jsonLd: { "@type": "Product", name: "x" }, widgetHtml: "" });
    assert.equal(await fetchGeoffyProduct({ siteKey: "sk" }, "msc-data-science"), null);
  });
});

describe("GeoffyProduct (Next) with no structured data", () => {
  it("renders the widget and no structured-data script", async () => {
    answer(WIDGET_ONLY);
    const out = await GeoffyProduct({ siteKey: "sk", handle: "msc-data-science" });
    const rendered = JSON.stringify(out);
    assert.match(rendered, /data-geoffy-kind=/);
    assert.doesNotMatch(rendered, /application\/ld\+json/);
  });
});

describe("getGeoffyProductMarkup (Astro) with no structured data", () => {
  it("returns the widget and an empty script, so the head slot renders nothing", async () => {
    answer(WIDGET_ONLY);
    const out = await getGeoffyProductMarkup({ siteKey: "sk" }, "msc-data-science");
    assert.ok(out);
    assert.equal(out.jsonLdScript, "");
    assert.equal(out.widgetHtml, WIDGET_ONLY.widgetHtml);
  });
});

describe("the content-named exports", () => {
  it("are the product exports under a name for a page that is not a product", () => {
    assert.equal(GeoffyContent, GeoffyProduct);
    assert.equal(getGeoffyContentMarkup, getGeoffyProductMarkup);
    assert.equal(fetchGeoffyContent, fetchGeoffyProduct);
  });
});
