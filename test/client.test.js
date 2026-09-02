/**
 * Tests run against `dist/`, not `src/`.
 *
 * The bug this package shipped with was never a logic bug — the source was fine and the
 * PACKAGING was broken, so a test of `src/` would have passed while nothing was installable.
 * Importing the built entry by its public subpath exercises the exports map, the build and
 * the code in one go.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { after, beforeEach, describe, it } from "node:test";
import {
  compareCanonical,
  DEFAULT_GEOFFY_ORIGIN,
  fetchGeoffyText,
  skippedMarker,
} from "../dist/client.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Record what the client asked for, and answer with whatever the test needs. */
function stubFetch({ status = 200, contentType = "text/plain; charset=utf-8", body = "ok" } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
  return calls;
}

beforeEach(() => {
  delete process.env.GEOFFY_ORIGIN;
});

describe("origin resolution", () => {
  it("uses the production default when nothing overrides it", async () => {
    const calls = stubFetch();
    await fetchGeoffyText({ siteKey: "sk" }, "llms.txt");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${DEFAULT_GEOFFY_ORIGIN}/headless/sk/llms.txt`);
    assert.equal(DEFAULT_GEOFFY_ORIGIN, "https://api.geoffy.ai");
  });

  it("uses GEOFFY_ORIGIN when no option is given", async () => {
    process.env.GEOFFY_ORIGIN = "https://dev-origin.example";
    const calls = stubFetch();
    await fetchGeoffyText({ siteKey: "sk" }, "llms.txt");
    assert.equal(calls[0].url, "https://dev-origin.example/headless/sk/llms.txt");
  });

  it("prefers the explicit option over the environment", async () => {
    process.env.GEOFFY_ORIGIN = "https://from-env.example";
    const calls = stubFetch();
    await fetchGeoffyText({ siteKey: "sk", origin: "https://from-option.example" }, "llms.txt");
    assert.equal(calls[0].url, "https://from-option.example/headless/sk/llms.txt");
  });

  it("strips a trailing slash rather than emitting a double one", async () => {
    const calls = stubFetch();
    await fetchGeoffyText({ siteKey: "sk", origin: "https://x.example/" }, "llms.txt");
    assert.equal(calls[0].url, "https://x.example/headless/sk/llms.txt");
  });

  it("percent-encodes the site key", async () => {
    const calls = stubFetch();
    await fetchGeoffyText({ siteKey: "a/b c" }, "llms.txt");
    assert.ok(calls[0].url.endsWith("/headless/a%2Fb%20c/llms.txt"), calls[0].url);
  });

  for (const bad of ["", "   ", "not a url", "/relative", "javascript:alert(1)", "file:///etc/passwd"]) {
    it(`ignores an unusable GEOFFY_ORIGIN (${JSON.stringify(bad)}) and falls back to the default`, async () => {
      process.env.GEOFFY_ORIGIN = bad;
      const calls = stubFetch();
      await fetchGeoffyText({ siteKey: "sk" }, "llms.txt");
      assert.equal(calls[0].url, `${DEFAULT_GEOFFY_ORIGIN}/headless/sk/llms.txt`);
    });
  }
});

describe("a 200 is not enough", () => {
  it("returns the body for text/plain", async () => {
    stubFetch({ contentType: "text/plain; charset=utf-8", body: "# llms" });
    assert.equal(await fetchGeoffyText({ siteKey: "sk" }, "llms.txt"), "# llms");
  });

  it("returns the body for text/markdown, which is what the API serves agents.md as", async () => {
    stubFetch({ contentType: "text/markdown; charset=utf-8", body: "# agents" });
    assert.equal(await fetchGeoffyText({ siteKey: "sk" }, "agents.md"), "# agents");
  });

  it("refuses HTML served with a 200 — a dashboard shell is not this site's llms.txt", async () => {
    stubFetch({ contentType: "text/html; charset=utf-8", body: "<!DOCTYPE html><html>" });
    assert.equal(await fetchGeoffyText({ siteKey: "sk" }, "llms.txt"), null);
  });

  it("returns null on a non-2xx", async () => {
    stubFetch({ status: 404, body: "Not found" });
    assert.equal(await fetchGeoffyText({ siteKey: "sk" }, "llms.txt"), null);
  });

  it("asks fetch to refuse redirects", async () => {
    const calls = stubFetch();
    await fetchGeoffyText({ siteKey: "sk" }, "llms.txt");
    assert.equal(calls[0].init.redirect, "error");
  });
});

describe("against a real server", () => {
  it("does not follow a redirect, however successful the destination looks", async (t) => {
    globalThis.fetch = realFetch;

    const decoy = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!DOCTYPE html><html>the dashboard</html>");
    });
    await new Promise((r) => decoy.listen(0, "127.0.0.1", r));
    // Registered BEFORE the assertion, not after it. Closing servers on the line after
    // assert.equal means a FAILING test leaks two listening handles and `node --test`
    // hangs forever instead of reporting the failure - which is exactly what happened
    // the first time this fix was inverted to prove the test could go red.
    t.after(() => decoy.close());

    const origin = http.createServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${decoy.address().port}/` });
      res.end();
    });
    await new Promise((r) => origin.listen(0, "127.0.0.1", r));
    t.after(() => origin.close());

    const body = await fetchGeoffyText(
      { siteKey: "sk", origin: `http://127.0.0.1:${origin.address().port}` },
      "llms.txt",
    );

    // This is the exact shape observed against production: /headless/* answered 302 and
    // the redirect target returned 200 HTML, which this function used to hand back.
    assert.equal(body, null);
  });

  // Not a stubbed test: undici's Response constructor ADDS `content-type: text/plain` for a
  // string body, so a header-less 200 cannot be built with a fake. Only a real server can.
  it("refuses a 200 that carries no content-type at all", async (t) => {
    globalThis.fetch = realFetch;

    const srv = http.createServer((_req, res) => {
      res.writeHead(200, {});
      res.end("body");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    t.after(() => srv.close());

    const body = await fetchGeoffyText(
      { siteKey: "sk", origin: `http://127.0.0.1:${srv.address().port}` },
      "llms.txt",
    );
    assert.equal(body, null);
  });
});

