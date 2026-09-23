/**
 * AI visit tracking — the framework-neutral core behind both middleware entries.
 *
 * Internal module. `@geoffy/headless/next-middleware` and `@geoffy/headless/astro-middleware`
 * are thin adapters over `trackAiVisit`.
 *
 * ## The filter runs HERE, on the merchant's server
 *
 * A request is reported only when it is an AI system reading the page (its user agent matches
 * a known agent) or a shopper arriving from an AI assistant (the `referer` or `utm_source`
 * names one). Every other request — every ordinary page view — produces no network call at all.
 * Not a smaller one, not a batched one: none. That is the property this module is built around,
 * and it is what makes the middleware safe to run on every request of a busy storefront.
 *
 * ## It never throws, and never touches the response
 *
 * `trackAiVisit` returns nothing and catches everything. The report is handed to the platform's
 * "run this after the response" hook, or, where there is none, started and left to finish on its
 * own. A slow, failing or unreachable Geoffy costs the merchant's visitor nothing.
 */

import { resolveGeoffyOrigin } from "./client";
import { MAX_USER_AGENT_LENGTH, matchAiAgent, refreshAiAgents } from "./aiAgents";
import { signBody } from "./signature";

export interface GeoffyAiVisitOptions {
  /** The site key from your Geoffy settings. Public — it addresses, it does not authorise. */
  siteKey: string;
  /** Overrides `GEOFFY_ORIGIN` and the default, exactly as on every other entry point. */
  origin?: string;
  /**
   * Signs each report. Defaults to `GEOFFY_REVALIDATE_SECRET`, the secret your revalidate route
   * already uses. With neither, nothing is sent: an unsigned report would be refused anyway.
   */
  secret?: string;
  /**
   * The visitor's address, if your platform gives you one you can trust. Used only to confirm
   * that a visit claiming to be an AI crawler really came from that vendor's published address
   * range; it is never sent for a shopper arriving from an assistant.
   *
   * Default: the address Vercel sets (`x-vercel-forwarded-for`, read only when running on
   * Vercel), else nothing. Never the first `X-Forwarded-For` entry — that one is whatever the
   * client chose to send.
   */
  clientIp?: (request: Request) => string | null | undefined;
  /**
   * Paths never reported: a string is a path prefix, a RegExp is tested against the path.
   * Added to the defaults (`/_next/` and static assets such as scripts, styles, images and
   * fonts), never instead of them.
   */
  exclude?: Array<string | RegExp>;
  /** Report this fraction of matching requests, 0–1. Default 1. */
  sample?: number;
  /** Give up on a report after this long. Default 3000 ms. It never delays your response. */
  timeoutMs?: number;
}

/** Hands deferred work to the platform. Receives a callback, as Next's `after()` does. */
export type Defer = (task: () => Promise<void>) => void;

/** Build output and static files: never a page an AI system reads for its content. */
const DEFAULT_EXCLUDED_PREFIXES = ["/_next/"];
const STATIC_ASSET =
  /\.(?:js|mjs|cjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|bmp|tiff?|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|zip|gz|wasm)$/i;

/** Hosts whose referrals are reported. A subdomain of one counts as the same assistant. */
export const AI_ASSISTANT_HOSTS: readonly string[] = [
  "chatgpt.com",
  "chat.openai.com",
  "perplexity.ai",
  "gemini.google.com",
  "copilot.microsoft.com",
  "claude.ai",
  "grok.com",
];

const DEFAULT_TIMEOUT_MS = 3000;

interface VisitEvent {
  ts: string;
  path: string;
  ua?: string;
  referrerHost?: string;
  utmSource?: string;
  ip?: string;
}

interface VisitPayload {
  /** One or more visits, oldest first. Several arrive together under load — see the budget. */
  events: VisitEvent[];
  /** Present when `sample` < 1: each event stands for 1/sampleRate matching requests. */
  sampleRate?: number;
  /**
   * Matching requests this process discarded since its last send, and could not report.
   *
   * Reported rather than forgotten so the counts Geoffy shows can say they are a minimum. A
   * visit that is merely waiting for the next send is NOT counted here — only one given up on.
   */
  dropped?: number;
}

