/**
 * AI visit tracking — the opt-in middleware.
 *
 * Like its siblings, this runs against `dist/` so it exercises the exports map and the build
 * as well as the logic.
 *
 * Three themes. A human page view must never leave the merchant's server — not the visit, not a
 * list refresh, nothing. The middleware must never touch the response or throw into the
 * merchant's request, whatever Geoffy or the network does. And a send must be signed so that
 * Geoffy can tell it came from the site that holds the secret.
 */
import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { __resetGeoffyAiVisits, createGeoffyAiVisitMiddleware } from "../dist/next-middleware.js";
import { createGeoffyAiVisitMiddleware as createAstroMiddleware } from "../dist/astro-middleware.js";

const SECRET = "shh-test-secret";
const GPTBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Records every outbound call; answers agents.json with `agents` and everything else 202. */
function stubFetch({ agents = null, visitStatus = 202 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/agents.json")) {
      return agents === null
        ? new Response("nope", { status: 500 })
        : new Response(JSON.stringify(agents), { headers: { "content-type": "application/json" } });
    }
    return new Response(null, { status: visitStatus });
  };
  return calls;
}

const posts = (calls) => calls.filter((c) => c.init.method === "POST");

/** Wait for detached work (it signs with WebCrypto, off the main thread) rather than guess a delay. */
async function until(condition, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A waitUntil that keeps every deferred task so the test can await it. */
function deferredEvent() {
  const tasks = [];
  return { event: { waitUntil: (p) => tasks.push(p) }, settle: () => Promise.all(tasks), tasks };
}

async function sign(secret, body) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

const page = (path, headers = {}) => new Request(`https://storefront.example${path}`, { headers });

beforeEach(() => {
  __resetGeoffyAiVisits();
  delete process.env.GEOFFY_ORIGIN;
  delete process.env.GEOFFY_REVALIDATE_SECRET;
  delete process.env.VERCEL;
  globalThis.fetch = realFetch;
});

describe("next middleware: who is sent", () => {
  it("makes NO network call for a human page view", async () => {
    const calls = stubFetch({ agents: { version: 1, signatures: ["GPTBot"] } });
    const { event, settle, tasks } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });

    const result = mw(page("/products/tablets", { "user-agent": BROWSER }), event);
    await settle();

    assert.equal(result, undefined);
    assert.equal(tasks.length, 0, "nothing was even deferred");
    assert.equal(calls.length, 0);
  });

  it("sends ONE signed POST for an AI crawler, and the signature verifies", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });

    mw(page("/products/tablets?ref=x#top", { "user-agent": GPTBOT }), event);
    await settle();

    const sent = posts(calls);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.geoffy.ai/headless/sk/visits");
    const headers = new Headers(sent[0].init.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.get("x-geoffy-signature"), await sign(SECRET, sent[0].init.body));

    const payload = JSON.parse(sent[0].init.body);
    assert.equal(payload.events.length, 1);
    const [ev] = payload.events;
    // Absolute, so the host can be checked; no query string, which can carry personal data.
    assert.equal(ev.path, "https://storefront.example/products/tablets");
    assert.equal(ev.ua, GPTBOT);
    assert.ok(!Number.isNaN(Date.parse(ev.ts)));
    assert.equal("ip" in ev, false, "no trusted address was available");
  });
});

describe("next middleware: referrals from an assistant", () => {
  it("reports a shopper who arrived with utm_source=chatgpt.com, without their address", async () => {
    process.env.VERCEL = "1";
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });

    mw(
      page("/products/tablets?utm_source=chatgpt.com", {
        "user-agent": BROWSER,
        "x-vercel-forwarded-for": "203.0.113.9",
      }),
      event,
    );
    await settle();

    const sent = posts(calls);
    assert.equal(sent.length, 1);
    const [ev] = JSON.parse(sent[0].init.body).events;
    assert.equal(ev.utmSource, "chatgpt.com");
    assert.equal(ev.path, "https://storefront.example/products/tablets");
    assert.equal("ua" in ev, false, "a shopper's user agent is never sent");
    assert.equal("ip" in ev, false, "a shopper's address is never sent");
  });

  it("reports a referer from an assistant, subdomains included", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });

    mw(page("/", { "user-agent": BROWSER, referer: "https://www.perplexity.ai/search?q=tablets" }), event);
    await settle();

    const [ev] = JSON.parse(posts(calls)[0].init.body).events;
    assert.equal(ev.referrerHost, "perplexity.ai");
    assert.equal("utmSource" in ev, false);
  });

  it("ignores a referer or utm_source that merely contains an assistant's name", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });

    mw(page("/?utm_source=newsletter", { "user-agent": BROWSER, referer: "https://notchatgpt.com/" }), event);
    mw(page("/", { "user-agent": BROWSER, referer: "https://chatgpt.com.evil.example/" }), event);
    await settle();

    assert.equal(calls.length, 0);
  });
});

