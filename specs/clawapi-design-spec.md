# ClawAPI — AI Model Gateway & Control Platform

Design Specification + Roadmap. This is the authoritative product and architecture
spec. Section numbers are referenced from code comments and docs (e.g. "spec §25").
Implementation status is tracked in [`../docs/roadmap-status.md`](../docs/roadmap-status.md).

```
STATUS
------
Implementation: FROM SCRATCH
Product Type:   AI API Gateway + Provider/Model Router + Admin Platform
Runtime:        Bun
Language:       TypeScript
Frontend:       React + TypeScript
UI Framework:   ENTERPRISE-UI
Database:       SQLite
Transport:      HTTP/REST + WebSocket
Authentication: Server-side Sessions
Authorization:  RBAC
```

**Important.** This implementation IS the new ClawAPI. There is no ClawAPI
integration layer, adapter, wrapper, or dependency on another ClawAPI
implementation. The system owns: API gateway, authentication, authorization,
provider management, model registry, model routing, failover, rate limiting,
request execution, streaming, usage tracking, health monitoring, logging, audit,
administration and the web administration console. The Admin Console is simply
another interface into the same application.

---

## 1. Product vision

ClawAPI is a self-hosted AI gateway and control platform designed to sit between
applications/users and one or more AI model providers.

```
    +-------------------+
    |   AI CLIENTS      |   Applications, CLI tools, agents, internal services
    +---------+---------+
              | HTTP / HTTPS
              v
    +------------------------------------------------------+
    |                     CLAWAPI                          |
    |  API GATEWAY      Authentication, Authorization,     |
    |                   Validation, Rate Limiting,         |
    |                   Request Management, Streaming      |
    |  ROUTING ENGINE   Capability matching, Model         |
    |                   selection, Provider priority,      |
    |                   Weighted routing, Failover, Retry  |
    |  PROVIDER ENGINE  OpenAI, Anthropic, Google, Local,  |
    |                   Future providers                   |
    |  ADMIN / CONTROL  Dashboard, Providers, Models,      |
    |  PLANE            Routing, Requests, Usage, Health,  |
    |                   Logs, Audit, Users/Roles/Settings  |
    +------------------------------------------------------+
              |
     OpenAI · Anthropic · Google · Local model
```

## 2. Design principles

**2.1 Source of truth.** The server is always the source of truth. The browser is a
presentation layer and cache. Never depend on client-side state for authorization,
provider state, model availability, routing configuration, security decisions,
credentials or operational state.

**2.2 Domain separation.** Business logic must not live inside React components.
Separate: HTTP → API Controllers → Application Services → Domain Logic → Infrastructure.

**2.3 Providers are pluggable.** Adding a provider must not require modifying the
routing engine. Provider implementations conform to a common interface.

**2.4 Routing is independent.** The routing engine must not depend on React, HTTP,
SQLite, WebSocket or UI state. It must be independently testable.

**2.5 Security before convenience.** Never expose credentials merely because doing so
makes the UI easier. Never trust the browser. Never log secrets. Never return
provider credentials through normal API responses.

**2.6 ENTERPRISE-UI is the UI authority.** Use ENTERPRISE-UI components whenever
possible. If it lacks a required component: (1) check whether composition solves
the problem; (2) if not, create an application-level custom component; (3) build it
using ENTERPRISE-UI primitives/tokens; (4) if generally reusable, contribute it back.

## 3. Technology stack

- **Runtime: Bun.** Fast startup, native HTTP server, native WebSocket, native
  TypeScript, built-in package management, low infrastructure overhead, good fit for
  a self-contained server appliance, avoids unnecessary Node framework layers. Bun
  is intentionally retained.
- **Language: TypeScript.** Strict mode, strong domain types, explicit interfaces,
  minimal `any`, discriminated unions where useful, runtime validation at external
  boundaries.
- **Frontend:** React, TypeScript, ENTERPRISE-UI.
- **Database:** SQLite initially. A repository/data-access abstraction must exist so
  PostgreSQL can be introduced later without rewriting domain logic.
- **Transport:** HTTP/HTTPS, REST, WebSocket.
- **Authentication:** server-side sessions. Cookies: HttpOnly, Secure, SameSite.
- **Authorization:** RBAC.

## 4. Repository structure

