/**
 * A missing site key, handle or file must never reach the network.
 *
 * The likeliest misconfiguration is an unset `GEOFFY_SITE_KEY`: the value arrives as
 * `undefined`, and a URL built from it asks Geoffy for `/headless/undefined/...`. A handle that
 * is not a string does the same thing one segment later (`/products/[object Object]`). Geoffy
 * answers 404, the helper turns that into "no content", and the page renders without Geoffy
 * with nothing anywhere saying why.
 *
 * Every entry point that builds an upstream URL is covered here, including the framework
 * wrappers, because a guard that only one function carries is how this happened.
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import {
  __clearGeoffyManifestMemo,
  fetchGeoffyManifest,
  fetchGeoffyProduct,
  fetchGeoffyText,
  handleGeoffyProxy,
} from "../dist/client.js";
import { createGeoffyProxyRoute, createGeoffyTextRoute, GeoffyProduct } from "../dist/next.js";
import {
  createGeoffyProxyEndpoint,
  createGeoffyTextEndpoint,
  getGeoffyProductMarkup,
} from "../dist/astro.js";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
after(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

let calls;
beforeEach(() => {
  delete process.env.GEOFFY_ORIGIN;
  __clearGeoffyManifestMemo();
  calls = [];
  // Answers 404 to everything, which is what Geoffy answers for `/headless/undefined/...`.
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain" } });
  };
  // The warning is asserted in its own file (it is once per process); silence it here.
  console.warn = () => {};
});

/** The assertion every case ends on. The URLs are in the message so a red run shows them. */
function assertNoRequest() {
  assert.equal(calls.length, 0, `expected no request, got: ${calls.join(", ")}`);
}

const req = (path) => new Request(`https://storefront.example${path}`);

const BAD_KEYS = [
  ["undefined", undefined],
  ["an empty string", ""],
  ["whitespace", "   "],
  ["a number", 42],
  ["an object", {}],
  ["null", null],
];

const BAD_ARGS = [
  ["undefined", undefined],
  ["an empty string", ""],
  ["an object", {}],
];

describe("a missing site key makes no request", () => {
  for (const [label, siteKey] of BAD_KEYS) {
    describe(`siteKey is ${label}`, () => {
      it("fetchGeoffyProduct → null", async () => {
        assert.equal(await fetchGeoffyProduct({ siteKey }, "blue-widget"), null);
        assertNoRequest();
      });

      it("fetchGeoffyText → null", async () => {
        assert.equal(await fetchGeoffyText({ siteKey }, "llms.txt"), null);
        assertNoRequest();
      });

      it("fetchGeoffyManifest → null", async () => {
        assert.equal(await fetchGeoffyManifest({ siteKey }), null);
        assertNoRequest();
      });

      it("handleGeoffyProxy → 503", async () => {
        const res = await handleGeoffyProxy({ siteKey }, req("/apps/geoffy/sitemap.xml"));
        assert.equal(res.status, 503);
        assertNoRequest();
      });

      it("Next GeoffyProduct → renders nothing", async () => {
        assert.equal(await GeoffyProduct({ siteKey, handle: "blue-widget" }), null);
        assertNoRequest();
      });

      it("Next createGeoffyTextRoute → 404", async () => {
        const res = await createGeoffyTextRoute({ siteKey }, "llms.txt")();
        assert.equal(res.status, 404);
        assertNoRequest();
      });

      it("Next createGeoffyProxyRoute → 503", async () => {
        const res = await createGeoffyProxyRoute({ siteKey })(req("/apps/geoffy/sitemap.xml"));
        assert.equal(res.status, 503);
        assertNoRequest();
      });

      it("Astro getGeoffyProductMarkup → null", async () => {
        assert.equal(await getGeoffyProductMarkup({ siteKey }, "blue-widget"), null);
        assertNoRequest();
      });

      it("Astro createGeoffyTextEndpoint → 404", async () => {
        const res = await createGeoffyTextEndpoint({ siteKey }, "llms.txt")();
        assert.equal(res.status, 404);
        assertNoRequest();
      });

      it("Astro createGeoffyProxyEndpoint → 503", async () => {
        const res = await createGeoffyProxyEndpoint({ siteKey })({
          request: req("/apps/geoffy/sitemap.xml"),
        });
        assert.equal(res.status, 503);
        assertNoRequest();
      });
    });
  }
});

describe("a missing handle makes no request", () => {
  for (const [label, handle] of BAD_ARGS) {
    describe(`handle is ${label}`, () => {
      it("fetchGeoffyProduct → null", async () => {
        assert.equal(await fetchGeoffyProduct({ siteKey: "sk" }, handle), null);
        assertNoRequest();
      });

      it("Next GeoffyProduct → renders nothing, without reading the manifest", async () => {
        assert.equal(await GeoffyProduct({ siteKey: "sk", handle }), null);
        assertNoRequest();
      });

      it("Astro getGeoffyProductMarkup → null, without reading the manifest", async () => {
        assert.equal(await getGeoffyProductMarkup({ siteKey: "sk" }, handle), null);
        assertNoRequest();
      });
    });
  }
});

describe("a missing file makes no request", () => {
  for (const [label, file] of BAD_ARGS) {
    describe(`file is ${label}`, () => {
      it("fetchGeoffyText → null", async () => {
        assert.equal(await fetchGeoffyText({ siteKey: "sk" }, file), null);
        assertNoRequest();
      });

      it("Next createGeoffyTextRoute → 404", async () => {
        const res = await createGeoffyTextRoute({ siteKey: "sk" }, file)();
        assert.equal(res.status, 404);
        assertNoRequest();
      });

      it("Astro createGeoffyTextEndpoint → 404", async () => {
        const res = await createGeoffyTextEndpoint({ siteKey: "sk" }, file)();
        assert.equal(res.status, 404);
        assertNoRequest();
      });
    });
  }
});

describe("a valid call still makes its request", () => {
  // The guard must not reject everything: a guard that refuses the world passes every case above.
  it("fetchGeoffyProduct asks for the product", async () => {
    await fetchGeoffyProduct({ siteKey: "sk" }, "blue-widget");
    assert.deepEqual(calls, ["https://api.geoffy.ai/headless/sk/products/blue-widget"]);
  });

  it("fetchGeoffyText asks for the file", async () => {
    await fetchGeoffyText({ siteKey: "sk" }, "agents.md");
    assert.deepEqual(calls, ["https://api.geoffy.ai/headless/sk/agents.md"]);
  });

  it("fetchGeoffyManifest asks for the manifest", async () => {
    await fetchGeoffyManifest({ siteKey: "sk" });
    assert.deepEqual(calls, ["https://api.geoffy.ai/headless/sk/manifest.json"]);
  });
});
