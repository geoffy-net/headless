/**
 * The one signature scheme between a merchant's site and Geoffy, in both directions.
 *
 * `x-geoffy-signature: sha256=<lowercase hex HMAC-SHA256(secret, raw body)>`. Geoffy signs the
 * purge calls it makes to the revalidate route; the AI visit middleware signs what it sends to
 * Geoffy. One implementation, so the two directions cannot drift apart.
 *
 * WebCrypto only, so this runs on Node and on an edge runtime alike — `node:crypto` is not
 * available on the latter.
 */

const encoder = new TextEncoder();

/** `sha256=<hex>` over the exact bytes of `body`. */
export async function signBody(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Compare a provided signature with the expected one in constant time.
 *
 * Both sides are digested before comparison, so the compare is over two fixed-length values
 * and leaks neither the secret's length nor an early-exit position.
 */
export async function signatureMatches(
  secret: string,
  body: string,
  provided: string,
): Promise<boolean> {
  const expected = await signBody(secret, body);
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  const av = new Uint8Array(a);
  const bv = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < av.length; i += 1) diff |= (av[i] ?? 0) ^ (bv[i] ?? 0);
  return diff === 0;
}
