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
  events: VisitEvent[];
  /** Present when `sample` < 1: each event stands for 1/sampleRate matching requests. */
  sampleRate?: number;
  /** Matching requests this process dropped over its budget since its last send. */
  dropped?: number;
}

/** Reports per process per site: a burst of this many, refilled at this many a minute. */
const BUDGET_PER_MINUTE = 60;

interface Budget {
  tokens: number;
  refilledAt: number;
  dropped: number;
}

/** Keyed on configuration (`origin|siteKey`), never on request data, so it cannot grow per request. */
const budgets = new Map<string, Budget>();

/** Take one report from the budget: `null` when spent, else how many were dropped before it. */
function takeBudget(listKey: string): { dropped: number } | null {
  const now = Date.now();
  const b = budgets.get(listKey) ?? { tokens: BUDGET_PER_MINUTE, refilledAt: now, dropped: 0 };
  budgets.set(listKey, b);
  b.tokens = Math.min(BUDGET_PER_MINUTE, b.tokens + ((now - b.refilledAt) / 60_000) * BUDGET_PER_MINUTE);
  b.refilledAt = now;
  if (b.tokens < 1) {
    b.dropped += 1;
    return null;
  }
  b.tokens -= 1;
  const dropped = b.dropped;
  b.dropped = 0;
  return { dropped };
}

/** Test seam: forget every budget. */
export function resetAiVisitBudgets(): void {
  budgets.clear();
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

    // Anyone can send a crawler's user agent or an assistant's referer, so the report rate is
    // bounded per process. What is dropped is counted and reported with the next send. Crawler
    // visits and referrals have separate budgets, so a flood of spoofed crawler requests cannot
    // crowd out the shoppers arriving from an assistant.
    const budget = takeBudget(`${listKey}|${agent ? "agent" : "referral"}`);
    if (budget === null) return;

    const event: VisitEvent = {
      ts: new Date().toISOString(),
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

    const sampleRate = normalisedSample(opts.sample);
    const payload: VisitPayload = {
      events: [event],
      ...(sampleRate < 1 ? { sampleRate } : {}),
      ...(budget.dropped > 0 ? { dropped: budget.dropped } : {}),
    };
    const base = `${origin}/headless/${encodeURIComponent(siteKey)}`;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Runs at most once, however the hook behaves: a hook that starts the task and THEN throws
    // must not cause the fallback below to send the same report a second time.
    let started: Promise<void> | null = null;
    const work = (): Promise<void> => {
      started ??= Promise.allSettled([
        sendVisits(`${base}/visits`, secret, payload, timeoutMs),
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

async function sendVisits(
  url: string,
  secret: string,
  payload: VisitPayload,
  timeoutMs: number,
): Promise<void> {
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
  } catch {
    // A lost report is a missing data point, never an error on the merchant's site.
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