```
clawapi/
  apps/console/src/
    app/ layouts/ pages/ components/custom/
    features/{auth,dashboard,providers,models,routing,requests,usage,health,
              logs,audit,users,roles,sessions,settings}/
    services/ hooks/ stores/ types/ main.tsx
  packages/
    core/ gateway/ providers/ models/ routing/ authentication/ authorization/
    database/ api/ health/ audit/ observability/ shared/
  docs/ specs/ tests/ scripts/
  package.json bun.lock bunfig.toml tsconfig.json
```

## 5. Core domain architecture

CORE (Configuration, Errors, Events, Types, Utilities) with the domains
AUTHENTICATION, AUTHORIZATION, GATEWAY, PROVIDERS, MODELS, ROUTING, USAGE, HEALTH,
AUDIT, OBSERVABILITY and DATABASE.

## 6. Request gateway

The actual AI request execution layer. Responsibilities: receive request,
authenticate caller, authorize operation, validate, normalize, determine requested
model/capabilities, query routing engine, select provider, execute provider request,
handle timeout, retry, failover, stream response if requested, record usage, record
metrics, record request result, emit events, return normalized response.

Pipeline: Client → Authentication → Authorization → Request Validation → Request
Normalization → Capability Detection → Routing Engine → Provider Selection →
Provider Request → (success → Response | failure → Retry Policy → Failover → Next
Provider → Response).

## 7. External AI API

A stable external API independent of provider APIs. Initial target: an
OpenAI-compatible API (`/v1/models`, `/v1/chat/completions`, `/v1/responses`,
`/v1/embeddings`). Exact endpoints are defined during the Gateway phase. Provides a
stable request/response format, streaming, authentication, model aliases, routing,
provider abstraction, error normalization and usage reporting. Provider-specific
differences remain inside provider implementations.

## 8. Provider engine

Provider abstraction: metadata, configuration, capabilities, models,
`validateConfiguration()`, `testConnection()`, `healthCheck()`, `sendRequest()`,
`sendStreamingRequest()`.

- Initial providers: OpenAI, Anthropic, Google, Local / OpenAI-compatible, future.
- States: `UNKNOWN`, `HEALTHY`, `DEGRADED`, `OFFLINE`, `DISABLED`.
- Data: id, name, identifier, endpoint, enabled, priority, status, capabilities,
  metadata, createdAt, updatedAt.

Provider implementations must not contain routing policy. Provider code answers
"How do I communicate with this provider?"; routing code answers "Which provider
should receive this request?"

## 9. Model registry

Models are first-class entities. Fields: id, providerId, providerModelId,
displayName, capabilities, contextLength, enabled, availability, costMetadata,
createdAt, updatedAt. Capabilities: `CHAT`, `CODING`, `REASONING`, `VISION`,
`EMBEDDINGS`, `TOOL_USE`, `RESEARCH`. Model availability must be distinguishable
from provider availability.

## 10. Routing engine

Inputs: requested model, requested capabilities, provider availability, model
availability, provider priority, provider weight, routing rules, failure state,
retry policy, request policy.

Factors: explicit model, model alias, capability match, provider eligibility,
priority, weight, health, availability, failure history, routing policy.

Example: `model = "fast-code"` → Primary: Provider A / Model X → Fallback: Provider
B / Model Y → Fallback: Local / Model Z.

Must support priority, weight, capability matching, model aliases, fallback,
disabled providers, disabled models, health-aware routing, retry policies and future
latency-aware routing.

## 11. Failover

Failover is part of the gateway, not the UI. Policies: `NONE`,
`RETRY_SAME_PROVIDER`, `FAILOVER_PROVIDER`, `RETRY_AND_FAILOVER`. The system must
prevent infinite retry loops.

## 12. Rate limiting

At the gateway layer. Potential limits: per API key, per user, per model, per
provider, per IP, global. Initial implementation can be in-memory; the architecture
should permit Redis or another distributed store later.

## 13. Streaming

First-class. Provider stream abstraction, normalized stream events, client
disconnect detection, request cancellation, provider cancellation, timeout
handling, usage accounting, error propagation. The gateway must not buffer an
entire response simply because a provider supports streaming.

## 14. API access management

Separate ADMIN SESSION from API CLIENT AUTHENTICATION. The console uses server-side
sessions; external AI applications use API credentials such as API keys. API key
model: owner, scopes, allowed models, rate limit, expiration, enabled, last used,
created, revoked. API keys are never displayed again after creation; persist only a
hash or secure representation.