/**
 * Reports (network calls) per process per site: a burst of this many, refilled at this many a
 * minute.
 *
 * The bound is on CALLS, not on visits. Anyone can send a crawler's user agent, so an unbounded
 * reporter on a busy storefront is not something this package may ship — but a crawler sweep is
 * hundreds of pages in a minute, and one call per page spent this budget in seconds.
 *
 * So a visit that cannot be sent immediately is QUEUED rather than thrown away, and the next
 * call carries the whole queue. The merchant's server still makes at most this many calls a
 * minute; each one now reports up to {@link MAX_EVENTS_PER_REPORT} visits instead of one.
 */
const BUDGET_PER_MINUTE = 60;

/**
 * Visits per report. Geoffy refuses a longer list, so this is a ceiling rather than a
 * preference — a report over it is rejected whole and every visit in it is lost.
 */
const MAX_EVENTS_PER_REPORT = 50;

/**
 * Visits held per site while waiting for the next call. Past this the OLDEST is discarded.
 *
 * Oldest rather than newest on purpose: the older a queued visit is, the closer it is to the
 * freshness bound below, so discarding it loses the one most likely to be refused anyway.
 * An unbounded queue would be a memory leak on the merchant's server, which is the one cost
 * this package must never impose.
 */
const MAX_QUEUED_EVENTS = 500;

/**
 * How stale a queued visit may be when a report is built.
 *
 * Geoffy refuses a report whose timestamps are too far from its own clock, and it refuses the
 * WHOLE report — so one straggler left over from an earlier burst would lose every fresh visit
 * batched with it. Comfortably inside that bound, so a slow send cannot cross it in flight.
 *
 * A visit pruned here is counted as dropped, never silently forgotten: a count Geoffy knows is
 * short is one it can label, and one it does not know about is one it presents as a total.
 */
const MAX_EVENT_AGE_MS = 5 * 60_000;

interface Budget {
  tokens: number;
  refilledAt: number;
}

interface Queue {
  events: VisitEvent[];
  /** Visits discarded since the last successful send — over the queue cap, or too stale. */
  dropped: number;
}

/** Keyed on configuration (`origin|siteKey|kind`), never on request data, so it cannot grow per request. */
const budgets = new Map<string, Budget>();
const queues = new Map<string, Queue>();

