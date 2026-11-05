# Local package overrides

## Pre-publication status

All six FlowKit dependencies request private GitHub Packages at `0.2.0`, but `0.2.0` is not
published yet. GitHub Package authentication is necessary once artifacts exist, but it cannot make
`bun install --frozen-lockfile` succeed in a clean archive today. That gate is deferred until the
private version is published. Local registry content and local tarballs are validation artifacts,
not released packages.

## Temporary local-artifact testing

Use an isolated clone or temporary copy. Keep the working starter manifest and lockfile pinned to
`0.2.0`; do not commit `file:`, `link:`, `workspace:`, or local-registry URLs. If you have a local
registry that serves the exact artifacts, configure only that temporary copy's `.npmrc` to point the
`@naakwu` scope at it, then run:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

This is evidence for a local-artifact simulation only. It is not a successful authenticated GitHub
Packages clean-clone install.

## Restore the release configuration

Discard the temporary copy or restore its `.npmrc` from `.npmrc.example`. In the real repository,
retain:

```text
@naakwu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
always-auth=true
```

Then, after private `0.2.0` packages are published and an authorized token is present, run from a
fresh archive:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

Do not modify framework source or `node_modules` to make a local override work. Preserve the
repository's six exact `@naakwu/flowkit-*` version declarations and the boundary checks in
`test/package-contracts.preflight.test.ts` and `test/package-boundary.test.ts`.
