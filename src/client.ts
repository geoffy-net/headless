/**
 * The Geoffy headless client — the code that runs on a MERCHANT's server.
 *
 * This package is unusual in this repo: it is the only code we write that executes inside
 * somebody else's application. Two consequences shape every line of it.
 *
 * ## 1. It must never break the merchant's page
 *
 * A merchant's storefront is their business. If Geoffy is slow, down, rate-limiting or
 * returning nonsense, the correct behaviour is for their product page to render exactly as
 * it would have without us. So nothing here throws, ever: every failure resolves to `null`,
 * and every caller is written to render nothing when it gets `null`.
 *
 * That is also why the fetch carries its own timeout. A merchant's build should not hang
 * because our origin is wedged — an ISR revalidation that never settles is worse than one
 * that fails, because it holds a worker rather than falling back to cached output.
 *
 * ## 2. It must render on the SERVER
 *
 * The entire point is to be read by AI crawlers, and they largely do not execute
 * JavaScript. Content injected on the client is invisible to the systems this product
 * exists to reach, so these helpers are server-only and the framework entry points are
 * server components and route handlers rather than hooks.
 */

/**
 * Where the artifacts live — the production origin, and the answer whenever nothing else
 * says otherwise.
 *
 * Two things override it, in this order: `origin` on the options object (per call site),
 * then the `GEOFFY_ORIGIN` environment variable (whole process). The environment form is
 * what lets a merchant — or us, in dev — point a build at another instance without threading
 * `origin` through every `<GeoffyProduct>`, every `createGeoffyText*` and every
 * `fetchGeoffyText` call.
 *
 * See `resolveGeoffyOrigin` for what happens to a value that is not usable.
 */
export const DEFAULT_GEOFFY_ORIGIN = "https://api.geoffy.ai";

/**
 * Read `GEOFFY_ORIGIN`, or `undefined` if it is absent or unusable.
 *
 * Read at call time rather than at module load, so a runtime that populates the environment
 * after import still sees it.
 */
function readEnvOrigin(): string | undefined {
  // Edge runtimes have no `process` at all, and some shims define it without `env`. This
  // package runs inside somebody else's application, so it may not assume either exists.
  if (typeof process === "undefined" || !process.env) return undefined;

  const raw = process.env.GEOFFY_ORIGIN;
  if (typeof raw !== "string") return undefined;

  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // An unusable value is IGNORED, and the default answers instead. Stated in full so nobody
  // "tidies" it into a throw:
  //
  //  - This is a SERVE path, not a persist path. Nothing derived from this value is written
  //    anywhere; the worst case is one build fetching production content while its author
  //    meant to fetch dev — recoverable, and self-announcing, because the dev content they
  //    were looking for is simply not there.
  //  - The alternatives are both destructive by that rule's test — "what happens if I'm
  //    wrong?". Throwing breaks the merchant's page, which is the one thing this package
  //    promises never to do. Concatenating the value anyway builds a request URL out of
  //    input nobody validated, which is why a relative path and a `javascript:` / `file:`
  //    scheme are refused here rather than passed through.
  //  - The default is not a fabricated stand-in for an unknown. It is this package's
  //    documented production origin — the same answer the caller would have got had the
  //    variable never been set — so falling back asserts nothing that was not already true.
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;

  return trimmed;
}

/**
 * The Geoffy origin for one call: explicit option, then `GEOFFY_ORIGIN`, then the default.
 *
 * Never throws, and never returns anything but an absolute http(s) origin.
 */
export function resolveGeoffyOrigin(opts: Pick<GeoffyClientOptions, "origin">): string {
  return (opts.origin ?? readEnvOrigin() ?? DEFAULT_GEOFFY_ORIGIN).replace(/\/$/, "");
}

export interface GeoffyClientOptions {
  /** The site key from your Geoffy settings. Public — it addresses, it does not authorise. */
  siteKey: string;
  /** Overrides `GEOFFY_ORIGIN` and the default for this call. See `resolveGeoffyOrigin`. */
  origin?: string;
  /**
   * How long to wait before giving up and rendering the page without Geoffy content.
   *
   * Deliberately short. This runs during a build or an ISR revalidation, and the fallback
   * (render without the widget) is cheap, while a stalled build is not.
   */
  timeoutMs?: number;
  /**
   * Seconds the framework may reuse a cached copy. Your framework, not us, enforces this —
   * we pass it through so one number configures both the cache and the self-healing window.
   *
   * This is the backstop that makes the whole design self-correcting: if our purge call to
   * your site is lost, the page still refreshes within this window on its own.
   */
  revalidateSeconds?: number;
}

