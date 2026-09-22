import { defineConfig } from "tsup";

// One entry per consumer with different needs: the framework-agnostic client, the Next server
// components, the Astro helpers, and the two optional AI-visit middlewares. Keeping them
// separate means an Astro site never pulls React into its graph, and a site that does not add
// the middleware never loads it. Shared code lands in `chunk-*.js` files beside the entries.
export default defineConfig({
  entry: [
    "src/client.ts",
    "src/next.tsx",
    "src/astro.ts",
    "src/next-middleware.ts",
    "src/astro-middleware.ts",
  ],
  format: ["esm"],
  dts: true,
  // No sourcemaps in the published tarball: they embed `sourcesContent`, i.e. the entire
  // TypeScript source. A merchant debugging their storefront does not need it, and the
  // `.d.ts` files carry the documentation that does help.
  sourcemap: false,
  clean: true,
  treeshake: true,
  // Node 18 is the floor: the package relies on global fetch, AbortController and
  // crypto.subtle, none of which exist as globals before it.
  target: "node18",
  external: ["react", "react/jsx-runtime", "next"],
});