## 15. Authentication

`POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`.
Security: password hashing, server-side sessions, HttpOnly cookies, Secure cookies
in production, SameSite, session expiration, revocation, login rate limiting,
failed-login auditing, disabled-user protection.

Initial setup: if no administrator exists, `/setup` creates the initial
administrator. After setup, `/setup` is disabled unless an explicit recovery/reset
process enables it.

## 16. RBAC

- **ADMIN** — full access.
- **OPERATOR** — providers, models, routing, health, logs, audit, requests, usage.
- **VIEWER** — read-only.

Authorization MUST be enforced server-side. Hiding a menu item is not authorization.

## 17. Admin console

Navigation:

- Dashboard
- Gateway: Requests, API Access, Usage
- AI Infrastructure: Providers, Models, Routing
- System: Health, Logs, Audit
- Administration: Users, Roles, Sessions, Settings

Header: ClawAPI identity, gateway status, system health, notifications, current
user, role, account menu, logout.

## 18. Visual design

Style: dark graphite, industrial, technical, dense, professional, information-rich.
Avoid: generic AI SaaS appearance, marketing hero sections, excessive gradients,
excessive rounded cards, huge empty spaces, decorative animations, consumer-dashboard
styling. Colors: GREEN healthy, ORANGE warning/testing, RED failed/offline, BLUE
informational/active. Never communicate important information through color alone.

## 19. ENTERPRISE-UI component policy

Priority: (1) existing ENTERPRISE-UI component, (2) composition, (3) custom
application component, (4) generic component contributed back. Custom components
live in `apps/console/src/components/custom/`, use ENTERPRISE-UI tokens and
primitives, follow its interaction conventions, and never introduce another design
system. Do not use Bootstrap, Material UI, Ant Design, Chakra, Tailwind UI, Shadcn or
other external UI frameworks.

## 20. Application shell

Desktop: header (ClawAPI | Gateway: HEALTHY | Notifications | user | Logout) above a
side navigation and page content. Must remain usable on desktop, laptop, tablet and
mobile. Interactive targets should generally be at least 44px.

## 21. Dashboard

Answers "Is my AI gateway working?" Primary metrics: gateway health, active
requests, requests/minute, error rate, average latency, provider availability, model
availability, active sessions, API clients, token usage, estimated cost, recent
failures. Sections: system health, gateway activity, provider status, request
statistics, current routing, recent errors, recent administrative actions. Live
updates where useful.

## 22. Requests

Request information: request ID, timestamp, client/API key, user, requested model,
selected model, provider, status, duration, tokens, error, retry count, failover
count. States: `RECEIVED`, `AUTHENTICATING`, `ROUTING`, `EXECUTING`, `STREAMING`,
`COMPLETED`, `FAILED`, `CANCELLED`, `TIMEOUT`. Never store sensitive request
payloads by default; payload retention must be configurable.

## 23. Usage

Track where supported: input/output/total tokens, request count, duration, provider,
model, API client, user, estimated cost. Distinguish provider-reported usage from
locally estimated usage.

## 24. Health system

Domains: platform, database, gateway, authentication, provider engine, providers,
WebSocket, API. States: `HEALTHY`, `DEGRADED`, `OFFLINE`, `DISABLED`, `UNKNOWN`.
Future: scheduled checks, health history, latency history, availability
percentages, failure trends.

## 25. Real-time event system

Typed internal event bus. Events: `provider.status`, `provider.test.started`,
`provider.test.completed`, `provider.test.failed`, `model.changed`,
`routing.changed`, `health.changed`, `request.started`, `request.completed`,
`request.failed`, `notification.created`, `session.revoked`, `operation.progress`.
WebSocket at `/api/ws`, authenticated with the existing session. REST remains the
primary data API; WebSocket exists for live updates.

## 26. Operations

Long-running operations: `QUEUED`, `RUNNING`, `SUCCESS`, `FAILED`, `TIMEOUT`,
`CANCELLED` (provider connection test, health check, configuration reload, future
maintenance). Fields: id, type, status, startedAt, completedAt, progress, result,
error.

## 27. Logging

Levels: DEBUG, INFO, WARN, ERROR, FATAL. Filtering: timestamp, level, component,
provider, request ID, user, search text. Never log API keys, provider secrets,
passwords, session tokens, authorization headers or sensitive request content.

