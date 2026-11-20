<!--
ClawRouter - Self-hosted AI gateway and control platform
https://github.com/iant89/ClawRouter
Copyright (C) 2026 Ian Thomas
SPDX-License-Identifier: AGPL-3.0-or-later
-->

## What and why

## Checks

- [ ] `bun run security:ci` passes locally (or `bun run check` for a change without code paths to security)
- [ ] New routes: authorization tests and `bun run security:matrix`
- [ ] Docs, roadmap ticks and `MEMORY.md` updated

## Security fix?

- [ ] Not a security fix
- [ ] A security fix: it adds a case to `tests/security/cases/` (registry and test) that fails without the fix (SEC-027)
