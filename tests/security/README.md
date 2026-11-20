# Security regression suite

`tests/security/` (SEC-012) holds the tests that describe ClawRouter's security
boundaries from an attacker's point of view. Functional tests stay next to their
package; a test belongs here when it says "this attack must keep failing".

```bash
bun run test:security      # this folder only (also part of bun test / bun run check)
bun run security:matrix    # regenerate the authorization matrix after a reviewed access change
```

| Folder | What it guards |
|---|---|
| `authentication/` | sign-in: no username enumeration, lockout, disabled accounts, setup-token replay, passwords never stored or logged |
| `authorization/` | the authorization matrix (SEC-014): `matrix.json` and `docs/security/authorization-matrix.md` match the code, and every route is called as every principal |
| `sessions/` | cookie attributes, fixation, replay after sign-out, idle and absolute expiry, revocation |
| `csrf/` | cross-site origins, `Sec-Fetch-Site`, the CSRF header, form encodings, no CORS |
| `api-keys/` | secrets shown once and stored hashed; revoked, expired, suspended keys; keys never open the console |
| `rate-limits/` | key guessing per address, limits whatever header carries the key, `X-Forwarded-For` spoofing |
| `mcp/` | `/v1/mcp` as its own boundary (SEC-002) |
| `ssrf/` | hostile provider URLs, DNS rebinding, redirects, metadata addresses (SEC-001, SEC-008) |
| `backup/` | credential backups kept apart (SEC-011) |
| `restore/` | hostile backups (SEC-003) |
| `logging/` | secret scrubbing everywhere (SEC-010) |
| `websocket/` | the live channel over a real socket (SEC-015) |
| `provider/` | provider keys write-only, never sent to a new host; provider answers untrusted |
| `configuration/` | hostile configuration imports |

Rules:

- Every security fix adds a test here that fails without the fix.
- A new category needs a folder and an entry in `CATEGORIES` (`suite.test.ts`
  fails otherwise); a new kind of secret goes into `logging/secret-scrubbing.test.ts`.
- Tests never reach the internet: use the harness and the mock providers
  (`tests/support/`), as everywhere else.
- Shared setup is in `support.ts`.
