# Geoffy on a custom-built storefront

Integration guide for a merchant who builds their own storefront rather than running a
themed shop — the site is your own Next.js or Astro build. Shopify may sit behind it as the
commerce backend, or there may be no commerce platform at all and your catalogue is simply
your own pages. Both are supported. They differ only in how your catalogue reaches Geoffy,
which is settled once in "Which kind of site is yours" below; every integration step after
that is identical.

## Install

```bash
npm install @geoffy/headless
```

Requires Node 18 or newer — the package uses global `fetch`, `AbortController` and
`crypto.subtle`, none of which exist as globals before it. It is ESM-only, has no runtime
dependencies, and lists `react` as an optional peer: you need it only for the Next.js entry
point, and an Astro site never pulls React into its graph.

---

## What you get

| Surface | Where it appears |
|---|---|
| The visible Geoffy widget | On your product page, where you place the component |
| schema.org product data | On the same page, server-rendered — see [Where to put the markup](#where-to-put-the-markup) |
| `llms.txt`, `llms-full.txt`, `agents.md` | At the root of your own domain |
| A plain-text version of each product | On your own domain, under `/apps/geoffy/` |
| Your buying-guide pages, and their plain-text twins | On your own domain, under `/apps/geoffy/` |
| A sitemap of the Geoffy content on your site | On your own domain, under `/apps/geoffy/` |
| Crawler rules for AI agents, and a `Sitemap:` pointing at the above | Lines you merge into your own `robots.txt` |
| Search-engine index pings | Sent by Geoffy when you publish |

Everything is server-rendered. That is not a preference — AI crawlers largely do not run
JavaScript, so anything added to the page after hydration is invisible to the systems this
is for.

---

## Which kind of site is yours

Geoffy needs a catalogue — a list of products, with facts about each one. Where that list
comes from is the only thing that differs between the two kinds of site, and it decides which
door you set up through.

| | **Shopify behind your storefront** | **No commerce platform** |
|---|---|---|
| Your catalogue is | your Shopify products, already synced | your own product pages, read by a crawl |
| You set up under | your connected store | your Geoffy workspace |
| `handle` is | the Shopify product handle | the segment your product URL pattern captures |
| Before publishing | generate from the synced product | review what the crawl read back, then publish |
| What costs money | generating and publishing | generating and publishing. Connecting, proving ownership, checking the mount and crawling your catalogue are all free |

If you have no commerce platform, you tell Geoffy the shape of your product URLs — Geoffy
proposes patterns from your sitemap — and it reads each matching page for the facts it needs.
You see everything it found, per product, before you pay to generate anything. That is
deliberate: you should not have to buy the thing that shows you whether it is worth buying.

Nothing below this section branches again. The package does not know, and does not need to
know, which door you came through.

---

## Where to put the markup

Two decisions here, and only one of them changes whether a crawler reads you.

**Where on the page the structured data sits does not.** Google documents JSON-LD as valid
in the `<head>` **and** the `<body>`, and Geoffy's own live check searches the whole
document rather than a region. Both placements pass, on both sides.

**Whether it is server-rendered decides everything.** Google can read JSON-LD injected by
JavaScript — and that is the trap, because most of the AI crawlers this package exists for
cannot. Treat Google as the exception rather than the rule: if the markup is not in the
HTML your server sends, assume it is invisible.

So, in order of how much each is worth:

1. **Server-render both surfaces.** Not negotiable. Everything below is a detail by
   comparison.
2. **Put the structured data in `<head>` only where your framework can.** Astro and a
   hand-rolled integration can; **Next.js cannot**, and that is a framework rule rather than
   a choice this package made — see [below](#why-nextjs-renders-it-in-the-body). Where it is
   available it is a mild preference, not a requirement: the head is read before the body,
   and if a crawler truncates a long document the head is the part that survives.
3. **Put the widget where a shopper should see it.** Usually under your description or your
   buy box. Its position is entirely yours; Geoffy checks that it is present, never where.

### Why Next.js renders it in the body

Because there is no supported way to do otherwise, and because Next recommends the body
anyway. Both halves matter — the first means we could not offer head placement even if we
wanted to, the second means you are not losing anything.

| Route into `<head>` | Why it is not available |
|---|---|
| An inline `<script>` in your page or layout | React hoists a script only with `src` **and** `async={true}`. Its docs: *"Inline scripts are not de-duplicated or moved to the document `<head>`."* |
| `generateMetadata` | Emits `meta`, `link` and `title` only. There is no script field |
| `next/script` with `strategy="beforeInteractive"` | Does inject into the head — but *"must be placed inside the root layout"*, which never receives your product handle. Next also states a native `<script>` is the right choice for JSON-LD, since it is data rather than executable code |
| `<script async src="…">` | React would hoist this one, and it would be worthless: `async` means the browser fetches it, so every crawler that does not run JavaScript sees an empty tag |

Next's own guidance is *"render structured data as a `<script>` tag in your `layout.js` or
`page.js` components"*, and its example places it in the body. `<GeoffyProduct>` emits
exactly that shape, down to the `<` escaping their example uses.

So the two surfaces render together, wherever you place the component. That is also the
better trade on its own merits: you cannot ship one without the other by accident. A page
carrying structured data without the visible widget makes a claim to a crawler that no
shopper can see, so Geoffy holds such a product at `code_not_added` rather than publishing
it.

One practical note on the widget: its root is a block-level `<details>` at `width: 100%`, so
give it a full-width container rather than a narrow column. Its CSS is scoped entirely under
`.geoffy-widget` and inherits your font and colour, so it cannot restyle the rest of your
page and needs no dark-mode handling from you.

---

## Before you start

Three things must be true, and the third catches most people.

1. **Your site is connected to Geoffy** — through your store if Shopify is behind it, or
   through your workspace if nothing is.
2. **You have told Geoffy your site address and proved you own it.** See "Prove you own
   your domain" below.
3. **Each product page names itself as canonical.** Open any product page's source and look
   for `<link rel="canonical">`. It must point at that product, not at your home page.

Number 3 is worth checking properly. In Next.js App Router a missing `generateMetadata` on
your product page — whatever its path — means every product page inherits the layout's
metadata, so all of them tell search engines they are the home page. Geoffy publishes its
structured data against your canonical URL, so if that URL denies being the product, the
data points at a page that contradicts it. Geoffy refuses to publish in that state rather
than emit it.

---

## Prove you own your domain

Enter your site address as a **bare host name** — `storefront.example`. A scheme, a trailing
slash and a trailing dot are cleaned up for you; a port, an `@`, or anything that is not a
host name is refused, because that value is published verbatim inside your structured data
and it has to name your site and nothing else.

Geoffy gives you a verification token. Serve it at:

```
https://yourdomain.com/.well-known/geoffy-site-verification.txt
```

**Next.js** — put the file at `public/.well-known/geoffy-site-verification.txt`.

**Astro** — put it at `public/.well-known/geoffy-site-verification.txt`.

Then run the check in Geoffy. Until it passes, every artifact endpoint returns 404 and
nothing publishes. This is deliberate: without it, anyone who can type a domain name into a
form could have Geoffy host content attributed to it.

**This check runs in the opposite direction to everything else in this guide** — Geoffy
fetches your site, rather than your site fetching Geoffy. So it needs an address Geoffy can
actually reach: **https, on the default port, on a public host name.** A local address is
refused rather than attempted. If you are building this on your own machine, read
"Testing locally before you publish live" before you enter an address.

---

## Next.js (App Router)

### 1. Environment

```bash
GEOFFY_SITE_KEY=hs_live_...            # from Geoffy settings; public, safe in a build
GEOFFY_ORIGIN=https://api.geoffy.ai    # optional; this is the default, leave it unset
```

`GEOFFY_ORIGIN` points the whole build at a different Geoffy instance without passing
`origin` to every component and route below. Leave it out unless you have
been told to set it, or unless you are following "Testing locally before you publish live",
which is the usual reason to set one. A value that is not an absolute `http`/`https` URL is
ignored and the default is used, so a typo cannot break your page.

```bash
GEOFFY_REVALIDATE_SECRET=geoffy_rvs_... # optional; see step 4
```

**Copy this one out of Geoffy — do not invent it.** Your site's settings page shows it under
**Faster updates**, already generated. It is what lets your route tell our calls from anyone
else's.

### 2. The product page

```tsx
// app/[lang]/products/[handle]/page.tsx
import { GeoffyProduct } from "@geoffy/headless/next";

export default async function ProductPage({ params }) {
  const { lang, handle } = await params;

  return (
    <>
      <YourProductUI handle={handle} />

      {/* Renders the widget and the structured data together, right here.
          Renders nothing when Geoffy has nothing published or is unreachable. */}
      <GeoffyProduct
        siteKey={process.env.GEOFFY_SITE_KEY!}
        handle={handle}
        canonicalUrl={`https://yourdomain.com/${lang}/products/${handle}`}
      />
    </>
  );
}
```

Put it where you want the **widget** to appear. The structured data is emitted immediately
beside it — React does not hoist an inline `<script>` — so both end up in the body. That is
valid and it verifies; see [Where to put the markup](#where-to-put-the-markup) for why the
pair is not separable here.

`canonicalUrl` is **this page's own canonical** — the value you already build for
`generateMetadata`, so pass the same one rather than a second copy of the logic.

It is optional and worth passing. Geoffy publishes against one canonical URL per product, and
this component renders wherever you mount it — so on a page that is not that URL it renders
another page's content. Pass this and it renders nothing there instead, leaving an inert
`data-geoffy-skipped` marker so a bare page can be diagnosed from view-source.

Only the path is compared, not the whole URL. Your site key already names your site, so
comparing origins would add nothing and would blank a correct page while you develop against
`localhost`.

The file path above is an example, not a requirement. Your product route can be as deep as
you like — nothing in this package reads the URL, because you pass `handle` explicitly.

**What `handle` must be** depends on which kind of site you are:

- **Shopify behind your storefront** — the Shopify product handle, the same value you
  already query the Storefront API with.
- **No commerce platform** — the segment your product URL pattern captured. Geoffy shows you
  the handle it recorded next to each crawled product, so you can copy it rather than guess.

#### If your site serves more than one language

Geoffy publishes against **one canonical URL per product**. That is the URL your product page
names in its `<link rel="canonical">`, and it is the URL the structured data claims to
describe.

So Geoffy has content for **one locale of each product**, and mounting `<GeoffyProduct>` on
every locale is the tempting mistake: the other locales render the canonical locale's widget
and a structured-data node in the canonical locale's language, under a page written in another
one. Nothing errors; the page simply makes a claim in the wrong language.

**Pass `canonicalUrl` and you do not have to be careful about it.** Mount the component on
every locale if that is simpler for you — it renders only on the page Geoffy published against
and does nothing on the rest. That is why the argument is worth the line.

If you want Geoffy on every locale today, the way to get it is one Geoffy site per locale —
each with its own address, its own ownership check and its own catalogue. That works now, and
it costs what it sounds like: a separate crawl and a separate publish for each. Per-locale
content under a single site is not something this package can do yet. Tell us if you need it.

### 3. The site-wide files

One file each, three lines each:

```ts
// app/llms.txt/route.ts
import { createGeoffyTextRoute } from "@geoffy/headless/next";
export const GET = createGeoffyTextRoute({ siteKey: process.env.GEOFFY_SITE_KEY! }, "llms.txt");
```

```ts
// app/llms-full.txt/route.ts
import { createGeoffyTextRoute } from "@geoffy/headless/next";
export const GET = createGeoffyTextRoute({ siteKey: process.env.GEOFFY_SITE_KEY! }, "llms-full.txt");
```

```ts
// app/agents.md/route.ts
import { createGeoffyTextRoute } from "@geoffy/headless/next";
export const GET = createGeoffyTextRoute({ siteKey: process.env.GEOFFY_SITE_KEY! }, "agents.md");
```

> **Why route handlers and not a rewrite in `next.config.js`.** A rewrite works, but it must
> be in the `beforeFiles` array. If your app has a catch-all segment such as `app/[lang]`, a
> rewrite registered anywhere else loses to it — and the catch-all answers `/llms.txt` with
> your home page and HTTP **200**, which a crawler reads as a successful answer rather than
> a missing file. Route handlers cannot lose that race.

### 4. How updates reach your page

Nothing to build here — this step is one you read.

When you publish in Geoffy, your page picks the change up on its own within the **revalidate
window**, which is one hour by default and is set by `revalidateSeconds` on the options object
of the routes below. Your page is never permanently stale, and there is nothing that can be
lost or misconfigured to make it so. That is the whole design: self-healing by default.

**Optional: make it seconds instead.** Mount the revalidate route, and we call it the moment
you publish.

```ts
// app/api/geoffy/revalidate/route.ts   ← this exact path
import { revalidateTag } from "next/cache";
import { createGeoffyRevalidateRoute } from "@geoffy/headless/next";