/**
 * The canonical guard.
 *
 * Geoffy publishes against ONE canonical URL per product, and the component renders wherever
 * it is mounted. Without this comparison a translated route renders the canonical language,
 * and two routes ending in the same handle render each other's product.
 */
describe("compareCanonical", () => {
  it("matches the same path, whatever the origin", () => {
    // Load-bearing: a build running on localhost against a production canonical must not
    // blank a correct page. Local preview is a documented workflow.
    assert.equal(
      compareCanonical("http://localhost:5001/en/p/pumps", "https://shop.example/en/p/pumps"),
      "match",
    );
  });

  it("matches a bare path against an absolute canonical", () => {
    assert.equal(compareCanonical("/en/p/pumps", "https://shop.example/en/p/pumps"), "match");
  });

  it("ignores a trailing slash, a query and a fragment", () => {
    assert.equal(
      compareCanonical("https://shop.example/en/p/pumps/?utm=x#buy", "https://shop.example/en/p/pumps"),
      "match",
    );
  });

  it("reports a mismatch for another locale of the same product", () => {
    // The case this exists for. Same handle, same site, different page.
    assert.equal(
      compareCanonical("https://shop.example/de/p/pumps", "https://shop.example/en/p/pumps"),
      "mismatch",
    );
  });

  it("reports a mismatch for a different product that ends in the same handle", () => {
    // Worse than a wrong language: `site_products` is unique on URL, not handle, so two trees
    // can carry one handle and this page would otherwise render the OTHER product's facts.
    assert.equal(
      compareCanonical(
        "https://shop.example/catalogue/valves/spare-parts",
        "https://shop.example/catalogue/pumps/spare-parts",
      ),
      "mismatch",
    );
  });

  it("compares paths case-sensitively, because paths are", () => {
    assert.equal(
      compareCanonical("https://shop.example/en/p/Pumps", "https://shop.example/en/p/pumps"),
      "mismatch",
    );
  });

  it("answers unknown rather than mismatch when a value cannot be read", () => {
    // A value we cannot parse says NOTHING about whether the page matches. Calling it a
    // mismatch would blank a working page over a typo in an optional argument.
    assert.equal(compareCanonical("not a url", "https://shop.example/en/p/pumps"), "unknown");
    assert.equal(compareCanonical("", "https://shop.example/en/p/pumps"), "unknown");
    assert.equal(compareCanonical("https://shop.example/en/p/pumps", "  "), "unknown");
  });
});

describe("skippedMarker", () => {
  it("does not carry the attribute the presence check matches on", () => {
    // `data-geoffy-product` is what Geoffy greps for to call a product live. A page we
    // declined to render must never read as an integrated one.
    const html = skippedMarker("canonical-mismatch", "page /de/p/x · published against /en/p/x");
    assert.ok(html.includes("data-geoffy-skipped"));
    assert.ok(!html.includes("data-geoffy-product"));
  });

  it("escapes < so no detail string can close the tag early", () => {
    const html = skippedMarker("canonical-mismatch", "</script><img onerror=alert(1)>");
    assert.ok(!html.includes("</script><img"));
    assert.ok(html.includes("\\u003c"));
  });
});
