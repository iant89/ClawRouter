# Vendored packages

## `enterprise-ui-react.tgz`

[ENTERPRISE-UI](https://github.com/iant89/ENTERPRISE-UI) (`@enterprise-ui/react`)
is not published to npm yet, so the console installs it from this tarball. It is
committed on purpose: a fresh clone needs only `bun install`.

| | |
|---|---|
| Package | `@enterprise-ui/react` 0.1.0 |
| Source | ENTERPRISE-UI branch `claude/clawapi-design-spec-p0hucn` at `66dfdb37f0e113e0863a29dfa0e19a17c1c1b5c9`: `main` (`83e4097`) plus FieldHelp, EmojiPicker, StatusHistory, ErrorBoundary and CopyButton `iconOnly` (moved from ClawRouter); not yet merged into ENTERPRISE-UI `main`. Re-vendor from `main` once it is |
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