## 28. Audit

Events: `LOGIN`, `LOGOUT`, `LOGIN_FAILED`, `PROVIDER_CREATED`, `PROVIDER_UPDATED`,
`PROVIDER_ENABLED`, `PROVIDER_DISABLED`, `CREDENTIAL_CREATED`,
`CREDENTIAL_REPLACED`, `CREDENTIAL_REMOVED`, `CONNECTION_TEST`, `MODEL_CREATED`,
`MODEL_UPDATED`, `MODEL_ENABLED`, `MODEL_DISABLED`, `ROUTING_UPDATED`,
`API_KEY_CREATED`, `API_KEY_REVOKED`, `USER_CREATED`, `USER_ENABLED`,
`USER_DISABLED`, `ROLE_CHANGED`, `SETTINGS_CHANGED`, `SESSION_REVOKED`.
Record: timestamp, user, action, resource, resourceId, result, IP, metadata. Never
store secrets in audit metadata.

## 29. Credential management

Credentials are server-owned. The browser never receives stored credentials.
Encrypt at rest; the encryption key must be external to the database (future:
environment secret, OS secret store, secret manager). Never store credentials in
localStorage, sessionStorage, URL parameters, WebSocket messages, logs, audit
metadata or normal API responses.

## 30. Database

SQLite initially. Core tables: `USERS`, `ROLES`, `USER_ROLES`, `SESSIONS`,
`PROVIDERS`, `PROVIDER_CREDENTIALS`, `MODELS`, `ROUTING_RULES`, `API_KEYS`,
`REQUESTS`, `USAGE_RECORDS`, `OPERATIONS`, `AUDIT_LOG`, `SETTINGS`,
`RATE_LIMIT_CONFIG`, `PROVIDER_HEALTH_HISTORY`. Domain logic must not directly
depend on SQLite APIs; use repositories/data-access interfaces (SQLite → future
PostgreSQL → future distributed database).

## 31. REST API (administration)

```
AUTH       POST /api/auth/login · POST /api/auth/logout · GET /api/auth/session
USERS      GET/POST /api/users · GET/PATCH/DELETE /api/users/:id
PROVIDERS  GET/POST /api/providers · GET/PATCH/DELETE /api/providers/:id
           POST /api/providers/:id/test
MODELS     GET/POST /api/models · GET/PATCH/DELETE /api/models/:id
ROUTING    GET/PUT /api/routing
API ACCESS GET/POST /api/api-keys · DELETE /api/api-keys/:id
REQUESTS   GET /api/requests · GET /api/requests/:id
USAGE      GET /api/usage
HEALTH     GET /api/health · GET /api/health/providers
LOGS       GET /api/logs
AUDIT      GET /api/audit
SETTINGS   GET/PUT /api/settings
WEBSOCKET  /api/ws
```

## 32. External gateway API

Separate from the administration API: admin is `/api/*`, external AI API is
`/v1/*` (e.g. `POST /v1/chat/completions`). The external gateway must never inherit
administrative privileges simply because the request originates from the same
server.

## 33. Error handling

Categories: `VALIDATION_ERROR`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`,
`NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `PROVIDER_ERROR`, `PROVIDER_TIMEOUT`,
`ROUTING_ERROR`, `DATABASE_ERROR`, `INTERNAL_ERROR`. Internal errors are logged
internally; clients receive safe, normalized errors. Never expose stack traces or
secrets in production responses.

## 34. State management

Separate SERVER STATE (providers, models, requests, usage, health, logs, audit),
AUTH STATE (current user, session, permissions), UI STATE (sidebar, filters,
selected rows, dialogs, preferences) and FORM STATE (provider configuration,
routing configuration, user creation, settings). Do not create a single global state
object containing everything.

## 35. Performance

Support hundreds of providers, thousands of models, and large request, audit and log
histories. Server-side pagination and filtering, debounced search, lazy loading,
virtualized large lists where needed, efficient WebSocket events, minimal React
re-rendering, indexed queries. Never load an entire log/audit/request table into the
browser.

## 36. Accessibility

Keyboard navigation, visible focus, semantic labels, accessible dialogs and forms,
screen-reader-friendly status, sufficient contrast, non-color status indicators,
accessible tables, accessible error messages.

## 37. Security hardening (required before production)

