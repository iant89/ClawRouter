# Vendored packages

## `enterprise-ui-react.tgz`

[ENTERPRISE-UI](https://github.com/iant89/ENTERPRISE-UI) (`@enterprise-ui/react`)
is not published to npm yet, so the console installs it from this tarball. It is
committed on purpose: a fresh clone needs only `bun install`.

| | |
|---|---|
| Package | `@enterprise-ui/react` 0.1.0 |
| Source | ENTERPRISE-UI `main` at `2ae975794ab10049e5c08d6be2cd73b86a6f436f` (pull request 54, the QrCode component) |
| Contents | the published files only (`dist/`, `README.md`), as `npm pack` produces them |

### Updating

From a local ENTERPRISE-UI checkout at the commit you want:

```bash
ENTERPRISE_UI_PATH=../ENTERPRISE-UI bun run ui:build   # builds the library and replaces the tarball
bun install                                             # refreshes bun.lock (the tarball's integrity hash)
bun run check
```

Then update the source commit above and commit the tarball, `bun.lock` and this
file together.

Once ENTERPRISE-UI is on npm, replace the `file:` dependency in
`apps/console/package.json` with a version range and delete this directory.
