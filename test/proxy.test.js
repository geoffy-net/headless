/**
 * The namespace proxy.
 *
 * Like its sibling, this runs against `dist/` so it exercises the exports map and the build
 * as well as the logic.
 *
 * Two themes. The first is that the remainder of the path is untrusted input on its way into
 * an outbound URL, and the second is that a timeout and an absence are different answers — a
 * 404 invented out of an outage gets pages dropped from an index over a blip that lasted
 * minutes.
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { GEOFFY_NAMESPACE_TAG, handleGeoffyProxy, PROXY_PREFIX, resolveProxyPath } from "../dist/client.js";
import { createGeoffyProxyRoute } from "../dist/next.js";
import { createGeoffyProxyEndpoint } from "../dist/astro.js";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

function stubFetch({ status = 200, contentType = "text/markdown; charset=utf-8", body = "# Tablets", location } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const headers = { "content-type": contentType };
    if (location) headers.location = location;
    // 204/304 forbid a body; a redirect fixture wants none either.
    const hasBody = status !== 204 && status !== 304 && !(status >= 300 && status < 400);
    return new Response(hasBody ? body : null, { status, headers });
  };
  return calls;
}

/** Fetch that never answers, the way a wedged origin does not. */
function stubUnreachable() {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
}

beforeEach(() => {
  delete process.env.GEOFFY_ORIGIN;
  // Restore the real fetch between cases. Without this a test that forgets to stub inherits
  // whatever the previous one installed — including the throwing stub from "never throws" —
  // and passes or fails for a reason unrelated to itself.
  globalThis.fetch = realFetch;
});

const req = (path) => new Request(`https://storefront.example${path}`);

describe("resolveProxyPath", () => {
  it("maps a mounted path onto the artifact path", () => {
    assert.equal(
      resolveProxyPath("https://storefront.example/apps/geoffy/llm/tablets.md"),
      "/llm/tablets.md",
    );
    assert.equal(
      resolveProxyPath("https://storefront.example/apps/geoffy/guides/best-tablets"),
      "/guides/best-tablets",
    );
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/sitemap.xml"), "/sitemap.xml");
  });

  it("declines anything outside the mount", () => {
    assert.equal(resolveProxyPath("https://storefront.example/"), null);
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy"), null);
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffyX/llm/a.md"), null);
    assert.equal(resolveProxyPath("https://storefront.example/products/tablets"), null);
  });

  it("declines the traversal forms the URL parser has already normalised away", () => {
    // These reach `resolveProxyPath` as `/etc/passwd` and `/secrets` — the mount check
    // rejects them and the `..` guard is never consulted. Named for what they actually
    // exercise: filed under "refuses traversal" they would stay green with that guard deleted.
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/../../etc/passwd"), null);
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/%2e%2e/%2e%2e/secrets"), null);
  });

  it("refuses the traversal forms that actually reach the guard", () => {
    // Measured, not assumed. `..%2f` and `%5c` survive WHATWG normalisation; `%252e%252e`
    // survives it AND a single decode, which is why the guard decodes to a fixed point.
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/a/..%2fb"), null);
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/a%5c..%5cb"), null);
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/llm/%252e%252e%252fx"), null);
  });

  it("refuses a backslash even with no dots — the guard that had no test at all", () => {
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/a%5cb"), null);
  });

  it("declines the bare mount, in both spellings", () => {
    // `/apps/geoffy/` used to yield a remainder of "/" and spend a round trip on the
    // namespace root; `/apps/geoffy` returned null. One URL, two answers.
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/"), null);
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy"), null);
  });

  it("refuses a protocol-relative remainder", () => {
    // `//evil.example` concatenated after an origin makes the whole URL protocol-relative,
    // and the fetch goes to a host the caller chose.
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy//evil.example/x"), null);
  });

  it("refuses a malformed escape rather than guessing at it", () => {
    assert.equal(resolveProxyPath("https://storefront.example/apps/geoffy/%zz"), null);
  });

  it("has one fixed mount, because Geoffy hardcodes the same path on its side", () => {
    // The configurable `prefix` was removed rather than kept: Geoffy's mount probe fetches a
    // fixed `/apps/geoffy/sitemap.xml` and publishes twin URLs from the same literal, so a
    // merchant who moved their mount would be probed at a path they do not serve and reported
    // permanently unmounted. An option that cannot be honoured end to end is worse than none.
    assert.equal(PROXY_PREFIX, "/apps/geoffy");
    assert.equal(resolveProxyPath("https://x.example/geo/llm/a.md"), null);
  });

  it("keeps the remainder percent-encoded so an encoded slug survives the hop", () => {
    assert.equal(
      resolveProxyPath("https://storefront.example/apps/geoffy/llm/caf%C3%A9.md"),
      "/llm/caf%C3%A9.md",
    );
  });
});

