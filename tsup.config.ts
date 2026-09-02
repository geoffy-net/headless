import { defineConfig } from "tsup";

// Three entries because the package has three consumers with different needs: the
// framework-agnostic client, the Next server components, and the Astro helpers. Keeping
// them separate means an Astro site never pulls React into its graph.
export default defineConfig({
  entry: ["src/client.ts", "src/next.tsx", "src/astro.ts"],
  format: ["esm"],
  dts: true,
  // No sourcemaps in the published tarball. They ship `sourcesContent`, i.e. the entire
  // TypeScript source, and these files are dense with internal engineering context —
  // ticket IDs, our dev origin, and post-mortems of defects we have since fixed. None of
  // it is exploitable and none of it helps a merchant debug their storefront, so it does
  // not belong on a public registry. The `.d.ts` files carry the documentation that does.
  sourcemap: false,
  clean: true,
  treeshake: true,
  // Node 18 is the floor: the package relies on global fetch, AbortController and
  // crypto.subtle, none of which exist as globals before it.
  target: "node18",
  external: ["react", "react/jsx-runtime", "next"],
});
