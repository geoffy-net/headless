/**
 * Which requests come from an AI system, decided on the merchant's server.
 *
 * Internal module — not a package entry. It is shared by the namespace proxy and text routes
 * (which pass a crawler's user agent through to Geoffy) and by the AI visit middleware (which
 * reports visits). It imports nothing from the rest of the package, so either side can use it.
 *
 * Matching is a case-insensitive SUBSTRING test against a short list of product tokens. Not a
 * regular expression, deliberately: the list can be extended from Geoffy's side at run time,
 * and a pattern received over the network and run against every request is a denial-of-service
 * waiting for one bad entry.
 */

/**
 * The AI agents recognised with no network call at all.
 *
 * Some of these (`Google-Extended`, `Applebot-Extended`) are robots.txt product tokens that
 * rarely appear in a user agent; they cost nothing to keep and match if a vendor starts sending
 * them. `bingbot` is here because Microsoft's assistant answers from Bing's index.
 */
export const BUILT_IN_AI_AGENT_SIGNATURES: readonly string[] = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "GoogleOther",
  "Gemini-Deep-Research",
  "Google-Agent",
  "Applebot-Extended",
  "Amazonbot",
  "meta-externalagent",
  "CCBot",
  "Bytespider",
  "bingbot",
];

/** How long a list read from Geoffy is trusted before it is read again. */
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long to wait after a failed read. A failure must not turn every AI visit into a read. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
/** Bounds on a list read from the network. Anything outside them is refused whole. */
const MAX_SIGNATURES = 500;
const MAX_SIGNATURE_LENGTH = 64;
const MAX_LIST_BYTES = 64 * 1024;

interface LearnedList {
  /** Tokens Geoffy added on top of the built-in list, lowercased. */
  extra: string[];
  nextRefreshAt: number;
  inflight: Promise<void> | null;
}

/** Keyed by `${origin}|${siteKey}`, so two sites in one process never share a list. */
const learned = new Map<string, LearnedList>();

const BUILT_IN_LOWER = BUILT_IN_AI_AGENT_SIGNATURES.map((s) => s.toLowerCase());

/**
 * The signature a user agent matches, or `null`.
 *
 * `listKey` selects the list learned for one site; without it only the built-in list applies.
 */
export function matchAiAgent(userAgent: string | null | undefined, listKey?: string): string | null {
  if (typeof userAgent !== "string" || userAgent === "") return null;
  const ua = userAgent.toLowerCase();
  const i = BUILT_IN_LOWER.findIndex((s) => ua.includes(s));
  if (i >= 0) return BUILT_IN_AI_AGENT_SIGNATURES[i] ?? null;
  const extra = listKey ? learned.get(listKey)?.extra : undefined;
  return extra?.find((s) => ua.includes(s)) ?? null;
}

/** Longest user agent we pass on. Real ones are well under this; anything longer is noise. */
export const MAX_USER_AGENT_LENGTH = 512;

/**
 * The header that names the AI agent a server-side fetch is made for — empty for everybody
 * else.
 *
 * The value is the matched SIGNATURE (`GPTBot`), never the raw user agent. These fetches go
 * through Next's data cache, whose key includes the request headers, so the header's value set
 * must be small and closed: a raw user agent would give every browser version — and every
 * caller who sends `GPTBot <anything random>` — its own cache entry and its own fetch from
 * Geoffy, which is a cache bypass by header. A human's user agent is not passed at all; it is
 * not ours to collect.
 */
export function crawlerUserAgentHeaders(
  request: Request | undefined,
  listKey?: string,
): Record<string, string> {
  try {
    const agent = matchAiAgent(request?.headers?.get("user-agent"), listKey);
    // Printable ASCII only: `fetch` throws on anything else, which would turn a served file
    // into an error page. Built-in tokens already are; a learned one is checked here.
    return agent && /^[\x21-\x7e]+$/.test(agent) ? { "x-geoffy-client-ua": agent } : {};
  } catch {
    return {};
  }
}

/**
 * Read Geoffy's current agent list for one site, if it is due. Never rejects.
 *
 * Expected body: `{ "version": 1, "signatures": ["GPTBot", …] }`. The tokens are ADDED to the
 * built-in list, never substituted for it, so a short or empty answer cannot stop the package
 * recognising the agents it ships with. An answer in any other shape is ignored whole.
 */
export function refreshAiAgents(listKey: string, url: string, timeoutMs: number): Promise<void> {
  const now = Date.now();
  const state = learned.get(listKey) ?? { extra: [], nextRefreshAt: 0, inflight: null };
  learned.set(listKey, state);
  if (state.inflight) return state.inflight;
  if (now < state.nextRefreshAt) return Promise.resolve();

  const run = async (): Promise<void> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal, redirect: "error" });
      const text = res.ok ? await readBounded(res, MAX_LIST_BYTES) : null;
      const parsed = text ? parseAgentList(JSON.parse(text)) : null;
      if (!res.ok) await res.body?.cancel().catch(() => undefined);
      if (parsed) {
        state.extra = parsed;
        state.nextRefreshAt = Date.now() + REFRESH_AFTER_MS;
      } else {
        state.nextRefreshAt = Date.now() + RETRY_AFTER_MS;
      }
    } catch {
      // Keep whatever list we had. The built-in list always applies regardless.
      state.nextRefreshAt = Date.now() + RETRY_AFTER_MS;
    } finally {
      clearTimeout(timer);
      state.inflight = null;
    }
  };
  state.inflight = run();
  return state.inflight;
}

/**
 * The body as text, or `null` once it passes `limit` bytes. Read chunk by chunk, so an answer
 * with no `content-length` is still never buffered past the limit.
 */
async function readBounded(res: Response, limit: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    all.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function parseAgentList(body: unknown): string[] | null {
  if (!body || typeof body !== "object") return null;
  const { version, signatures } = body as { version?: unknown; signatures?: unknown };
  if (version !== 1 || !Array.isArray(signatures) || signatures.length > MAX_SIGNATURES) return null;
  const out: string[] = [];
  for (const s of signatures) {
    if (typeof s !== "string") return null;
    const token = s.trim().toLowerCase();
    // A one- or two-character token would match nearly every user agent.
    if (token.length < 3 || token.length > MAX_SIGNATURE_LENGTH) return null;
    out.push(token);
  }
  return out;
}

/** Test seam: forget every learned list. */
export function resetLearnedAiAgents(): void {
  learned.clear();
}
