/**
 * Passing a crawler's user agent through to Geoffy.
 *
 * The namespace proxy and the text routes fetch from Geoffy on the merchant's server, so every
 * request Geoffy saw arrived as the merchant's runtime, never as the crawler that asked. These
 * routes now name the crawler in `x-geoffy-client-ua`.
 *
 * Only a crawler, and only by its agent name. These fetches sit in Next's data cache, whose key
 * includes the headers, so the value set must be small and closed; and a browser's user agent is
 * not ours to collect.
 *
 * Runs against `dist/`, like its siblings.
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { fetchGeoffyText, handleGeoffyProxy } from "../dist/client.js";
import { createGeoffyProxyRoute, createGeoffyTextRoute } from "../dist/next.js";
import { createGeoffyProxyEndpoint, createGeoffyTextEndpoint } from "../dist/astro.js";

const GPTBOT = "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const BROWSER = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  delete process.env.GEOFFY_ORIGIN;
  globalThis.fetch = realFetch;
});

function stubFetch(contentType = "text/plain; charset=utf-8") {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    // The same check a real fetch makes: a header value outside Latin-1 is refused.
    for (const [, value] of Object.entries(init.headers ?? {})) {
      if (/[^\x00-\xff]/.test(value)) throw new TypeError("invalid header value");
    }
    calls.push({ url: String(url), init });
    return new Response("# body", { headers: { "content-type": contentType } });
  };
  return calls;
}

const forwarded = (call) => new Headers(call.init.headers ?? {}).get("x-geoffy-client-ua");
const req = (path, ua) => new Request(`https://storefront.example${path}`, { headers: ua ? { "user-agent": ua } : {} });

describe("namespace proxy", () => {
  it("passes the crawler's agent name upstream", async () => {
    const calls = stubFetch("text/markdown");
    const res = await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/llm/tablets.md", GPTBOT));
    assert.equal(res.status, 200);
    assert.equal(forwarded(calls[0]), "GPTBot");
  });

  it("passes only the agent name, so a varied user agent cannot vary the cached fetch", async () => {
    // The fetch is cached with its headers in the key. A raw user agent would let anyone mint a
    // fresh cache entry — and a fresh fetch from Geoffy — per request.
    const calls = stubFetch("text/markdown");
    for (const ua of [GPTBOT, "GPTBot/9 random-1", `GPTBot cafÃ© ${"x".repeat(2000)}`]) {
      await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/llm/a.md", ua));
    }
    assert.deepEqual(calls.map(forwarded), ["GPTBot", "GPTBot", "GPTBot"]);
  });

  it("does not pass a browser's user agent, or an absent one", async () => {
    const calls = stubFetch("text/markdown");
    await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/llm/tablets.md", BROWSER));
    await handleGeoffyProxy({ siteKey: "sk" }, req("/apps/geoffy/llm/tablets.md"));
    assert.equal(calls.length, 2);
    assert.equal(forwarded(calls[0]), null);
    assert.equal(forwarded(calls[1]), null);
  });

  it("through both framework factories", async () => {
    const calls = stubFetch("text/markdown");
    await createGeoffyProxyRoute({ siteKey: "sk" })(req("/apps/geoffy/sitemap.xml", GPTBOT));
    await createGeoffyProxyEndpoint({ siteKey: "sk" })({ request: req("/apps/geoffy/sitemap.xml", GPTBOT) });
    assert.deepEqual(calls.map(forwarded), ["GPTBot", "GPTBot"]);
  });
});

describe("text routes", () => {
  it("fetchGeoffyText passes it when handed the request, and keeps its old call shape", async () => {
    const calls = stubFetch();
    assert.equal(await fetchGeoffyText({ siteKey: "sk" }, "llms.txt", req("/llms.txt", GPTBOT)), "# body");
    assert.equal(await fetchGeoffyText({ siteKey: "sk" }, "llms.txt"), "# body");
    assert.equal(forwarded(calls[0]), "GPTBot");
    assert.equal(forwarded(calls[1]), null);
  });

  it("Next route and Astro endpoint do NOT read the request unless asked", async () => {
    // Reading the headers switches a static or cached Next route to render per request, so an
    // upgrade must not do it silently.
    // Recorded, not thrown: the header helper swallows errors, so a throwing probe would pass
    // whether or not the headers were touched.
    const calls = stubFetch();
    let headerReads = 0;
    const watched = new Proxy(req("/llms.txt", GPTBOT), {
      get(target, prop) {
        if (prop === "headers") headerReads += 1;
        return Reflect.get(target, prop);
      },
    });
    const next = await createGeoffyTextRoute({ siteKey: "sk" }, "llms.txt")(watched);
    const astro = await createGeoffyTextEndpoint({ siteKey: "sk" }, "agents.md")({ request: watched });
    assert.equal(next.status, 200);
    assert.equal(astro.status, 200);
    assert.equal(headerReads, 0);
    assert.deepEqual(calls.map(forwarded), [null, null]);
  });

  it("with forwardCrawler, Next route and Astro endpoint pass it from the incoming request", async () => {
    const calls = stubFetch();
    const opt = { forwardCrawler: true };
    const next = await createGeoffyTextRoute({ siteKey: "sk" }, "llms.txt", opt)(req("/llms.txt", GPTBOT));
    const astro = await createGeoffyTextEndpoint({ siteKey: "sk" }, "agents.md", opt)({
      request: req("/agents.md", GPTBOT),
    });
    assert.equal(next.status, 200);
    assert.equal(astro.status, 200);
    assert.deepEqual(calls.map(forwarded), ["GPTBot", "GPTBot"]);
  });

  it("a Next route called with no request still serves the file", async () => {
    const calls = stubFetch();
    const res = await createGeoffyTextRoute({ siteKey: "sk" }, "llms.txt")();
    assert.equal(res.status, 200);
    assert.equal(forwarded(calls[0]), null);
  });
});
