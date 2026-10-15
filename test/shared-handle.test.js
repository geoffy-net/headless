/**
 * Two pages, one handle.
 *
 * A handle is the last segment of a page's URL, so two pages can share one: a programme in two
 * languages with an untranslated slug (`/de/programmes/data-science` and
 * `/programmes/data-science`), or two products in different categories that end in the same
 * word. Geoffy publishes content per PAGE. When the page tells us its canonical, we ask for that
 * page's content and pick that page's manifest entry, so each page renders its own.
 *
 * The two rules that must hold:
 *
 * - With `canonicalUrl`, each page gets its own content, whichever page was published last.
 * - Against a Geoffy server that lists one entry per handle and ignores the path, this package
 *   renders exactly what the previous release rendered.
 *
 * Tests run against `dist/` (see client.test.js for why).
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { getGeoffyProductMarkup } from "../dist/astro.js";
import {
  __clearGeoffyManifestMemo,
  compareCanonical,
  decideFromManifest,
  fetchGeoffyProduct,
} from "../dist/client.js";
import { GeoffyProduct } from "../dist/next.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const ORIGIN = "https://school.example";
const DE_PATH = "/de/programmes/data-science";
const EN_PATH = "/programmes/data-science";

function artifact(path, language, name) {
  return {
    handle: "data-science",
    published: true,
    canonicalUrl: `${ORIGIN}${path}`,
    jsonLd: { "@type": "EducationalOccupationalProgram", name, inLanguage: language },
    widgetHtml: `<section data-geoffy-product="data-science" lang="${language}">${name}</section>`,
    publishedAt: "2026-10-16T10:00:00.000Z",
  };
}
const DE = artifact(DE_PATH, "de", "Data Science (Master)");
const EN = artifact(EN_PATH, "en", "Data Science (master's)");

/** A current server: every page in the manifest (latest publish first) and a path-aware route. */
const CURRENT_MANIFEST = {
  manifestVersion: 1,
  products: [
    { handle: "data-science", language: "en", path: EN_PATH },
    { handle: "data-science", language: "de", path: DE_PATH },
  ],
};
/** An older server: one entry per handle (the latest publish), and the path is ignored. */
const OLDER_MANIFEST = {
  manifestVersion: 1,
  products: [{ handle: "data-science", language: "en", path: EN_PATH }],
};

/**
 * Route the stub like the server: the item route answers by `path` when the server is current,
 * and with the latest publish (English) otherwise. Every request is recorded.
 */
