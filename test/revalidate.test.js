/**
 * The revalidate route Geoffy calls after a publish.
 *
 * Like its siblings, this runs against `dist/` so it exercises the exports map and the build
 * as well as the logic.
 *
 * The theme is that this route is a webhook, not a Server Action. Next 16's `revalidateTag`
 * takes a cache-life profile saying how long STALE content may still be served while the
 * revalidation runs behind it, and the recommended `"max"` would serve the pre-publish page to
 * the first visitor — the exact delay this route exists to remove. So every purge here has to
 * carry `{ expire: 0 }`, and that is asserted per call rather than over the set of calls: a
 * route that purges the right three tags and profiles only one of them is the failure this
 * suite is for, and it is invisible in an assertion that merely counts tags.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GEOFFY_NAMESPACE_TAG } from "../dist/client.js";
import { createGeoffyRevalidateRoute } from "../dist/next.js";

const SECRET = "shh-test-secret";

async function sign(secret, body) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function spyRoute({ secret = SECRET } = {}) {
  const calls = [];
  const POST = createGeoffyRevalidateRoute({
    secret,
    revalidateTag: (tag, profile) => {
      calls.push({ tag, profile });
    },
  });
  return { POST, calls };
}

async function post(POST, body, { signature } = {}) {
  return POST(
    new Request("https://shop.example/api/geoffy/revalidate", {
      method: "POST",
      headers: { "x-geoffy-signature": signature ?? (await sign(SECRET, body)) },
      body,
    }),
  );
}

describe("createGeoffyRevalidateRoute", () => {
  it("purges the product, the root files and the namespace for a product publish", async () => {
    const { POST, calls } = spyRoute();
    const res = await post(POST, JSON.stringify({ handle: "blue-widget" }));

    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => c.tag),
      ["geoffy:product:blue-widget", "geoffy:root-files", GEOFFY_NAMESPACE_TAG],
    );
  });

  it("purges the namespace alone for a guide publish, which names no product", async () => {
    const { POST, calls } = spyRoute();
    const res = await post(POST, JSON.stringify({ scope: "namespace" }));

    assert.equal(res.status, 200);
    assert.deepEqual(
      calls.map((c) => c.tag),
      [GEOFFY_NAMESPACE_TAG],
    );
  });

  it("expires every purge immediately, so the next request is not served the pre-publish page", async () => {
    const { POST, calls } = spyRoute();
    await post(POST, JSON.stringify({ handle: "blue-widget" }));

    // Guard the guard: an empty call list would satisfy the per-call assertion below.
    assert.ok(calls.length > 0, "no tag was purged at all");
    for (const call of calls) {
      assert.deepEqual(call.profile, { expire: 0 }, `${call.tag} was purged without an immediate expiry`);
    }
  });

  it("rejects a forged signature before purging anything", async () => {
    const { POST, calls } = spyRoute();
    const res = await post(POST, JSON.stringify({ handle: "blue-widget" }), { signature: "sha256=deadbeef" });

    assert.equal(res.status, 401);
    assert.deepEqual(calls, []);
  });

  it("rejects a body that names neither a product nor the namespace", async () => {
    const { POST, calls } = spyRoute();
    const res = await post(POST, JSON.stringify({ scope: "everything" }));

    assert.equal(res.status, 400);
    assert.deepEqual(calls, []);
  });
});