Password hashing, session security, CSRF protection where applicable, RBAC
enforcement, API key security, rate limiting, request validation, response
validation, secret encryption, secure cookies, login throttling, audit logging,
input sanitization, output safety, error normalization, security tests.

## 38. Testing strategy

- **Unit:** routing engine, provider selection, failover, retry policies, permission
  checks, credential handling, rate limiting, validation.
- **Integration:** database, authentication, provider engine, gateway, REST API,
  WebSocket.
- **Gateway:** success, invalid request, authentication failure, authorization
  failure, provider timeout, provider failure, retry, failover, streaming,
  cancellation, rate limiting, usage accounting.
- **UI:** login, dashboard, provider management, model management, routing, request
  history, administration, responsive layout, accessibility.

## 39. Development rules

1. Business logic does not belong in React components.
2. Provider logic does not belong in routing.
3. Routing does not belong in HTTP handlers.
4. Database implementation does not leak into domain logic.
5. Credentials never cross the security boundary unnecessarily.
6. The API is authoritative.
7. ENTERPRISE-UI is the design system.
8. Custom components are allowed when ENTERPRISE-UI does not provide the required
   functionality.
9. Every major domain should be independently testable.
10. Prefer simple infrastructure over unnecessary frameworks.

## 40. Roadmap

| Phase | Goal | Tasks | Exit |
|---|---|---|---|
| 0 Project bootstrap | Create the foundation | Repository, Bun, TS strict, React, ENTERPRISE-UI, monorepo structure, dev scripts, env config, basic logging, error model, shared types, test infra, SQLite connection, migration system, `/api/health` | Bun starts; console starts; ENTERPRISE-UI renders; SQLite connects; `/api/health` works; tests execute |
| 1 Core backend | Basic server architecture | Bun HTTP server, request router, middleware pipeline, error handling, configuration service, logging service, event bus, repository interfaces, SQLite repositories, migration runner, API response conventions | Server serves API endpoints; persistence works; errors normalized; domain services independent of HTTP |
| 2 Authentication | Secure the application | USERS table, password hashing, session table, login, logout, session lookup, expiration, revocation, login throttling, failed-login audit, initial setup wizard | Secure login/logout; server-side sessions; no admin without authentication |
| 3 Authorization | RBAC | Roles, permissions, user-role assignments, authorization middleware, permission service, ADMIN/OPERATOR/VIEWER, authorization tests | Every protected endpoint enforces permissions server-side |
| 4 Application shell | The real console | Shell, sidebar, header, routing, page layout, responsive layout, notifications, user menu, permission-aware navigation, loading states, error states | Functional enterprise shell for authenticated users |
| 5 Provider engine | Provider abstraction | Interface, repository, configuration, credential storage + encryption, lifecycle, connection testing, health checks, state, events, OpenAI, Anthropic, Google, Local/OpenAI-compatible | Multiple providers through one standardized interface |
| 6 Model registry | First-class models | Repository, CRUD, provider/model relationship, capabilities, availability, context length, cost metadata, discovery, admin UI | Providers expose usable models |
| 7 Routing engine | Provider/model selection | Routing domain, rules, aliases, capability matching, priority, weights, health-aware, disabled handling, fallback, tests | Deterministic selection of the best eligible provider/model |
| 8 Request gateway | The actual AI gateway | Pipeline, external auth, API key management, validation, normalization, model resolution, routing integration, provider execution, response + error normalization, timeout, retry, failover, cancellation, streaming, request IDs, metrics, usage accounting; `/v1/models`, `/v1/chat/completions`, `/v1/embeddings`, `/v1/responses` | External clients use ClawAPI without knowing the provider |
| 9 Rate limiting | Protect the gateway | Abstraction, per-key/user/model/global limits, headers, events, admin config | Abusive clients cannot overwhelm the gateway |
| 10 Requests + usage | Observability of activity | Persistence, status, duration, provider/model, retry + failover counts, usage records, tokens, cost estimation, history UI, usage dashboard | Administrators understand gateway activity |
| 11 Real-time | Live operational state | Typed event bus, WebSocket server, session-authenticated WS, provider/health/request/routing/notification events, UI subscriptions, reconnection | Dashboard updates live |
| 12 Health + operations | Operational visibility | Platform/database/gateway/provider/WS health, history, operations, connection tests, cancellation, status UI | Exactly which part is healthy or failing |
| 13 Logging + audit | Traceability | Structured logs, levels, filtering, correlation IDs, audit repository + UI, auth/provider/routing/user/API-key auditing, secret redaction | Actions traceable without exposing secrets |
| 14 Administration | Complete the control plane | Users, roles, sessions, API keys, providers, models, routing, system + security settings | Entire platform administered through the console |
| 15 Security hardening | Real-world deployment | Reviews (security, authn, authz, sessions, API keys, credential encryption, CSRF, rate limits, input/output validation), secret scanning, dependency audit, security + failure-path tests | No known critical weaknesses |
| 16 Performance | Optimize | Indexes, query/pipeline/memory profiling, provider latency, WS + UI optimization, virtualization, caching, pooling | Predictable under realistic load |
| 17 Production | Self-hosted package | Production config, HTTPS docs, reverse proxy, backup/restore, config export/import, credential recovery, health endpoint, graceful shutdown/restart, migrations, production logging, deployment docs | Standalone production AI gateway |