export const POST = createGeoffyRevalidateRoute({
  secret: process.env.GEOFFY_REVALIDATE_SECRET!,
  revalidateTag,
});
```

**The path is fixed, and that is the whole configuration.** We call
`https://<your public domain>/api/geoffy/revalidate` — built from the domain you already proved
you own — so there is no address to enter anywhere and no way to enter it wrongly. Mount the
route at that path and it works; mount it elsewhere and nothing calls it.

Then set `GEOFFY_REVALIDATE_SECRET` in your environment to the value shown under **Faster
updates** in your site's settings, and redeploy. Both values on that panel are there to be
copied — the address so you know where to mount, the secret so your route can verify us.

**We never send the secret.** The request carries `x-geoffy-signature`, an HMAC of the body,
which the route above verifies for you in constant time. A raw secret could be replayed, and a
redirect on your endpoint would forward it to a third origin. Signing the body also means a
captured header cannot be reused for a different product.

**Rotating it.** **Generate a new secret** on the same panel replaces it immediately, so update
your environment and redeploy before you publish again — until you do, we sign with the new one
and your route rejects the call. Nothing else breaks: your pages keep refreshing within the
window.

Skipping this is a real option, not a degraded one. Your pages still refresh within the window,
and a failed call is logged and ignored rather than failing the publish.

