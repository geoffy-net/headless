/**
 * The one check every entry point runs before it builds an upstream URL.
 *
 * The likeliest misconfiguration is an unset `GEOFFY_SITE_KEY`. It arrives as `undefined`, and
 * a URL built from it asks Geoffy for `/headless/undefined/...`. A handle that is not a string
 * does the same one segment later (`/products/[object Object]`). Geoffy answers 404, every
 * helper turns that into "no content", and the page renders without Geoffy with nothing
 * anywhere saying why. So a missing value is refused here, before any request, and said out
 * loud once.
 *
 * Kept out of `client.ts` on purpose: every export of that module is part of the package's
 * public `.` entry, and this is not an API. The build puts it in the chunk the three entries
 * share, so the "warned already" state is one per process, not one per entry.
 *
 * Never throws. A merchant's page must render the same with a misconfigured Geoffy as without
 * Geoffy at all.
 */

const warned = new Set<"site-key" | "argument">();

function warnOnce(reason: "site-key" | "argument", message: string): void {
  if (warned.has(reason)) return;
  warned.add(reason);
  // Merchant-side package code: the console is the channel a merchant's build log reads.
  try {
    console.warn(message);
  } catch {
    // A console that throws must not take the page with it.
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * `true` when `siteKey` — and every value in `segments`, when given — is a non-empty string,
 * so a URL may be built from them. `false` means: make no request and return "no content".
 */
export function canRequest(siteKey: unknown, ...segments: unknown[]): boolean {
  if (!isNonEmptyString(siteKey)) {
    warnOnce(
      "site-key",
      "@geoffy/headless: GEOFFY_SITE_KEY is not set, so Geoffy content is skipped. " +
        "Set it to the site key from your Geoffy settings.",
    );
    return false;
  }
  if (!segments.every(isNonEmptyString)) {
    warnOnce(
      "argument",
      "@geoffy/headless: a product handle or file name was missing or not a string, so " +
        "Geoffy content is skipped for it. Pass the handle your product route already has.",
    );
    return false;
  }
  return true;
}