describe("next middleware: what is never sent", () => {
  it("sends nothing without a secret, and uses GEOFFY_REVALIDATE_SECRET when set", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    createGeoffyAiVisitMiddleware({ siteKey: "sk" })(page("/", { "user-agent": GPTBOT }), event);
    createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: "   " })(page("/", { "user-agent": GPTBOT }), event);
    await settle();
    assert.equal(calls.length, 0);

    process.env.GEOFFY_REVALIDATE_SECRET = "from-env";
    createGeoffyAiVisitMiddleware({ siteKey: "sk" })(page("/", { "user-agent": GPTBOT }), event);
    await settle();
    const [sent] = posts(calls);
    assert.equal(new Headers(sent.init.headers).get("x-geoffy-signature"), await sign("from-env", sent.init.body));
  });

  it("a report signed with the wrong secret does not verify against the right one", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: "wrong" })(page("/", { "user-agent": GPTBOT }), event);
    await settle();
    const [sent] = posts(calls);
    assert.ok(sent);
    assert.notEqual(new Headers(sent.init.headers).get("x-geoffy-signature"), await sign(SECRET, sent.init.body));
  });

  it("sends nothing without a site key", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    createGeoffyAiVisitMiddleware({ siteKey: "", secret: SECRET })(page("/", { "user-agent": GPTBOT }), event);
    createGeoffyAiVisitMiddleware({ siteKey: undefined, secret: SECRET })(page("/", { "user-agent": GPTBOT }), event);
    await settle();
    assert.equal(calls.length, 0);
  });

  it("skips build output, static assets, prefetches and caller exclusions", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET, exclude: ["/account", /^\/api\//] });
    for (const path of ["/_next/static/chunks/a.js", "/logo.png", "/fonts/x.woff2", "/account/orders", "/api/cart"]) {
      mw(page(path, { "user-agent": GPTBOT }), event);
    }
    mw(page("/products/a", { "user-agent": GPTBOT, "next-router-prefetch": "1" }), event);
    await settle();
    assert.equal(calls.length, 0);

    // …while a page, and a text file an agent reads, still count.
    mw(page("/llms.txt", { "user-agent": GPTBOT }), event);
    await settle();
    assert.equal(posts(calls).length, 1);
  });

  it("bounds the CALL rate per process, and batches the visits it could not send yet", async () => {
    // Anyone can send a crawler's user agent, so without a bound the merchant's server would
    // make one call per spoofed request. The bound is on calls; a visit that arrives with the
    // budget spent waits for the next one instead of being thrown away.
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
    for (let i = 0; i < 100; i += 1) mw(page(`/p/${i}`, { "user-agent": GPTBOT }), event);
    await settle();
    const sent = posts(calls);
    assert.ok(sent.length >= 60 && sent.length < 70, `sent ${sent.length}`);

    // Nothing was discarded: every one of the hundred is either already reported or queued.
    // A `dropped` on any of these would mean the queue gave up on a visit it did not need to.
    for (const call of sent) {
      assert.equal(JSON.parse(call.init.body).dropped, undefined);
    }

    // Once the budget refills, the next call carries the whole queue in ONE report — oldest
    // first — rather than one visit and a count of the rest.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      mw(page("/after", { "user-agent": GPTBOT }), event);
      await settle();
    } finally {
      Date.now = realNow;
    }
    const last = JSON.parse(posts(calls).at(-1).init.body);
    assert.ok(last.events.length > 1, `batched ${last.events.length}`);
    assert.equal(last.events[0].path, `https://storefront.example/p/${sent.length}`);
    assert.equal(last.dropped, undefined);

    // Every one of the hundred reached Geoffy, across far fewer calls than visits.
    const reported = posts(calls).flatMap((c) => JSON.parse(c.init.body).events.length);
    assert.equal(
      reported.reduce((a, b) => a + b, 0),
      101,
    );
  });

  it("never puts more than 50 visits in one report", async () => {
    // Geoffy refuses a longer list, and it refuses the whole report — so exceeding this would
    // lose every visit in the batch rather than the excess.
    //
    // ⚠️ The clock moves ONE minute, not ten. Ten is past the freshness bound, so every queued
    // visit is pruned and each report carries a single event — measured: the first version of
    // this case jumped ten minutes and stayed green with the ceiling raised to 200, guarding
    // nothing. A minute refills the budget while leaving the queue sendable, which is the only
    // state in which the ceiling decides anything.
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
    for (let i = 0; i < 300; i += 1) mw(page(`/p/${i}`, { "user-agent": GPTBOT }), event);
    await settle();
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      mw(page("/after", { "user-agent": GPTBOT }), event);
      await settle();
    } finally {
      Date.now = realNow;
    }
    const lengths = posts(calls).map((c) => JSON.parse(c.init.body).events.length);
    for (const length of lengths) assert.ok(length <= 50, `report carried ${length}`);
    // …and one really did fill up, or the bound above is satisfied by doing no batching at all.
    assert.equal(Math.max(...lengths), 50);
  });

  it("counts a visit it gives up on, rather than losing it quietly", async () => {
    // Two ways a queued visit is given up on, and both must be COUNTED: the queue is full, or
    // the visit got too old to send. A count Geoffy knows about is one it can label "at
    // least"; one it does not is a number shown as a total.
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
    // Far past the 500-visit queue cap, so the oldest are discarded.
    for (let i = 0; i < 1200; i += 1) mw(page(`/p/${i}`, { "user-agent": GPTBOT }), event);
    await settle();

    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      mw(page("/after", { "user-agent": GPTBOT }), event);
      await settle();
    } finally {
      Date.now = realNow;
    }
    const withDrops = posts(calls)
      .map((c) => JSON.parse(c.init.body))
      .filter((b) => typeof b.dropped === "number");
    assert.ok(withDrops.length > 0, "gave up on visits and reported none");
    assert.ok(
      withDrops.reduce((a, b) => a + b.dropped, 0) > 0,
      "reported a drop count of zero",
    );
  });

  it("drops a visit that has gone stale rather than sending it with fresh ones", async () => {
    // Geoffy refuses a report whose timestamps are too far from its clock, and refuses the
    // WHOLE report — so one straggler must not travel with a fresh batch.
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
    for (let i = 0; i < 100; i += 1) mw(page(`/p/${i}`, { "user-agent": GPTBOT }), event);
    await settle();
    const sentBefore = posts(calls).length;

    // An hour later: everything still queued is long past the freshness bound.
    const realNow = Date.now;
    Date.now = () => realNow() + 3_600_000;
    try {
      mw(page("/fresh", { "user-agent": GPTBOT }), event);
      await settle();
    } finally {
      Date.now = realNow;
    }
    const last = JSON.parse(posts(calls).at(-1).init.body);
    assert.equal(posts(calls).length, sentBefore + 1);
    // Only the fresh one goes; the stale ones are counted, not sent.
    assert.deepEqual(
      last.events.map((e) => e.path),
      ["https://storefront.example/fresh"],
    );
    assert.equal(last.dropped, 100 - sentBefore);
  });

  it("a crawler flood does not use up the budget for assistant referrals", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
    for (let i = 0; i < 100; i += 1) mw(page(`/p/${i}`, { "user-agent": GPTBOT }), event);
    await settle();
    const before = posts(calls).length;
    mw(page("/?utm_source=chatgpt.com", { "user-agent": BROWSER }), event);
    await settle();
    assert.equal(posts(calls).length, before + 1);
  });

  it("ignores an agent list larger than 64KB, even with no content-length", async () => {
    // A VALID list, made large only by whitespace, so nothing but the byte bound can refuse it.
    const huge = `${JSON.stringify({ version: 1, signatures: ["ok-agent"] })}${" ".repeat(70_000)}`;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/agents.json")) {
        // A stream has no content-length, so only a bounded read can refuse it.
        const bytes = new TextEncoder().encode(huge);
        return new Response(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
      }
      return new Response(null, { status: 202 });
    };
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
    mw(page("/", { "user-agent": GPTBOT }), event);
    await settle();
    mw(page("/", { "user-agent": "ok-agent/1" }), event);
    await settle();
    assert.equal(posts(calls).length, 1, "the oversized list was not learned");
  });

  it("sends nothing at sample 0", async () => {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET, sample: 0 })(
      page("/", { "user-agent": GPTBOT }),
      event,
    );
    await settle();
    assert.equal(calls.length, 0);
  });
});

