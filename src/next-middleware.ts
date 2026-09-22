/**
 * AI visit tracking for Next.js — `proxy.ts` on Next 16, `middleware.ts` before it.
 *
 *   // proxy.ts (or middleware.ts)
 *   import { createGeoffyAiVisitMiddleware } from "@geoffy/headless/next-middleware";
 *   export const proxy = createGeoffyAiVisitMiddleware({ siteKey: process.env.GEOFFY_SITE_KEY! });
 *
 * It returns nothing, which Next reads as "carry on": your response is exactly the one you would
 * have served without it. If you already have a middleware, call it from yours and return your
 * own response as before:
 *
 *   const trackAiVisits = createGeoffyAiVisitMiddleware({ siteKey: process.env.GEOFFY_SITE_KEY! });
 *   export function middleware(request: NextRequest, event: NextFetchEvent) {
 *     trackAiVisits(request, event);
 *     return yourExistingLogic(request);
 *   }
 *
 * The report runs after the response, through `event.waitUntil`. Pass Next's `after` as
 * `defer` to use that instead.
 *
 * No import from `next` here, on purpose: the package must not depend on a particular Next
 * version's module layout, and nothing below needs more than the web `Request`.
 */

import { resetLearnedAiAgents } from "./aiAgents";
import { type Defer, type GeoffyAiVisitOptions, resetAiVisitBudgets, trackAiVisit } from "./aiVisits";

export type { GeoffyAiVisitOptions } from "./aiVisits";
export { AI_ASSISTANT_HOSTS } from "./aiVisits";
export { BUILT_IN_AI_AGENT_SIGNATURES } from "./aiAgents";

export interface GeoffyNextAiVisitOptions extends GeoffyAiVisitOptions {
  /** Next's `after` (from `next/server`), if you prefer it to `event.waitUntil`. */
  defer?: Defer;
}

/** The subset of Next's `NextFetchEvent` this needs. */
export interface WaitUntilEvent {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * A middleware that reports AI visits and otherwise does nothing.
 *
 * Returns `undefined` for every request, synchronously, and never throws.
 */
export function createGeoffyAiVisitMiddleware(opts: GeoffyNextAiVisitOptions) {
  return function geoffyAiVisits(request: Request, event?: WaitUntilEvent): undefined {
    let defer: Defer | undefined = opts?.defer;
    if (!defer && event && typeof event.waitUntil === "function") {
      defer = (task) => event.waitUntil(task());
    }
    trackAiVisit(opts, request, defer);
    return undefined;
  };
}

/** Test seam: forget every agent list read from Geoffy, and every report budget. */
export function __resetGeoffyAiVisits(): void {
  resetLearnedAiAgents();
  resetAiVisitBudgets();
}
