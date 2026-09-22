/**
 * The warning for a missing site key or argument is printed once per process, not once per
 * render — a catalogue build renders thousands of pages, and a warning per page would bury the
 * rest of the build log. `node --test` runs each file in its own process, so this file starts
 * with no warning printed yet.
 */
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { fetchGeoffyProduct, fetchGeoffyText, handleGeoffyProxy } from "../dist/client.js";

const realFetch = globalThis.fetch;
const realWarn = console.warn;
after(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
});

it("warns once for a missing site key, and once for a missing handle or file", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response("", { status: 404 });
  };
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));

  for (let i = 0; i < 3; i += 1) {
    await fetchGeoffyProduct({ siteKey: undefined }, "blue-widget");
    await fetchGeoffyText({ siteKey: "" }, "llms.txt");
    await handleGeoffyProxy(
      { siteKey: undefined },
      new Request("https://storefront.example/apps/geoffy/sitemap.xml"),
    );
  }
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /GEOFFY_SITE_KEY is not set/);

  for (let i = 0; i < 3; i += 1) {
    await fetchGeoffyProduct({ siteKey: "sk" }, undefined);
    await fetchGeoffyText({ siteKey: "sk" }, {});
  }
  assert.equal(warnings.length, 2, warnings.join("\n"));
  assert.match(warnings[1], /handle or file/);
  assert.equal(calls.length, 0, calls.join(", "));
});