describe("next middleware: never throws, never touches the response", () => {
  it("a throwing fetch never reaches the caller, and the deferred task still resolves", async () => {
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
    assert.equal(mw(page("/", { "user-agent": GPTBOT }), event), undefined);
    await settle(); // rejects if the task rejected
  });

  it("survives a request whose headers throw, a throwing waitUntil, and a throwing clientIp", async () => {
    const calls = stubFetch();
    const hostile = new Proxy(page("/", { "user-agent": GPTBOT }), {
      get(target, prop) {
        if (prop === "headers") throw new Error("boom");
        return Reflect.get(target, prop);
      },
    });
    const mw = createGeoffyAiVisitMiddleware({
      siteKey: "sk",
      secret: SECRET,
      clientIp: () => {
        throw new Error("boom");
      },
    });
    assert.equal(mw(hostile, { waitUntil: () => {} }), undefined);

    // waitUntil that throws: the report is still made, detached.
    mw(page("/", { "user-agent": GPTBOT }), {
      waitUntil() {
        throw new Error("outside a request scope");
      },
    });
    await until(() => posts(calls).length > 0);
    await new Promise((r) => setTimeout(r, 20)); // a second, duplicate send would land here
    assert.equal(posts(calls).length, 1);
  });

  it("without any deferral hook it still reports, detached", async () => {
    const calls = stubFetch();
    createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET })(page("/", { "user-agent": GPTBOT }));
    await until(() => posts(calls).length > 0);
    assert.equal(posts(calls).length, 1);
  });

  it("prefers a `defer` hook (Next's after) over event.waitUntil", async () => {
    const calls = stubFetch();
    const deferred = [];
    const waited = [];
    createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET, defer: (task) => deferred.push(task) })(
      page("/", { "user-agent": GPTBOT }),
      { waitUntil: (p) => waited.push(p) },
    );
    assert.equal(waited.length, 0);
    assert.equal(deferred.length, 1);
    assert.equal(calls.length, 0, "nothing starts until the hook runs it");
    await deferred[0]();
    assert.equal(posts(calls).length, 1);
  });
});