### 5. The Geoffy namespace — one route, once

Geoffy has more surfaces than the three files above: a plain-text twin for every product, a
sitemap of them, and your buying-guide pages. They all live under one namespace, and this
single catch-all route puts the whole of it on your domain:

```ts
// app/apps/geoffy/[...path]/route.ts
import { createGeoffyProxyRoute } from "@geoffy/headless/next";

export const GET = createGeoffyProxyRoute({ siteKey: process.env.GEOFFY_SITE_KEY! });
```

The freshness window is `revalidateSeconds` on the options object — `createGeoffyProxyRoute({ siteKey, revalidateSeconds: 3600 })`. It is **not** a route-segment `export const revalidate`: this handler reads the request URL, which makes the route dynamic, so that export has no cached response to govern.

That is it. You now serve:

```
https://yourdomain.com/apps/geoffy/llm/{handle}.md      each product, as plain text
https://yourdomain.com/apps/geoffy/guides/{slug}        each published buying guide
https://yourdomain.com/apps/geoffy/guides/{slug}.md     the same guide, as plain text
https://yourdomain.com/apps/geoffy/sitemap.xml          all of the above, listed
```

**Why this is worth a route.** Without it, that content is still served — from
`api.geoffy.ai`, not from you. An AI system that reads your buying guide there records
*api.geoffy.ai* as the source, so the citation your guide earns goes to us instead of to you.
The point of the route is that everything about your products is addressed at your own domain.