function stubOrigin({ server = "current" } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(String(url));
    calls.push({ url: u, init });
    if (u.pathname.endsWith("/manifest.json")) {
      const body = server === "current" ? CURRENT_MANIFEST : OLDER_MANIFEST;
      return Response.json(body);
    }
    const path = u.searchParams.get("path");
    if (server === "current" && path) {
      if (path === DE_PATH) return Response.json(DE);
      if (path === EN_PATH) return Response.json(EN);
      return Response.json({ handle: "data-science", published: false });
    }
    return Response.json(EN);
  };
  return { calls, itemRequests: () => calls.filter((c) => /\/(products|items)\//.test(c.url.pathname)) };
}

beforeEach(() => {
  __clearGeoffyManifestMemo();
});

/**
 * How two paths are compared. Geoffy's server compares the path this package sends by the same
 * rule, and pins the same cases on its side: `decodeURI`, so non-ASCII and the case of an escape
 * do not matter, while a reserved escape such as `%2F` stays.
 */
describe("compareCanonical — the path rule both sides share", () => {
  for (const [page, published, verdict] of [
    ["/de/büro", "https://school.example/de/b%C3%BCro", "match"],
    ["/de/b%c3%bcro", "/de/b%C3%BCro", "match"],
    ["/a%2Fb", "/a/b", "mismatch"],
    ["/de/50%-rabatt", "/de/50%-rabatt", "match"],
    ["https://preview.example/de/programmes/data-science/", DE_PATH, "match"],
  ]) {
    it(`${page} vs ${published} → ${verdict}`, () => {
      assert.equal(compareCanonical(page, published), verdict);
    });
  }
});

describe("fetchGeoffyProduct — asks for the page, not only the handle", () => {
  it("sends the path of the page's canonical", async () => {
    const origin = stubOrigin();
    const got = await fetchGeoffyProduct({ siteKey: "sk" }, "data-science", {
      canonicalUrl: `${ORIGIN}${DE_PATH}/`,
    });
    assert.equal(got?.canonicalUrl, DE.canonicalUrl);
    const [call] = origin.itemRequests();
    assert.equal(call.url.searchParams.get("path"), DE_PATH);
    // The purge tag stays per handle: a publish of either page refreshes both.
    assert.deepEqual(call.init.next.tags, ["geoffy:product:data-science"]);
  });

  it("sends the path still encoded, so Geoffy decodes it exactly once", async () => {
    const origin = stubOrigin();
    await fetchGeoffyProduct({ siteKey: "sk" }, "rabatt", {
      canonicalUrl: `${ORIGIN}/de/b%C3%BCro/50%2525-rabatt`,
    });
    assert.equal(origin.itemRequests()[0].url.searchParams.get("path"), "/de/b%C3%BCro/50%2525-rabatt");
  });

  it("sends no path without a canonical, exactly as before", async () => {
    const origin = stubOrigin();
    await fetchGeoffyProduct({ siteKey: "sk" }, "data-science");
    const [call] = origin.itemRequests();
    assert.equal(call.url.search, "");
  });

  it("sends no path for a canonical it cannot read", async () => {
    const origin = stubOrigin();
    await fetchGeoffyProduct({ siteKey: "sk" }, "data-science", { canonicalUrl: "not a url" });
    assert.equal(origin.itemRequests()[0].url.search, "");
  });
});

describe("decideFromManifest — the page's own entry", () => {
  it("renders the German page from its own entry, though English is listed first", () => {
    assert.deepEqual(
      decideFromManifest(CURRENT_MANIFEST, "data-science", {
        locale: "de",
        canonicalUrl: `${ORIGIN}${DE_PATH}`,
      }),
      { render: true },
    );
  });

  it("renders the English page from its own entry", () => {
    assert.deepEqual(
      decideFromManifest(CURRENT_MANIFEST, "data-science", {
        locale: "en",
        canonicalUrl: `${ORIGIN}${EN_PATH}`,
      }),
      { render: true },
    );
  });

  it("declines a page no entry is published for, though the handle is listed", () => {
    assert.deepEqual(
      decideFromManifest(CURRENT_MANIFEST, "data-science", {
        canonicalUrl: `${ORIGIN}/fr/programmes/data-science`,
      }),
      { render: false, reason: "canonical-mismatch" },
    );
  });

  it("says canonical-mismatch, not language-mismatch, when no listed page is this one", () => {
    assert.deepEqual(
      decideFromManifest(CURRENT_MANIFEST, "data-science", {
        locale: "fr",
        canonicalUrl: `${ORIGIN}/fr/programmes/data-science`,
      }),
      { render: false, reason: "canonical-mismatch" },
    );
  });

  it("takes the first entry without a canonical, exactly as before", () => {
    assert.deepEqual(decideFromManifest(CURRENT_MANIFEST, "data-science", { locale: "de" }), {
      render: false,
      reason: "language-mismatch",
    });
  });
});

describe("GeoffyProduct (Next) — each page renders its own content", () => {
  for (const [label, path, own] of [
    ["the German page", DE_PATH, DE],
    ["the English page", EN_PATH, EN],
  ]) {
    it(`renders ${label} from its own bundle`, async () => {
      stubOrigin();
      const out = await GeoffyProduct({
        siteKey: "sk",
        handle: "data-science",
        canonicalUrl: `${ORIGIN}${path}`,
      });
      const html = JSON.stringify(out);
      assert.match(html, new RegExp(own.jsonLd.name.replace(/[()]/g, "\\$&")));
      assert.doesNotMatch(html, /data-geoffy-skipped/);
    });
  }

  it("renders what the previous release rendered against an older server", async () => {
    const origin = stubOrigin({ server: "older" });
    const out = await GeoffyProduct({
      siteKey: "sk",
      handle: "data-science",
      locale: "de",
      canonicalUrl: `${ORIGIN}${DE_PATH}`,
    });
    // The older manifest lists only English: the German page declines before any item request.
    assert.equal(origin.itemRequests().length, 0);
    assert.match(JSON.stringify(out), /language-mismatch/);
  });
});

describe("getGeoffyProductMarkup (Astro) — each page renders its own content", () => {
  it("returns the German page's own markup", async () => {
    stubOrigin();
    const out = await getGeoffyProductMarkup({ siteKey: "sk" }, "data-science", {
      canonicalUrl: `${ORIGIN}${DE_PATH}`,
      locale: "de",
    });
    assert.equal(out?.artifact.canonicalUrl, DE.canonicalUrl);
  });

  it("still renders the English page against an older server, as before", async () => {
    stubOrigin({ server: "older" });
    const out = await getGeoffyProductMarkup({ siteKey: "sk" }, "data-science", {
      canonicalUrl: `${ORIGIN}${EN_PATH}`,
      locale: "en",
    });
    assert.equal(out?.artifact.canonicalUrl, EN.canonicalUrl);
  });

  it("returns null for the German page against an older server, as before", async () => {
    stubOrigin({ server: "older" });
    const out = await getGeoffyProductMarkup({ siteKey: "sk" }, "data-science", {
      canonicalUrl: `${ORIGIN}${DE_PATH}`,
    });
    assert.equal(out, null);
  });
});