describe("next middleware: the visitor's address", () => {
  async function ipFor(headers, opts = {}) {
    const calls = stubFetch();
    const { event, settle } = deferredEvent();
    createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET, ...opts })(
      page("/", { "user-agent": GPTBOT, ...headers }),
      event,
    );
    await settle();
    return JSON.parse(posts(calls)[0].init.body).events[0].ip;
  }

  it("never reads X-Forwarded-For", async () => {
    process.env.VERCEL = "1";
    assert.equal(await ipFor({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }), undefined);
  });

  it("reads x-vercel-forwarded-for only when running on Vercel", async () => {
    assert.equal(await ipFor({ "x-vercel-forwarded-for": "20.171.207.5" }), undefined);
    process.env.VERCEL = "1";
    assert.equal(await ipFor({ "x-vercel-forwarded-for": "20.171.207.5" }), "20.171.207.5");
    assert.equal(await ipFor({ "x-vercel-forwarded-for": "20.171.207.5, 1.2.3.4" }), undefined);
  });

  it("uses clientIp when given, and drops a value that is not an address", async () => {
    assert.equal(await ipFor({}, { clientIp: () => "2001:db8::1" }), "2001:db8::1");
    assert.equal(await ipFor({}, { clientIp: () => "<script>" }), undefined);
  });
});