describe("handleGeoffyProxy", () => {
  it("forwards to the site-scoped artifact path and passes the content type through", async () => {
    const calls = stubFetch();

    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/llm/tablets.md"));

    assert.equal(calls[0].url, "https://api.geoffy.ai/headless/sk/llm/tablets.md");
    assert.equal(res.status, 200);
    // Not re-declared as text/plain: a markdown twin served as something else is not the
    // surface Geoffy published, and the mount check on our side refuses to confirm it.
    assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(await res.text(), "# Tablets");
  });

  it("does NOT forward the query string", async () => {
    // Forwarding it would let anyone bypass every cache in front of Geoffy by appending a
    // unique parameter, turning a cheap crawl into unbounded origin load.
    const calls = stubFetch();

    await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml?cachebust=1"));

    assert.equal(calls[0].url, "https://api.geoffy.ai/headless/sk/sitemap.xml");
  });

  it("answers 404 without calling Geoffy at all when the path is not ours", async () => {
    const calls = stubFetch();

    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/products/tablets"));

    assert.equal(res.status, 404);
    assert.equal(calls.length, 0);
  });

  it("refuses the traversal forms that actually SURVIVE URL normalisation", async () => {
    // Measured, not assumed. Most traversal never reaches the guard, because the WHATWG URL
    // parser resolves dot segments while building `request.url`:
    //
    //   /apps/geoffy/../secrets        -> /apps/secrets        (gone before we look)
    //   /apps/geoffy/%2e%2e/%2e%2e/x   -> /x                   (gone: %2e counts as a dot)
    //   /apps/geoffy/a/..%2fb          -> unchanged            <- reaches the guard
    //   /apps/geoffy//evil.example/x   -> unchanged            <- reaches the guard
    //
    // So a test written with plain `..` asserts the right outcome for the wrong reason and
    // stays green with the guard deleted — which is exactly what the first version of this
    // test did. These two are the forms the guard is the only thing standing in front of:
    // an encoded slash rebuilds the separator after our concatenation, and a `//` remainder
    // makes the outbound URL protocol-relative and sends it to a host of the caller's choice.
    for (const path of ["/apps/geoffy/a/..%2f..%2fheadless/sk_two/sitemap.xml", "/apps/geoffy//evil.example/x"]) {
      const calls = stubFetch();

      const res = await handleGeoffyProxy({ siteKey: "sk" }, req(path));

      assert.equal(res.status, 404, path);
      assert.equal(calls.length, 0, path);
    }
  });

  it("passes an upstream 404 through as a 404", async () => {
    stubFetch({ status: 404, body: "", contentType: "application/json" });

    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/llm/nope.md"));

    assert.equal(res.status, 404);
  });

  it("answers 503, never 404, when Geoffy cannot be reached", async () => {
    // The distinction the single-file helpers cannot make. 404 tells a crawler the page does
    // not exist — a confident claim manufactured out of a timeout, and one that drops pages
    // from an index over an outage of minutes. 503 says "ask again", which is what is true.
    stubUnreachable();

    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/llm/tablets.md"));

    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "120");
  });

  it("answers 503 for an upstream 5xx too", async () => {
    stubFetch({ status: 502, body: "bad gateway", contentType: "text/plain" });

    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml"));

    assert.equal(res.status, 503);
  });

  it("never throws, whatever the origin does", async () => {
    // The package's standing promise. A route that 500s sits on the MERCHANT's domain and is
    // attributed to them.
    for (const boom of [
      () => {
        throw new Error("kaboom");
      },
      async () => {
        throw new TypeError("fetch failed");
      },
    ]) {
      globalThis.fetch = boom;
      const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml"));
      assert.equal(res.status, 503);
    }
  });

  it("honours GEOFFY_ORIGIN like every other call in this package", async () => {
    process.env.GEOFFY_ORIGIN = "https://dev-origin.example";
    const calls = stubFetch();

    await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml"));

    assert.equal(calls[0].url, "https://dev-origin.example/headless/sk/sitemap.xml");
  });

  it("scopes every request to ITS OWN site key", async () => {
    // The site key is in the URL we build, never in the path the caller supplied, so a
    // request cannot address another merchant's namespace however it is shaped.
    const calls = stubFetch();

    await handleGeoffyProxy({ siteKey: "sk_one" }, req("/apps/geoffy/headless/sk_two/sitemap.xml"));

    assert.equal(calls[0].url, "https://api.geoffy.ai/headless/sk_one/headless/sk_two/sitemap.xml");
  });
});