**Why a namespace and not three more helpers.** It is the last integration change this package
will ask you for. Anything Geoffy adds later appears under the namespace you have already
mounted — no upgrade, no new file, no re-deploy on your side.

`apps` and `geoffy` are ordinary static route segments, so this wins against a catch-all such
as `app/[lang]` with no configuration. That is the reverse of the rewrite problem described
above: rewrites lose that race, route segments win it.

Until you add this route, Geoffy notices and simply says less — your `llms.txt` will not
advertise the twins or the sitemap, rather than pointing a crawler at pages that are not
there. Nothing breaks; you get less.

> **The mount path is fixed at `/apps/geoffy`.** Geoffy probes that exact path to confirm your
> integration and publishes twin URLs built from the same literal, so a mount somewhere else
> would be probed where you do not serve and reported as never mounted. If `/apps/*` is
> genuinely taken in your app, get in touch before you integrate.

**Two behaviours worth knowing**, because they show up in your own logs. If Geoffy is
unreachable, rate-limiting, or erroring, this route answers **503** with a `Retry-After` —
never a fabricated 404, so a crawler retries instead of dropping the page from its index. And
query strings are not forwarded, because no artifact reads one.

### 6. Crawler rules

Merge the Geoffy lines into your existing `robots.txt`. Do not replace your file — yours
contains your own rules.