describe("next middleware: the agent list", () => {
  it("learns a new agent from Geoffy's list, and reads the list at most once a day", async () => {
    const calls = stubFetch({ agents: { version: 1, signatures: ["NovelAgent"] } });
    const { event, settle } = deferredEvent();
    const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
    const listReads = () => calls.filter((c) => c.url.endsWith("/agents.json")).map((c) => c.url);

    mw(page("/", { "user-agent": "NovelAgent/1.0" }), event);
    await settle();
    assert.equal(calls.length, 0, "not known yet, and a non-match reads nothing");

    mw(page("/", { "user-agent": GPTBOT }), event);
    await settle();
    assert.deepEqual(listReads(), ["https://api.geoffy.ai/headless/sk/agents.json"]);

    mw(page("/", { "user-agent": "NovelAgent/1.0" }), event);
    mw(page("/", { "user-agent": GPTBOT }), event);
    await settle();
    assert.equal(posts(calls).length, 3);
    assert.equal(listReads().length, 1);
  });

  it("keeps the built-in list when the read fails or is malformed", async () => {
    for (const agents of [null, { version: 2, signatures: ["x-agent"] }, { version: 1, signatures: ["ok-agent", 7] }]) {
      __resetGeoffyAiVisits();
      const calls = stubFetch({ agents });
      const { event, settle } = deferredEvent();
      const mw = createGeoffyAiVisitMiddleware({ siteKey: "sk", secret: SECRET });
      mw(page("/", { "user-agent": GPTBOT }), event);
      await settle();
      mw(page("/", { "user-agent": "ok-agent/1" }), event);
      mw(page("/", { "user-agent": "ClaudeBot/1.0" }), event);
      await settle();
      assert.equal(posts(calls).length, 2, JSON.stringify(agents));
    }
  });
});

describe("astro middleware", () => {
  function context(path, headers, locals = {}) {
    return { request: page(path, headers), locals };
  }

  it("returns exactly the response next() produced, reporting through the runtime's waitUntil", async () => {
    const calls = stubFetch();
    const tasks = [];
    const onRequest = createAstroMiddleware({ siteKey: "sk", secret: SECRET });
    const response = new Response("page");
    let nextCalls = 0;

    const result = await onRequest(
      context("/", { "user-agent": GPTBOT }, { runtime: { ctx: { waitUntil: (p) => tasks.push(p) } } }),
      async () => {
        nextCalls += 1;
        return response;
      },
    );

    assert.equal(result, response);
    assert.equal(nextCalls, 1);
    assert.equal(tasks.length, 1);
    await Promise.all(tasks);
    assert.equal(posts(calls).length, 1);
  });

  it("makes no call for a human, and passes the response through untouched", async () => {
    const calls = stubFetch();
    const onRequest = createAstroMiddleware({ siteKey: "sk", secret: SECRET });
    const response = new Response("page");
    const result = await onRequest(context("/", { "user-agent": BROWSER }), async () => response);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(result, response);
    assert.equal(calls.length, 0);
  });

  it("calls next() even when tracking blows up, and passes clientIp the context", async () => {
    const calls = stubFetch();
    const seen = [];
    const onRequest = createAstroMiddleware({
      siteKey: "sk",
      secret: SECRET,
      clientIp: (_request, ctx) => {
        seen.push(ctx);
        return ctx.clientAddress;
      },
    });
    const response = new Response("page");
    const ctx = { ...context("/", { "user-agent": GPTBOT }), clientAddress: "20.171.207.5" };
    assert.equal(await onRequest(ctx, async () => response), response);
    await until(() => posts(calls).length > 0);
    assert.equal(seen[0], ctx);
    assert.equal(JSON.parse(posts(calls)[0].init.body).events[0].ip, "20.171.207.5");

    assert.equal(await onRequest(null, async () => response), response);
  });
});
