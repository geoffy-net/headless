# Releasing

## Local loop

```bash
bun install
bun run typecheck     # tsc --noEmit
bun run test          # builds first, then runs node --test against dist/
```

Tests import `../dist/client.js`, not `../src/client.ts`, on purpose: a test of `src/` stays
green when the source is correct but the *packaging* is broken, which is the failure a
consumer actually hits.

## Verify what a merchant actually receives

Never publish on a green build alone. Pack it and install it as a stranger would:

```bash
npm pack                              # writes geoffy-headless-<version>.tgz
tar -tzf geoffy-headless-*.tgz        # expect ONLY dist/, package.json, README.md, LICENSE
```

```bash
mkdir /tmp/probe && cd /tmp/probe && npm init -y && npm pkg set type=module
npm install <path-to>/geoffy-headless-*.tgz react@18
node --input-type=module -e '
  import { DEFAULT_GEOFFY_ORIGIN } from "@geoffy/headless";
  import { getGeoffyProductMarkup } from "@geoffy/headless/astro";
  import { GeoffyProduct } from "@geoffy/headless/next";
  console.log(DEFAULT_GEOFFY_ORIGIN, typeof getGeoffyProductMarkup, typeof GeoffyProduct);
'
```

That exercises the `exports` map, the build and the code together. A missing `files` entry or
a wrong export condition passes every other check and fails only here.

## Publish

Releases go out from CI via **trusted publishing (OIDC)**: npm mints a short-lived,
job-scoped credential from the token GitHub hands the workflow, so there is no long-lived
registry secret in this repo and nothing to rotate.

A trusted publisher can only be configured for a package that already exists, so the first
version is published by hand and every version after it ships from
`.github/workflows/publish.yml`.

### Every release

```bash
npm version <patch|minor|major>             # tags the commit; never hand-edit the version
git push --follow-tags                      # the tag fires .github/workflows/publish.yml
```

`prepublishOnly` runs `typecheck` then `test`, and the test script rebuilds — so a stale
`dist/` and a red suite both stop the publish. The workflow runs both again first, so a
failure never reaches the registry step at all.

Three things in the workflow that are easy to lose in an edit, all load-bearing:
`permissions: id-token: write` (no OIDC token without it), `npm install -g npm@latest`
(trusted publishing needs npm >= 11.5.1, newer than what any setup-node Node ships), and
Node 22 (>= 22.14 is the floor for the same feature).

`repository.url` in `package.json` must keep pointing at this repo — provenance cross-checks
it, and a mismatch fails the publish.

After a release, run the tarball probe above against the *published* package rather than a
local `.tgz`.

The published artifact deliberately contains no sourcemaps, and nothing outside `files`.
Check with `npm pack --dry-run` before every release; the expected list is `LICENSE`,
`README.md`, `package.json` and seven files under `dist/`.

## Compatibility

Node 18 is the floor: the package relies on global `fetch`, `AbortController` and
`crypto.subtle`. Output is ESM only — both target frameworks handle ESM in `node_modules`,
and a dual build would double the surface for no consumer we have. The Astro `process.env`
path applies to the Node adapter.