Serve `robots.txt` from a **route handler**, so your file is text you control:

```ts
// app/robots.txt/route.ts
import { fetchGeoffyText } from "@geoffy/headless";

const YOUR_RULES = `User-Agent: *
Disallow: /admin
`;

const YOUR_GLOBAL_RECORDS = `Host: https://yourdomain.com
Sitemap: https://yourdomain.com/sitemap.xml
`;

export async function GET() {
  const geoffyRules = await fetchGeoffyText(
    { siteKey: process.env.GEOFFY_SITE_KEY! },
    "robots-rules.txt",
  );

  // `null` means Geoffy was unreachable. Serve YOUR rules anyway — dropping your own
  // disallows because our API had a bad minute is the worse failure.
  const body = [YOUR_RULES, geoffyRules ?? "", YOUR_GLOBAL_RECORDS]
    .filter(Boolean)
    .join("\n");

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
    },
  });
}
```

If you already have an `app/robots.ts`, **delete it** when you add this — two files cannot
both answer `/robots.txt`.

> **Why not `app/robots.ts`, the typed metadata convention.** It cannot carry what we send.
> That file must return a `MetadataRoute.Robots` **object**, and what we serve is robots.txt
> **text**; there is no string field to append it to. Parsing our text into rule objects loses
> two things that matter: the `# BEGIN Geoffy` / `# END Geoffy` comments, which are how the
> block stays identifiable and removable — the typed API cannot express a comment at all — and
> any directive we add later that the type does not model, which would be dropped in silence.
> The route handler passes our bytes through unchanged, which is the only version of this that
> stays correct without you re-reading this guide.

**What is in the block, and why you append it rather than merge it by hand:**

- It carries no `User-agent: *` group. Yours stays the only global policy, so appending can
  never override the disallows you wrote.
- It is bracketed by `# BEGIN Geoffy reference engineering` / `# END Geoffy reference
  engineering`. If you ever paste it in statically instead of fetching it, replace everything
  between those markers on an update — never merge line by line.
- Once your `/apps/geoffy` route is live (step 5), the block ends with a `Sitemap:` line
  pointing at the Geoffy sitemap **on your own domain**. That line is what makes the guides and
  the plain-text product twins reachable to Googlebot and Bingbot, which read robots.txt and do
  not read `llms.txt`. Before the namespace is mounted the line is withheld, because until then
  the URL it would name does not answer.

**Where the block goes matters.** `robots.txt` has two kinds of record and they are not
interchangeable. A **group** is a `User-agent:` line plus the rules under it, and a group must
stay contiguous — a rule separated from its `User-agent:` by an unrelated line belongs to
nothing. A **global record** — `Host:`, `Sitemap:` — applies to the whole file wherever it
sits.

Our block contains a group. So it belongs **with the other groups**, and your own global
records go **last**:

```
User-Agent: *            ← your groups
Disallow: /admin

# BEGIN Geoffy …         ← our block, including its own Sitemap: line
User-agent: Bytespider
…
# END Geoffy …

Host: https://yourdomain.com    ← your global records, at the end
Sitemap: https://yourdomain.com/sitemap.xml
```

Appending our block after your own `Host:` and `Sitemap:` lines produces a file that still
parses, but not the way you meant it to.

**It is cached for an hour, and that will confuse you at least once.** `fetchGeoffyText` caches
under the tag `geoffy:root-files` with `revalidateSeconds` (3600 by default), so a change on the
Geoffy side — mounting the namespace, publishing your first guide — does not reach your
robots.txt until the window turns over. Wiring up step 4 purges the tag and makes it seconds
instead; without it, the window is the only refresh. While you are integrating, pass a short
one:

```ts
await fetchGeoffyText({ siteKey, revalidateSeconds: 10 }, "robots-rules.txt");
```

If your robots.txt looks stale in `next dev` after you already fixed something, it is this — not
your route.

---

## Astro

### 1. Environment

