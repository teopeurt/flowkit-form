# Local package overrides

The `@teopeurt/flowkit-*` packages are public on npmjs.org, so a normal checkout installs them with
`bun install --frozen-lockfile` and no registry configuration. Use an override only to try an
unreleased change from a [teopeurt/flowkit](https://github.com/teopeurt/flowkit) checkout.

## Temporary local-artifact testing

Use an isolated clone or temporary copy. Keep the working manifest and lockfile pinned to the
released version; do not commit `file:`, `link:`, `workspace:`, or local-registry URLs. In the
temporary copy, point the affected dependency at the sibling checkout (a `file:` path to the built
package), then run:

```sh
bun install
bun run typecheck
bun run test
bun run build
```

This is evidence for a local simulation only, not a released-package install.

## Restore the release configuration

Discard the temporary copy, or restore `package.json` and `bun.lock` from git. Then, from a fresh
archive, confirm the released packages install and pass:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
```

Do not modify framework source or `node_modules` to make a local override work. Preserve the
repository's six exact `@teopeurt/flowkit-*` version declarations and the boundary checks in
`test/package-contracts.preflight.test.ts` and `test/package-boundary.test.ts`.