describe("the fixes this PR's own review found", () => {
  it("asks fetch not to follow redirects, and pins the abort signal", async () => {
    // Both were new behaviour with no assertion: deleting `redirect` or the AbortController
    // left the whole suite green.
    const calls = stubFetch();

    await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml"));

    assert.equal(calls[0].init.redirect, "manual");
    assert.ok(calls[0].init.signal instanceof AbortSignal);
  });

  it("pins the cache-control the README sells to merchants", async () => {
    const res = await (stubFetch(), handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml")));

    assert.equal(
      res.headers.get("cache-control"),
      "public, max-age=300, stale-while-revalidate=86400, stale-if-error=86400",
    );
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  it("refuses a 200 whose content type is not one the namespace can serve", async () => {
    // The incident fetchGeoffyText already learned from: a dashboard shell or CDN
    // interstitial answered 200. Republishing it would put third-party HTML on the
    // merchant's own origin.
    stubFetch({ status: 200, contentType: "application/pdf", body: "%PDF-1.4" });

    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml"));

    assert.equal(res.status, 503);
  });

  it("treats a rate limit as retryable, not as absence", async () => {
    // The likeliest answer during a crawl burst. Answering 404 tells the crawler the guide
    // does not exist and drops it from an index over a rate limit.
    for (const status of [408, 429, 401, 403, 500, 502]) {
      stubFetch({ status, body: "" });
      const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/guides/x"));
      assert.equal(res.status, 503, `upstream ${status}`);
      assert.equal(res.headers.get("retry-after"), "120", `upstream ${status}`);
    }
  });

  it("keeps 404 for a settled absence, with the same body both 503s do not use", async () => {
    stubFetch({ status: 404, body: "" });
    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/guides/nope"));
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not found\n");
  });

  it("both 503s are byte-identical, which is what stopped them drifting", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const unreachable = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml"));

    stubFetch({ status: 502, body: "" });
    const upstream = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml"));

    assert.equal(await unreachable.text(), await upstream.text());
    assert.equal(unreachable.headers.get("retry-after"), upstream.headers.get("retry-after"));
  });

  it("translates an upstream redirect onto the merchant's own mount", async () => {
    // A renamed guide slug 301s. Reporting that as an outage — which `redirect: "error"` did —
    // meant the merchant's domain answered 503 forever for a page that had simply moved.
    stubFetch({ status: 301, location: "https://api.geoffy.ai/headless/sk/guides/new-slug" });

    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/guides/old-slug"));

    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/apps/geoffy/guides/new-slug");
  });

  it("refuses a redirect that points anywhere but this site's own artifacts", async () => {
    for (const location of [
      "https://evil.example/x",
      "https://api.geoffy.ai/headless/sk_two/guides/x",
      "https://api.geoffy.ai/dashboard",
    ]) {
      stubFetch({ status: 302, location });
      const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/guides/x"));
      assert.equal(res.status, 404, location);
      assert.equal(res.headers.get("location"), null, location);
    }
  });

  it("answers 503 for a missing site key instead of 404ing the whole namespace", async () => {
    // The Astro snippet reads an env var with no guard, so `undefined` is the realistic
    // misconfiguration. It used to build `/headless/undefined/...` and 404 everything.
    const calls = stubFetch();

    const res = await handleGeoffyProxy({ siteKey: undefined }, req("/apps/geoffy/sitemap.xml"));

    assert.equal(res.status, 503);
    assert.equal(calls.length, 0);
  });

  it("never caches a failure", async () => {
    stubFetch({ status: 404, body: "" });
    const missing = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/guides/nope"));
    assert.equal(missing.headers.get("cache-control"), "no-store");
  });
});

describe("the framework entry points, which nothing loaded before", () => {
  it("Next: the factory returns a working GET", async () => {
    stubFetch();
    const GET = createGeoffyProxyRoute({ siteKey: "sk" });

    const res = await GET(req("/apps/geoffy/sitemap.xml"));

    assert.equal(res.status, 200);
    assert.equal(await res.text(), "# Tablets");
  });

  it("Astro: the factory unwraps context.request", async () => {
    // The shape differs from Next's, and a mismatch here would compile fine and fail on every
    // Astro mount at runtime — which no test could see while neither bundle was imported.
    stubFetch();
    const GET = createGeoffyProxyEndpoint({ siteKey: "sk" });

    const res = await GET({ request: req("/apps/geoffy/sitemap.xml"), params: {}, url: null });

    assert.equal(res.status, 200);
  });

  it("the namespace cache tag is the one the fetch registers", async () => {
    const calls = stubFetch();
    await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/sitemap.xml"));
    assert.deepEqual(calls[0].init.next.tags, [GEOFFY_NAMESPACE_TAG]);
  });
});