```bash
GEOFFY_SITE_KEY=hs_live_...            # from Geoffy settings; public, safe in a build
GEOFFY_ORIGIN=https://api.geoffy.ai    # optional; this is the default, leave it unset
```

`GEOFFY_SITE_KEY` is read by your own code as `import.meta.env.GEOFFY_SITE_KEY` and passed
in below. `GEOFFY_ORIGIN` is different: Geoffy reads it itself, from `process.env`. That is
available server-side under the Node adapter, which is where these helpers run. If your
adapter has no `process` — an edge runtime — the variable is ignored, with no error, and
you point at another instance by passing `origin` alongside `siteKey` instead. As in
Next.js, a value that is not an absolute `http`/`https` URL is ignored and the default is
used. The usual reason to set it is "Testing locally before you publish live", below.

### 2. The product page

```astro
---
// src/pages/[lang]/products/[handle].astro
import { getGeoffyProductMarkup } from "@geoffy/headless/astro";

const { lang, handle } = Astro.params;
const geoffy = await getGeoffyProductMarkup(
  { siteKey: import.meta.env.GEOFFY_SITE_KEY },
  handle,
  { canonicalUrl: `https://yourdomain.com/${lang}/products/${handle}` },
);
---

<Layout>
  {geoffy && <Fragment set:html={geoffy.jsonLdScript} slot="head" />}

  <YourProductUI handle={handle} />

  {geoffy && <div data-geoffy-widget set:html={geoffy.widgetHtml} />}
</Layout>
```

This is the split shape point 2 of [Where to put the markup](#where-to-put-the-markup)
prefers: the structured data goes to the `<head>`, the widget goes wherever you want it seen.

`slot="head"` only reaches the head if your `Layout.astro` declares `<slot name="head" />`
inside its `<head>`. If it does not, the fragment falls into the body instead — which still
verifies and is still read, so this is worth getting right but is not worth blocking on.

The file path is an example; your route can be any shape, because you pass `handle`
explicitly. What `handle` must contain, and what to do if your site serves more than one
language, are the same as in the Next.js section above — read "The product page" there.

`canonicalUrl` behaves the same way, with one difference: a page that is not the one Geoffy
published against gets `null` back, so the `{geoffy && …}` guards you already have render
nothing. There is no `data-geoffy-skipped` marker here — there is nowhere to put one without
changing the call shape above.

### 3. The site-wide files

```ts
// src/pages/llms.txt.ts
import { createGeoffyTextEndpoint } from "@geoffy/headless/astro";
export const GET = createGeoffyTextEndpoint(
  { siteKey: import.meta.env.GEOFFY_SITE_KEY },
  "llms.txt",
);
```

Repeat as `llms-full.txt.ts` and `agents.md.ts`. A real file under `src/pages/` beats a
dynamic route, so a catch-all such as `[...lang]` cannot swallow these.

### 4. How updates reach your page

Astro has no equivalent of Next's tag revalidation, so how your content updates depends on
how your site is built:

| Your build | When a publish shows up |
|---|---|
| Server-rendered (`output: "server"`, an adapter) | On the next request after the cached response expires — the fetch is cached for `revalidateSeconds`, one hour by default. |
| Fully static (`output: "static"`) | On your next build. Geoffy content is read at build time, so nothing changes until you rebuild. |

**There is nothing to speed this up, and that is deliberate.** Geoffy holds no credential of
yours that could spend your build minutes.

So the table above is the whole answer. A server-rendered Astro site picks a publish up when its
cache expires; a fully static one shows it at your next build, whenever that is.

The **Faster updates** panel in your site's settings applies to Next.js: it shows the address we
call and the secret we sign with, and this package ships the route for it
(`createGeoffyRevalidateRoute`) only for Next. Astro has no equivalent of `revalidateTag`, so
there is no handler to mount. If your adapter offers on-demand revalidation of its own, you can
write a `POST` handler at `/api/geoffy/revalidate` that verifies `x-geoffy-signature` against
that secret and calls it — but you are on your own for that half, and it is genuinely optional.

A fully static site is worth thinking about before you go further: it also cannot serve the
namespace route in step 5, and it will not show a publish until you rebuild for some other
reason. If your catalogue changes at all often, on-demand rendering is the shape that fits.

---

### 5. The Geoffy namespace — one route, once

The Astro twin of the Next route above, and the same reasoning applies: without it your
product twins, your buying guides and your Geoffy sitemap are served from `api.geoffy.ai`
rather than from you, and the citations they earn go to us.

```ts
// src/pages/apps/geoffy/[...path].ts
import { createGeoffyProxyEndpoint } from "@geoffy/headless/astro";