export interface GeoffyProductArtifact {
  handle: string;
  /** The URL Geoffy published this product against. Compare it with your own canonical. */
  canonicalUrl: string;
  /** schema.org Product node, ready to serialise into a script tag. */
  jsonLd: unknown;
  /** The visible widget, styles included. Render as-is; do not sanitise the styles out. */
  widgetHtml: string;
  publishedAt: string | null;
}

function artifactUrl(opts: GeoffyClientOptions, path: string): string {
  return `${resolveGeoffyOrigin(opts)}/headless/${encodeURIComponent(opts.siteKey)}${path}`;
}

/**
 * Fetch one product's artifacts.
 *
 * Returns `null` for every failure mode — not published, site not verified, network error,
 * timeout, malformed response. The caller cannot tell them apart and does not need to: in
 * all of them the right thing to render is nothing.
 */
export async function fetchGeoffyProduct(
  opts: GeoffyClientOptions,
  handle: string,
): Promise<GeoffyProductArtifact | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);

  try {
    const res = await fetch(artifactUrl(opts, `/products/${encodeURIComponent(handle)}`), {
      signal: controller.signal,
      redirect: "error",
      // Consumed by Next; harmless elsewhere. The tag is what our purge call targets.
      next: {
        revalidate: opts.revalidateSeconds ?? 3600,
        tags: [`geoffy:product:${handle}`],
      },
    } as RequestInit);

    if (!res.ok) return null;
    const body = (await res.json()) as GeoffyProductArtifact;

    // Both surfaces or neither. A page carrying our structured data without the visible
    // widget makes claims to a crawler that a shopper cannot see, which is the one outcome
    // this product must never produce.
    if (!body?.jsonLd || !body?.widgetHtml) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch one of the site-wide text artifacts. `null` on any failure. */
export async function fetchGeoffyText(
  opts: GeoffyClientOptions,
  file: "llms.txt" | "llms-full.txt" | "agents.md" | "robots-rules.txt",
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 4000);
  try {
    const res = await fetch(artifactUrl(opts, `/${file}`), {
      signal: controller.signal,
      redirect: "error",
      next: { revalidate: opts.revalidateSeconds ?? 3600, tags: ["geoffy:root-files"] },
    } as RequestInit);
    if (!res.ok) return null;

    // A 200 is not enough on its own. `res.text()` will happily hand back an HTML error
    // page, a CDN interstitial or a dashboard shell, and the caller writes the result
    // straight into a route that declares `content-type: text/plain` — so a crawler is
    // served somebody's markup as this site's llms.txt, with a successful status. That is
    // the very failure `createGeoffyTextRoute` documents, arriving from the other side.
    //
    // `redirect: "error"` closes the redirect-to-an-HTML-page path; the content-type gate
    // below closes the rest of the class.
    //
    // Both types are ours: the API serves agents.md as text/markdown and the others as
    // text/plain.
    const contentType = res.headers.get("content-type") ?? "";
    if (!/^text\/(plain|markdown)\b/i.test(contentType)) return null;

    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Serialise a JSON-LD node for embedding in a script tag.
 *
 * `<` is escaped because a `</script>` sequence inside any string value would close the tag
 * early and turn the rest of the node into markup. Our content is server-generated, so this
 * is not defence against a hostile merchant — it is defence against a product description
 * that happens to contain the characters.
 */
export function serializeJsonLd(node: unknown): string {
  return JSON.stringify(node).replace(/</g, "\\u003c");
}

/**
 * `match` — this page is the one the artifact was published for.
 * `mismatch` — it is not, and rendering here would put one page's content on another.
 * `unknown` — we could not read one of the two values, so we are not entitled to an opinion.
 */
export type CanonicalVerdict = "match" | "mismatch" | "unknown";

/**
 * Take the path out of a canonical, whether it arrives absolute or as a bare path.
 *
 * Paths are compared case-sensitively, because they are; a trailing slash is collapsed, and
 * query and fragment are dropped, because none of the three changes which page this is.
 */
function canonicalPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  let path: string;
  try {
    path = new URL(trimmed).pathname;
  } catch {
    // Not absolute. A bare path is a legitimate thing to hand us and needs no origin.
    if (!trimmed.startsWith("/")) return null;
    path = trimmed.split(/[?#]/)[0] ?? "";
  }
  const collapsed = path.replace(/\/+$/, "");
  return collapsed === "" ? "/" : collapsed;
}

/**
 * Is this page the page the artifact belongs to?
 *
 * ## Why the PATH and not the whole URL
 *
 * The question being asked is "which page of this site", not "which site". The site is already
 * settled — the artifact was fetched with your site key, which addresses exactly one site — so
 * comparing origins adds no safety and takes some away: a build running on `localhost` against
 * a canonical of `https://yourdomain.com/…` would compare unequal and blank a page that is
 * completely correct. Local preview is a documented workflow, so the comparison must survive it.
 *
 * ## Why `unknown` is a third answer rather than a `false`
 *
 * A value we cannot parse tells us nothing about whether the page matches. Reporting it as a
 * mismatch would blank a working page over a typo in an optional argument, which is the
 * destructive reading of an unknown. The caller renders on `unknown` and says so in the markup,
 * so the guard never silently pretends to be active.
 */
export function compareCanonical(pageCanonical: string, artifactCanonical: string): CanonicalVerdict {
  const page = canonicalPath(pageCanonical);
  const artifact = canonicalPath(artifactCanonical);
  if (page === null || artifact === null) return "unknown";
  return page === artifact ? "match" : "mismatch";
}

/**
 * The inert marker left behind when the guard declined to render, or could not judge.
 *
 * Deliberately visible in view-source and deliberately not renderable: every other failure in
 * this package renders nothing, so without this a refusal and "nothing is published yet" are
 * the same picture and opposite facts.
 *
 * `data-geoffy-skipped` is NOT `data-geoffy-product`, which is the attribute Geoffy's presence
 * check matches on. A skipped page must never read as an integrated one.
 */
export function skippedMarker(reason: string, detail: string): string {
  return `<script type="application/json" data-geoffy-skipped="${reason}">${serializeJsonLd({ reason, detail })}</script>`;
}

/* -------------------------------------------------------------------------------------------
 * The namespace proxy
 *
 * Everything above fetches ONE named thing. This section serves a whole namespace, and the
 * difference is the point of it.
 *
 * Geoffy has more surfaces than the three root files: a plain-text twin per product, a
 * discovery sitemap, and buying-guide pages. They all live under `/apps/geoffy/…` — the same
 * path shape a Shopify store gets from the App Proxy and a WordPress site gets from the Gus
 * plugin's rewrite rules — and until you mount that namespace, they are served from Geoffy's
 * domain instead of yours. That matters more than it sounds: an AI system that reads a guide
 * at `api.geoffy.ai` records `api.geoffy.ai` as the source, and the citation goes to us
 * rather than to you.
 *
 * One catch-all route moves all of it onto your domain. It is also the last integration
 * change this package will ask you for: a surface added later appears under the namespace you
 * already mounted, with no upgrade and no new route.
 *
 * ## What this proxy is NOT
 *
 * It is text-only and GET-only, deliberately, and those are the two bounds on the
 * "anything we ship later just works" promise. A binary artifact (an image, a gzipped
 * sitemap) would be corrupted by the text decode, so if Geoffy ever ships one this file
 * changes. Recorded here rather than discovered later.
 * ------------------------------------------------------------------------------------------- */

/**
 * Where the namespace is mounted, on every merchant.
 *
 * Not configurable, and that is a deliberate reversal. An earlier draft took a `prefix`
 * option — but Geoffy's side hardcodes this path in two places that the merchant's build
 * cannot reach: the mount probe fetches `/apps/geoffy/sitemap.xml`, and the per-product twin
 * URLs it publishes into `llms.txt` are built from the same literal. A merchant who moved
 * their mount would be probed at a path they do not serve, reported permanently unmounted,
 * and have their grounding surfaces withheld — worse than not offering the option at all.
 *
 * If `/apps/*` is genuinely taken in your app, tell us; the fix is a per-site prefix on
 * Geoffy's side, not a flag here.
 */
export const PROXY_PREFIX = "/apps/geoffy";

/** Freshness policy for everything this package serves. One statement, one place. */
export const GEOFFY_CACHE_CONTROL =
  "public, max-age=300, stale-while-revalidate=86400, stale-if-error=86400";

/**
 * Content types the namespace can legitimately answer with.
 *
 * A 200 is not proof the response is ours — an upstream error page, CDN interstitial or
 * redirect target answers 200 just as readily. `fetchGeoffyText` gates on this for the same
 * reason; the proxy is the same hop with a wider path space, so it needs the same gate.
 * Without it, any HTML the origin emits is republished as SAME-ORIGIN content on the
 * merchant's storefront, where it runs against their shopper's session.
 *
 * `text/html` is on the list because guide pages genuinely are HTML, and those are served
 * with `sandbox` below rather than excluded.
 */
const ALLOWED_CONTENT_TYPES =
  /^(text\/(plain|markdown|html)|application\/xml|text\/xml|application\/json)\b/i;

/** The Next cache tag every namespace artifact is stored under. Purged by the revalidate route. */
export const GEOFFY_NAMESPACE_TAG = "geoffy:namespace";

/** Refuse a body larger than this rather than buffer it into the merchant's process. */
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

/**
 * The artifact path a request is asking for, or `null` if it is not ours to answer.
 *
 * Derived from the request URL rather than from the framework's catch-all params, so the same
 * implementation serves Next and Astro and does not depend on either one's route shape.
 *
 * ## What the guards are actually for
 *
 * The remainder is concatenated into an outbound URL, so it is untrusted input on its way to
 * a fetch. `..` would climb out of `/headless/{siteKey}` into another merchant's artifacts.
 *
 * A `//` remainder is refused for a NARROWER reason than it looks. It cannot make the result
 * protocol-relative: the remainder is concatenated after the origin and the site key, so it is
 * never in leading position and the host is always ours. The real reason is upstream path
 * confusion — an empty segment is normalised differently by different routers, so what we
 * matched would stop being what we send. Worth stating precisely, because a guard defended by
 * a wrong argument is one somebody deletes as theatre.
 *
 * ## Decoding to a fixed point
 *
 * The check runs on the fully-decoded string and the RAW one is forwarded, so a single decode
 * left a differential: `%252e%252e%252f` decodes once to `%2e%2e%2f`, contains no `..`, and
 * passes — then any hop upstream that decodes a second time re-forms `../`. Decoding to a
 * fixed point closes it, and the iteration cap keeps a pathological input from spinning.
 */
export function resolveProxyPath(requestUrl: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return null;
  }

  if (!pathname.startsWith(`${PROXY_PREFIX}/`)) return null;

  // Kept percent-encoded: this is forwarded verbatim, and a handle or slug that legally
  // contains an encoded character must survive the hop unchanged.
  const rest = pathname.slice(PROXY_PREFIX.length);

  // The bare mount is not an artifact. Without this, `/apps/geoffy/` yields a remainder of
  // "/" and we spend a round trip asking the origin for the namespace root — which answers
  // 404 at best, and at worst 301s to the slash-less form, which `redirect: "error"` turns
  // into "Geoffy is temporarily unavailable" on the merchant's domain. The two spellings of
  // one URL answered differently, which is also how a merchant curling the mount to check
  // their integration got told we were down.
  if (rest === "/" || rest === "") return null;

  let decoded = rest;
  for (let i = 0; i < 5; i += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      // A malformed escape cannot be judged, so it is refused rather than guessed at.
      return null;
    }
    if (next === decoded) break;
    decoded = next;
  }

  if (decoded.includes("..")) return null;
  if (decoded.includes("\\")) return null;
  if (decoded.startsWith("//")) return null;

  return rest;
}

interface GeoffyArtifact {
  body: string;
  contentType: string;
  /**
   * Geoffy's own HTTP status. A failure to reach Geoffy at all is `null` from
   * `fetchGeoffyArtifact`, never a status here.
   */
  status: number;
  /** The upstream `location`, on a 3xx. Never followed by us — see `handleGeoffyProxy`. */
  location: string | null;
}

/**
 * Fetch one artifact under this site's namespace.
 *
 * Returns the upstream status rather than collapsing everything to `null`, because the proxy
 * above it has to answer a crawler and the failures need different answers — see
 * `handleGeoffyProxy`.
 *
 * Not exported: the package's `.` entry is a permanent compatibility promise, and a
 * per-artifact fetch is exactly the file-list API shape the namespace exists to replace.
 */
async function fetchGeoffyArtifact(
  opts: GeoffyClientOptions,
  path: string,
): Promise<GeoffyArtifact | null> {
  const controller = new AbortController();
  // Deliberately shorter than the build-time default. This one runs on a merchant's PUBLIC
  // request path, where the cost of waiting is one of their request workers held while a
  // shopper queues behind it — not a build step that can afford to be patient.
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1500);
  try {
    const res = await fetch(artifactUrl(opts, path), {
      signal: controller.signal,
      // `manual`, not `error`. `error` made fetch reject on any 3xx, which the catch turned
      // into "Geoffy is temporarily unavailable" — permanently, for a page that had simply
      // moved. A renamed guide slug 301s, and so does a trailing-slash normalisation, so this
      // was the ordinary case reported as an outage. The redirect is now translated back onto
      // the merchant's own mount by `handleGeoffyProxy`, and a Location that does not point
      // into this site's own artifact prefix is refused rather than followed.
      redirect: "manual",
      next: { revalidate: opts.revalidateSeconds ?? 3600, tags: [GEOFFY_NAMESPACE_TAG] },
    } as RequestInit);

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const location = res.headers.get("location");

    // Refuse before reading. A body we are not going to serve is a body we should not spend
    // the merchant's memory on, and `content-length` is the only bound available up front.
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) return null;

    const isRedirect = res.status >= 300 && res.status < 400;
    if (res.ok && !isRedirect && !ALLOWED_CONTENT_TYPES.test(contentType)) return null;

    const body = await res.text();
    if (body.length > MAX_ARTIFACT_BYTES) return null;

    return { body, contentType, status: res.status, location };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const PLAIN_TEXT = "text/plain; charset=utf-8";

/** "There is nothing here." A settled answer a crawler may act on. */
function notFound(): Response {
  return new Response("Not found\n", {
    status: 404,
    // `no-store`, because a transient absence must not become a cached one. A guide published
    // a minute after a crawler asked for it would otherwise stay "missing" in the merchant's
    // CDN for whatever heuristic window that CDN applies to an uncached 404.
    headers: { "content-type": PLAIN_TEXT, "cache-control": "no-store" },
  });
}

/**
 * "We do not know whether there is anything here — ask again."
 *
 * ONE constructor for both retryable exits. They were written twice and had already drifted:
 * the unreachable branch said "temporarily unavailable" with `retry-after`, while an upstream
 * 5xx answered 503 carrying the body "Not found" and no `retry-after` — telling a crawler the
 * page does not exist under a status that says the opposite, and leaving it to apply its own
 * much longer backoff.
 */
function unavailable(): Response {
  return new Response("Geoffy is temporarily unavailable\n", {
    status: 503,
    headers: { "content-type": PLAIN_TEXT, "retry-after": "120", "cache-control": "no-store" },
  });
}

/**
 * Upstream statuses that mean "not now" rather than "not here".
 *
 * 429 is the one that matters: it is the likeliest answer when a crawler walks a large
 * catalogue, and mapping it to 404 tells that crawler the page does not exist — a confident
 * claim manufactured out of a rate limit, which is how pages fall out of an index over an
 * incident that lasted minutes. 408 is the same shape. 401/403 mean the site is not verified
 * yet, which is also a state that resolves.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429 || status === 401 || status === 403;
}

/**
 * Map an upstream redirect target back onto the merchant's mount, or `null` if it does not
 * belong to this site's artifacts.
 *
 * `https://api.geoffy.ai/headless/{siteKey}/guides/new` becomes `/apps/geoffy/guides/new`.
 * A Location naming another origin, another site key, or anything outside the artifact
 * prefix is refused — reflecting it would let an upstream response redirect a shopper off the
 * merchant's domain.
 */
function rewriteLocation(opts: GeoffyClientOptions, location: string): string | null {
  const base = artifactUrl(opts, "");
  let resolved: string;
  try {
    resolved = new URL(location, base).toString();
  } catch {
    return null;
  }
  if (!resolved.startsWith(`${base}/`)) return null;
  return `${PROXY_PREFIX}${resolved.slice(base.length)}`;
}

/**
 * Serve one request against the mounted namespace. Framework-neutral.
 *
 * ## Why a 404 and a 503 are not the same answer here
 *
 * `createGeoffyTextRoute` answers 404 for every failure, because `fetchGeoffyText` collapses
 * them all into `null` and genuinely cannot tell them apart. This can, so it does not:
 *
 * - Geoffy said 404 (or another settled 4xx) → 404. There is nothing published at that path.
 * - Geoffy was unreachable, rate-limiting, or erroring → 503 + `retry-after`.
 *
 * Answering 404 in the second case tells a crawler the page does not exist, which is a
 * confident claim made out of a timeout.
 *
 * Nothing here throws — including the response construction, which is the one statement built
 * from upstream-controlled data and therefore the one that can fail on a malformed header
 * value. A route that 500s on the merchant's own domain is a failure attributed to them, and
 * this package's standing promise is that a Geoffy problem never becomes theirs.
 */
export async function handleGeoffyProxy(
  opts: GeoffyClientOptions,
  request: Request,
): Promise<Response> {
  try {
    // An unset env var is the likeliest misconfiguration, and the Astro snippet reads
    // `import.meta.env.GEOFFY_SITE_KEY` with no guard, so it arrives as `undefined` and
    // builds `/headless/undefined/...` — 404ing the merchant's whole namespace with nothing
    // anywhere saying why. 503, not 404: whether the artifact exists is unknown, and the
    // fault is ours to surface rather than theirs to infer.
    if (typeof opts.siteKey !== "string" || opts.siteKey.trim() === "") return unavailable();

    const path = resolveProxyPath(request.url);
    if (path === null) return notFound();

    // The query string is deliberately NOT forwarded. No artifact route reads one, and
    // passing it through would let anyone bypass every cache in front of Geoffy — ours and
    // yours — by appending a unique parameter, turning a cheap crawl into unbounded load.
    const artifact = await fetchGeoffyArtifact(opts, path);

    if (artifact === null) return unavailable();

    // A moved artifact is a settled fact, not an outage. The upstream Location is rewritten
    // from Geoffy's addressing onto the merchant's mount, so the crawler follows a URL on
    // THEIR domain — which is the entire point of the namespace. Anything that does not point
    // into this site's own artifact prefix is refused rather than reflected, so the redirect
    // can never be used to bounce a visitor off the merchant's origin.
    if (artifact.status >= 300 && artifact.status < 400) {
      const target = artifact.location === null ? null : rewriteLocation(opts, artifact.location);
      return target === null
        ? notFound()
        : new Response(null, {
            status: artifact.status,
            headers: { location: target, "cache-control": "no-store" },
          });
    }

    if (isRetryableStatus(artifact.status)) return unavailable();
    if (artifact.status >= 400) return notFound();

    // The content type is passed through, not re-declared: a markdown twin served as
    // text/html is not the surface Geoffy published, and Geoffy's own mount check refuses to
    // confirm the integration when that happens. It has already been checked against the
    // allowlist in `fetchGeoffyArtifact`, so what reaches here cannot be arbitrary.
    //
    // `nosniff` and `sandbox` are the belt: the first stops a browser inferring a type we did
    // not send, the second means guide HTML — which IS served from the merchant's origin —
    // cannot script it.
    return new Response(artifact.body, {
      headers: {
        "content-type": artifact.contentType,
        "cache-control": GEOFFY_CACHE_CONTROL,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox allow-popups; default-src 'none'; style-src 'unsafe-inline'",
      },
    });
  } catch {
    return unavailable();
  }
}