/** Take one CALL from the budget. False when the budget is spent for now. */
function takeBudget(key: string): boolean {
  const now = Date.now();
  const b = budgets.get(key) ?? { tokens: BUDGET_PER_MINUTE, refilledAt: now };
  budgets.set(key, b);
  b.tokens = Math.min(BUDGET_PER_MINUTE, b.tokens + ((now - b.refilledAt) / 60_000) * BUDGET_PER_MINUTE);
  b.refilledAt = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** Hold a visit until a call is available. Past the cap the oldest is dropped, and counted. */
function enqueue(key: string, event: VisitEvent): void {
  const q = queues.get(key) ?? { events: [], dropped: 0 };
  queues.set(key, q);
  q.events.push(event);
  while (q.events.length > MAX_QUEUED_EVENTS) {
    q.events.shift();
    q.dropped += 1;
  }
}

/**
 * Take the next report's worth of visits, or `null` when there is nothing to send.
 *
 * Stale visits are pruned and counted BEFORE the slice, so they can neither be sent (where
 * they would cost the whole report) nor vanish unrecorded.
 */
function drain(key: string, now: number): { events: VisitEvent[]; dropped: number } | null {
  const q = queues.get(key);
  if (!q) return null;

  const fresh: VisitEvent[] = [];
  for (const event of q.events) {
    if (now - Date.parse(event.ts) > MAX_EVENT_AGE_MS) q.dropped += 1;
    else fresh.push(event);
  }
  q.events = fresh;

  // Nothing to send: KEEP the drop count for the next report that does go out. Clearing it
  // here would lose exactly the number this whole mechanism exists to preserve — a count
  // Geoffy never hears about is one it presents as a total.
  if (q.events.length === 0) return null;

  const events = q.events.splice(0, MAX_EVENTS_PER_REPORT);
  const dropped = q.dropped;
  q.dropped = 0;
  return { events, dropped };
}

/**
 * Count visits back onto the queue's drop total after a report failed to arrive.
 *
 * Bounded by the same cap as the queue itself, so a site that cannot reach Geoffy at all
 * accumulates a large-but-finite number rather than growing one for ever.
 */
function creditDropped(key: string, count: number): void {
  if (count <= 0) return;
  const q = queues.get(key) ?? { events: [], dropped: 0 };
  queues.set(key, q);
  q.dropped = Math.min(q.dropped + count, MAX_DROPPED_CARRIED);
}

/**
 * The largest drop count carried between reports.
 *
 * Generous, because under-reporting here is the failure this whole mechanism exists to stop,
 * and finite, because the alternative is a number that grows without bound on a site that has
 * been unable to reach Geoffy for weeks. Comfortably inside what the receiver accepts.
 */
const MAX_DROPPED_CARRIED = 1_000_000;

/** Test seam: forget every budget and every queued visit. */
export function resetAiVisitBudgets(): void {
  budgets.clear();
  queues.clear();
}

/**
 * Report this request if it is an AI visit. Returns nothing, throws nothing, and never waits.
 *
 * `defer` is how the platform keeps work alive after the response; without it the report is
 * started and not awaited, which a long-running Node server completes on its own.
 */
export function trackAiVisit(opts: GeoffyAiVisitOptions, request: Request, defer?: Defer): void {
  try {
    const siteKey = typeof opts?.siteKey === "string" ? opts.siteKey.trim() : "";
    if (!siteKey) return;
    if (request.method !== "GET" && request.method !== "HEAD") return;
    if (isPrefetch(request)) return;

    const url = new URL(request.url);
    if (isExcluded(url.pathname, opts.exclude)) return;

    const secret = resolveSecret(opts);
    if (!secret) return;

    const origin = resolveGeoffyOrigin(opts);
    const listKey = `${origin}|${siteKey}`;
    const ua = request.headers.get("user-agent") ?? "";
    const agent = matchAiAgent(ua, listKey);
    const referral = referralOf(request, url);
    if (!agent && !referral) return;
    if (!sampled(opts.sample)) return;

    const event: VisitEvent = {
      // One clock for the whole module: `Date.now()` is what the budget and the freshness
      // prune read, and a visit stamped from a different source could be pruned the instant
      // it is queued.
      ts: new Date(Date.now()).toISOString(),
      path: `${url.origin}${url.pathname}`,
      ...referral,
    };
    // The user agent and an address only for a visit that CLAIMS to be a crawler: they are what
    // Geoffy classifies and checks. A shopper's are of no use to either and not ours to collect.
    if (agent) {
      event.ua = ua.slice(0, MAX_USER_AGENT_LENGTH);
      const ip = resolveClientIp(opts, request);
      if (ip) event.ip = ip;
    }

    // Crawler visits and referrals keep separate budgets AND separate queues, so a flood of
    // spoofed crawler requests can neither spend the calls nor fill the queue that the
    // shoppers arriving from an assistant depend on.
    const kind = `${listKey}|${agent ? "agent" : "referral"}`;
    enqueue(kind, event);

    // The bound is on CALLS. A visit that arrives with the budget spent waits for the next
    // one rather than being thrown away, and that call takes the whole queue with it — which
    // is why a crawler sweep no longer outruns the reporter.
    if (!takeBudget(kind)) return;
    const batch = drain(kind, Date.now());
    if (!batch || batch.events.length === 0) return;

    const sampleRate = normalisedSample(opts.sample);
    const payload: VisitPayload = {
      events: batch.events,
      ...(sampleRate < 1 ? { sampleRate } : {}),
      ...(batch.dropped > 0 ? { dropped: batch.dropped } : {}),
    };
    const base = `${origin}/headless/${encodeURIComponent(siteKey)}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Runs at most once, however the hook behaves: a hook that starts the task and THEN throws
    // must not cause the fallback below to send the same report a second time.
    let started: Promise<void> | null = null;
    const work = (): Promise<void> => {
      started ??= Promise.allSettled([
        sendVisits(`${base}/visits`, secret, payload, timeoutMs).then((sent) => {
          // A failed call loses the whole batch — up to 50 visits, plus whatever drop count
          // rode with it. Both are counted back onto the queue so the NEXT report still says
          // how much is missing; without this a merchant whose calls are timing out or being
          // refused loses the reads AND the evidence that reads were lost, which is the state
          // the count matters most in.
          //
          // Only the COUNT comes back, never the events: they would age past the freshness
          // bound and then cost the whole next report, since a report is refused as a unit.
          if (!sent) creditDropped(kind, payload.events.length + (payload.dropped ?? 0));
        }),
        // Refreshed only from here — the report of a MATCHED request — so an ordinary page view
        // still makes no call at all. A newly listed agent is recognised from the next request on.
        refreshAiAgents(listKey, `${base}/agents.json`, timeoutMs),
      ]).then(() => undefined);
      return started;
    };

    if (defer) {
      try {
        defer(work);
        return;
      } catch {
        // The platform refused the hook (e.g. called outside a request scope). Fall through
        // and run it detached rather than lose the report.
      }
    }
    void work();
  } catch {
    // Nothing here may reach the merchant's request.
  }
}

/**
 * Send one report. Resolves `true` when it was accepted, `false` when it was lost.
 *
 * It still never throws: a lost report is a missing data point, never an error on the
 * merchant's site. What the caller does with `false` is count it, so the next report can say
 * how much is missing rather than going quiet about it.
 */
async function sendVisits(
  url: string,
  secret: string,
  payload: VisitPayload,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = JSON.stringify(payload);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-geoffy-signature": await signBody(secret, body),
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    // Nothing to read; release the connection.
    await res.body?.cancel().catch(() => undefined);
    // A refusal counts as lost as surely as a timeout does — a rate-limited or rejected
    // report took the batch with it.
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resolveSecret(opts: GeoffyAiVisitOptions): string {
  if (typeof opts.secret === "string") return opts.secret.trim();
  if (typeof process === "undefined" || !process.env) return "";
  const env = process.env.GEOFFY_REVALIDATE_SECRET;
  return typeof env === "string" ? env.trim() : "";
}

function isPrefetch(request: Request): boolean {
  const h = request.headers;
  if (h.get("next-router-prefetch")) return true;
  const purpose = `${h.get("purpose") ?? ""} ${h.get("sec-purpose") ?? ""}`.toLowerCase();
  return purpose.includes("prefetch");
}

function isExcluded(pathname: string, extra: GeoffyAiVisitOptions["exclude"]): boolean {
  if (DEFAULT_EXCLUDED_PREFIXES.some((p) => pathname.startsWith(p))) return true;
  if (STATIC_ASSET.test(pathname)) return true;
  return (extra ?? []).some((rule) =>
    typeof rule === "string" ? pathname.startsWith(rule) : rule instanceof RegExp && rule.test(pathname),
  );
}

function isAssistantHost(value: string): string | null {
  const host = value.trim().toLowerCase().replace(/^www\./, "");
  return AI_ASSISTANT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? host : null;
}

function referralOf(
  request: Request,
  url: URL,
): { referrerHost?: string; utmSource?: string } | null {
  let referrerHost: string | null = null;
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      referrerHost = isAssistantHost(new URL(referer).hostname);
    } catch {
      referrerHost = null;
    }
  }
  const utm = url.searchParams.get("utm_source");
  const utmSource = utm ? isAssistantHost(utm) : null;
  if (!referrerHost && !utmSource) return null;
  return {
    ...(referrerHost ? { referrerHost } : {}),
    ...(utmSource ? { utmSource } : {}),
  };
}

function normalisedSample(sample: number | undefined): number {
  if (typeof sample !== "number" || Number.isNaN(sample)) return 1;
  return Math.min(1, Math.max(0, sample));
}

function sampled(sample: number | undefined): boolean {
  const rate = normalisedSample(sample);
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return Math.random() < rate;
}

/** An address that is at least shaped like IPv4 or IPv6, or `null`. */
function plausibleIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(v)) return null;
  return v.includes(".") || v.includes(":") ? v : null;
}

function resolveClientIp(opts: GeoffyAiVisitOptions, request: Request): string | null {
  if (opts.clientIp) {
    try {
      return plausibleIp(opts.clientIp(request));
    } catch {
      return null;
    }
  }
  // Set by the runtime itself where it provides one (older Next on Vercel), never by a header.
  const runtimeIp = plausibleIp((request as Request & { ip?: unknown }).ip);
  if (runtimeIp) return runtimeIp;
  // Vercel overwrites this header at its edge, so it is trustworthy ON Vercel — and only there.
  // Anywhere else a client can send it, so it is read only when the process says it is Vercel.
  if (!onVercel()) return null;
  const vercel = request.headers.get("x-vercel-forwarded-for");
  // A list here is not a shape we expect; rather than guess which entry is the client, omit it.
  if (!vercel || vercel.includes(",")) return null;
  return plausibleIp(vercel);
}

function onVercel(): boolean {
  return typeof process !== "undefined" && !!process.env && !!process.env.VERCEL;
}