export const prerender = false;   // required — see below
export const GET = createGeoffyProxyEndpoint({ siteKey: import.meta.env.GEOFFY_SITE_KEY });
```

**`export const prerender = false` is not optional, and leaving it out breaks your build.**
This is a rest-parameter route, and a prerendered dynamic route with no `getStaticPaths()`
fails `astro build` outright. Astro 5 prerenders by default, so without that line your deploy
stops.

You also need on-demand rendering: an adapter and `output: "server"`, or the Astro 5 default
plus `prerender = false` here. A fully prerendered site cannot serve this route at all — do not
add the file, and your content stays reachable at Geoffy's own domain instead.

Until you add this, Geoffy says less rather than pointing crawlers at pages that are not there.

### 6. Crawler rules

The Astro twin of the Next.js step of the same name. **Read that one too** — everything it
says about the block applies here unchanged (no `User-agent: *` group, `# BEGIN`/`# END`
markers, and a `Sitemap:` line once the namespace is mounted), including where the block goes
in the file, which is the part that actually costs you something when you get it wrong.

`createGeoffyTextEndpoint` deliberately does not accept `robots-rules.txt`: it serves a whole
file, and this one is a fragment you append to yours.

```ts
// src/pages/robots.txt.ts
import type { APIRoute } from "astro";
import { fetchGeoffyText } from "@geoffy/headless";

const YOUR_RULES = `User-Agent: *
Disallow: /admin
`;

const YOUR_GLOBAL_RECORDS = `Host: https://yourdomain.com
Sitemap: https://yourdomain.com/sitemap.xml
`;

export const GET: APIRoute = async () => {
  const geoffyRules = await fetchGeoffyText(
    { siteKey: import.meta.env.GEOFFY_SITE_KEY },
    "robots-rules.txt",
  );

  // Your own rules survive an unreachable Geoffy. Never the other way round.
  const body = [YOUR_RULES, geoffyRules ?? "", YOUR_GLOBAL_RECORDS]
    .filter(Boolean)
    .join("\n");

  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
```

If you have a static `public/robots.txt`, delete it — a real file in `public/` wins, and your
rules would silently stay as they were.

On a prerendered site this runs at build time, so your `robots.txt` carries whatever we served
during that build. That is fine — the rules change rarely — but it does mean a change on our
side reaches you on your next build rather than within the hour.

On a fully static build this is evaluated once, at build time, so the `Sitemap:` line appears
in your deployed robots.txt only if the namespace was already mounted when you built. Mount
first, then deploy.

---

## Two things not to do

**Do not sanitise the widget HTML.** The widget's CSS travels inside it as a `<style>`
element. A sanitiser that strips `<style>` leaves the widget rendering unstyled on your live
site, and it looks like a design bug rather than an integration one.

**Do not move the structured data to a client script.** `next/script` with a client strategy
or an `onMount` injection will look correct in your browser and be invisible to every
crawler that does not run JavaScript — which is most of the ones this is for.

---

## Testing locally before you publish live

You do not have to deploy to find out whether this worked. Run your storefront on your own
machine and you can see the widget, the structured data, `llms.txt`, the namespace and your
merged `robots.txt` exactly as a crawler will see them — before any of it is on your live
site.

Be clear about what a local run proves, because it is not everything:

| Question | Answer it locally? |
|---|---|
| Does the widget render, server-side, on my product page? | **Yes** |
| Is the structured data in the HTML before JavaScript runs? | **Yes** |
| Do my new routes return the right bytes and content types? | **Yes** |
| Did my `robots.txt` merge land in the right place in the file? | **Yes** |
| Does Geoffy confirm my integration and mark products live? | **No** — see "What local cannot do" |

### Nothing to configure

