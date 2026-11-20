# Security regression corpus

`tests/security/cases/` (SEC-027): every vulnerability found in ClawRouter, kept as a test that
fails without its fix, plus an attack case for every class the security roadmap names. The list
is [`registry.ts`](registry.ts); each class has one file, `<class>.test.ts`, and every test in it
starts with its case id (`CASE-012: ...`). [`corpus.test.ts`](corpus.test.ts) keeps that shape.

## The rule

```
vulnerability found → fix it → add the case → merge the fix only together with the case → the case stays
```

1. Fix the vulnerability on a branch (for one reported privately, see the advisory process once
   SEC-051 exists; until then, do not describe it in a public issue).
2. Add a case: the next free `CASE-NNN` in `registry.ts` with `origin: found(date, how it was
   found, what fixed it)`, and its test in the class file. The test must fail without the fix:
   check by undoing the fix once.
3. The pull request carries both (its template asks). CI runs the corpus in the security stage,
   where no security test may be skipped.
4. Never delete a case or reuse its id. If the code it tests is removed, keep the case testing
   that the attack still fails against what replaced it.

A case can also guard something that was never vulnerable (`origin: attack`): add one when a
class gets a new attack technique, so it is never possible later.

## Classes

ssrf, csrf, xss, path-traversal, authorization-bypass, session-fixation, api-key-leakage,
secret-leakage, mcp-privilege-escalation, request-smuggling, http-desync, dns-rebinding,
denial-of-service, configuration-injection, backup-restore, websocket-authorization,
provider-credential-leakage. `raw-http.ts` is the byte-level HTTP client of the smuggling and
desync cases (a real Bun server in front of the harness).

The deeper tests of each area stay in their own folders (`../ssrf/`, `../csrf/`, ...); the corpus
is the short list of what must never regress.