## 41. Future roadmap

- **Multi-server:** multiple installations, server registry, health, groups, remote
  management, version tracking, remote upgrades.
- **Advanced routing:** latency-, cost-, token-aware and geographic routing, provider
  quotas, model quality policies, load balancing, circuit breakers.
- **Advanced observability:** request analytics, provider/model performance, error,
  token and cost trends, availability percentages, latency percentiles.
- **Advanced security:** fine-grained permissions, API scopes, key and secret
  rotation, external identity providers, SSO, MFA, IP restrictions.
- **Infrastructure:** PostgreSQL, Redis, distributed rate limiting, distributed event
  system, multiple gateway nodes.
- **AI features:** model aliases, automatic fallback, capability-based selection,
  cost optimization, provider benchmarking, model health scoring, automatic routing
  optimization.

## 42. Implementation order

01 Bun + TypeScript foundation → 02 core backend → 03 SQLite + repositories →
04 authentication → 05 RBAC → 06 React + ENTERPRISE-UI shell → 07 provider engine →
08 model registry → 09 routing engine → 10 request gateway → 11 streaming / retry /
failover → 12 API keys / rate limiting → 13 requests / usage → 14 WebSocket / events
→ 15 health / logs / audit → 16 administration → 17 security hardening →
18 performance → 19 production packaging.

## 43. Vertical slice strategy

Do not build the entire backend first and the entire frontend afterward. Each major
phase produces a working vertical slice, e.g. PROVIDERS: database → domain → API →
WebSocket events → React service → ENTERPRISE-UI page → tests. Then MODELS, ROUTING,
GATEWAY likewise. This keeps the application runnable throughout development.

## 44. First working milestone

Not the whole gateway. Build: React + ENTERPRISE-UI console (Dashboard, Providers,
Models, Routing) → Bun HTTP server → SQLite and `/api/health`.

Exit criteria: repository exists; Bun builds/runs; TypeScript strict mode; React
console runs; ENTERPRISE-UI renders; Bun API server runs; SQLite works; migration
system works; `/api/health` works; basic test suite works; development workflow
documented.

## 45. Architectural end state

AI clients → ClawAPI gateway → (authentication, rate limiting, validation) →
request engine → routing engine → providers A/B/C → AI providers. Control plane:
the ENTERPRISE-UI admin console (dashboard, providers, models, routing, requests,
usage, health, logs, audit, users, roles, API keys, sessions, settings).

## 46. Final architectural position

ClawAPI is not an admin panel around an AI gateway. ClawAPI IS the AI gateway.

- **Data plane** handles AI traffic: API gateway, authentication, API keys, rate
  limiting, request engine, routing, providers, streaming, failover, usage.
- **Control plane** manages the platform: dashboard, providers, models, routing,
  requests, usage, health, logs, audit, users, roles, sessions, settings.

The planes share core domain services but remain logically separated. The UI must
never become responsible for gateway behavior. The gateway must remain fully
functional without the React console.

## 47. Core design philosophy

Small, modular, low-level, testable, provider-agnostic, UI-independent,
security-first, performance-aware. Avoid building a framework around the framework.
Bun provides the runtime, TypeScript the language, ENTERPRISE-UI the UI system,
SQLite the initial persistence layer. ClawAPI provides the gateway, routing,
provider abstraction, security, observability and control plane. Everything else
should exist only when it solves a concrete problem.