Leave `GEOFFY_ORIGIN` unset. Your local build talks to production Geoffy over https, which
works from anywhere, and it reads exactly what your deployed site will read. The direction
that matters here — your build fetching Geoffy — has no localhost problem at all.

Set `GEOFFY_ORIGIN` only if we have given you a specific Geoffy instance to develop against.
It accepts a port, so `GEOFFY_ORIGIN=http://localhost:3000` is valid if you are running one
yourself.

### But verify your domain first

Artifacts are served only for a **verified** site. Until ownership passes, every artifact
endpoint returns 404, so a local run would render nothing and tell you nothing.

Verification goes the other way — Geoffy fetches your site — and it needs **https, on the
default port, on a public host name**. `localhost`, a private address and a custom port are
refused rather than attempted. So verify a public address once, then develop locally against
that same site key for as long as you like:

- **Your site is already live** (you are adding Geoffy to an existing storefront). Deploy the
  one verification file to `https://yourdomain.com/.well-known/geoffy-site-verification.txt`
  and run the check. Nothing else has to ship. This is the normal path and needs no tunnel.
- **Your site is not live yet.** Put a temporary public https address in front of your dev
  server:

  ```bash
  cloudflared tunnel --config /dev/null --url http://localhost:4321
  ```

  Enter the tunnel's host name as your site address, verify, and carry on. Swap it for your
  real domain before you go live — the address is published verbatim inside your structured
  data.

  `--config /dev/null` is not optional: any tunnel config already on that machine is loaded
  even when you pass `--url`, and a quick tunnel's random host name matches none of its rules,
  so every request comes back as an empty 404.

### Two previews, and they answer different questions

- **Geoffy's review step** shows you the content — what we read about a product and what we
  would publish for it — before you pay to publish anything.
- **A local run** shows you the integration — that the published content lands on your page,
  server-rendered, at the right URLs.

A local run can only show you content that is already **published**. Artifact endpoints serve
published bundles and 404 for everything else, so localhost is not a way to look at a draft.

### The dev cache will lie to you

These routes cache their fetch of Geoffy for
`revalidateSeconds` — one hour by default — and in Next.js 16 the dev cache is in
`.next/dev/cache`, not `.next/cache`. Clearing the one you expect changes nothing, which makes
the cache look innocent while it serves you an hour-old answer and you go looking for a bug in
Geoffy.

```bash
rm -rf .next/dev/cache && npm run dev
```

### What local cannot do

Geoffy confirms your integration by fetching your **live** product page at its canonical URL —
the public one, not your machine. So until the integration is deployed, products stay pending
with `code_not_added` no matter how correct everything looks locally. That is the check working
as intended: it reports what your visitors and the crawlers actually get.

Prove it locally with the `curl` in "Checking it worked" below, ship, and let the confirmation
follow.

---

## Checking it worked

Geoffy does not take your word for it. After you publish, we fetch your live product page
and look for our markup in the server-rendered HTML. A product stays **pending** until we
find it, and your dashboard count only ever shows products confirmed on your real site.

If it stays pending, the reason says which of these it is:

| Reason | What to fix |
|---|---|
| `code_not_added` | The component is not on the page, or it is rendering on the client |
| `stale_version` | Your cache is serving an older copy. It clears itself within the revalidate window — one hour by default |
| `canonical_broken` | The page does not name itself as canonical — see "Before you start" |

You can check the same thing yourself:

```bash
curl -s https://yourdomain.com/your/product/page | grep -c 'data-geoffy'
```

The same command works against your dev server while you are building — swap the host for
`http://localhost:PORT`. See "Testing locally before you publish live".

A number greater than zero means it is in the server-rendered HTML, which is what matters.
Viewing it in browser devtools does not prove this — devtools shows the page after
JavaScript has run.

### And the namespace

Geoffy checks the mount the same way — by fetching it, not by trusting the setting. Check it
yourself with:

```bash
curl -si https://yourdomain.com/apps/geoffy/sitemap.xml | head -20
```

A `200` on its own proves nothing: a catch-all route answers *every* path with your home page
and a 200. Geoffy checks that the response really is the Geoffy sitemap for **your** site, and
that it is served as XML rather than HTML.

If the mount does not pass, it is reported as not done and your `llms.txt` keeps quiet about the
surfaces behind it — rather than advertising URLs that answer with your home page.
