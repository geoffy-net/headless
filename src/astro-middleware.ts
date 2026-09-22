/**
 * AI visit tracking for Astro — an `onRequest` middleware.
 *
 *   // src/middleware.ts
 *   import { createGeoffyAiVisitMiddleware } from "@geoffy/headless/astro-middleware";
 *   export const onRequest = createGeoffyAiVisitMiddleware({ siteKey: import.meta.env.GEOFFY_SITE_KEY });
 *
 * Already have one? Combine them with Astro's `sequence(geoffy, yours)`.
 *
 * It calls `next()` once and returns exactly the response `next()` produced. The report is
 * handed to the runtime's `waitUntil` where the adapter provides one (Cloudflare's
 * `locals.runtime.ctx`, or `context.waitUntil`); on a long-running Node server it is simply
 * started and not awaited.
 *
 * Only the server-rendered requests pass through middleware. A page Astro prerendered at build
 * time is served as a file and never reaches this code, so AI reads of prerendered pages are not
 * reported — mark the pages you want counted `prerender = false`, or accept the gap.
 */

import { type Defer, type GeoffyAiVisitOptions, trackAiVisit } from "./aiVisits";

export { AI_ASSISTANT_HOSTS } from "./aiVisits";
export { BUILT_IN_AI_AGENT_SIGNATURES } from "./aiAgents";

/** The subset of Astro's `APIContext` this reads. Declared here so Astro is not a dependency. */
export interface AstroMiddlewareContext {
  request: Request;
  clientAddress?: string;
  locals?: unknown;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface GeoffyAstroAiVisitOptions extends Omit<GeoffyAiVisitOptions, "clientIp"> {
  /**
   * The visitor's address, if your adapter gives you one you can trust — for example
   * `(request, context) => context.clientAddress` on an adapter that takes it from the socket
   * or from the platform's own header. Check what yours does before passing it: an adapter that
   * reads `X-Forwarded-For` hands you whatever the client chose to send.
   */
  clientIp?: (request: Request, context: AstroMiddlewareContext) => string | null | undefined;
}

export function createGeoffyAiVisitMiddleware(opts: GeoffyAstroAiVisitOptions) {
  return function onRequest<R>(context: AstroMiddlewareContext, next: () => R): R {
    try {
      const { clientIp, ...rest } = opts ?? ({} as GeoffyAstroAiVisitOptions);
      const core: GeoffyAiVisitOptions = {
        ...rest,
        ...(clientIp ? { clientIp: (request: Request) => clientIp(request, context) } : {}),
      };
      trackAiVisit(core, context.request, deferFor(context));
    } catch {
      // Tracking must never stand between the visitor and the page.
    }
    return next();
  };
}

function deferFor(context: AstroMiddlewareContext): Defer | undefined {
  const locals = context.locals as { runtime?: { ctx?: { waitUntil?: unknown } } } | undefined;
  const hook =
    typeof context.waitUntil === "function"
      ? context.waitUntil.bind(context)
      : typeof locals?.runtime?.ctx?.waitUntil === "function"
        ? (locals.runtime.ctx.waitUntil as (p: Promise<unknown>) => void).bind(locals.runtime.ctx)
        : undefined;
  return hook ? (task) => hook(task()) : undefined;
}
