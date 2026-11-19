# Security roadmap (full text)

The owner's security hardening roadmap, word for word, as given on 2026-11-19 in
two messages (the first ended part-way through SEC-026; the second began again at
Phase 9). This is the source; progress is tracked in
[security-roadmap.md](security-roadmap.md). Do not edit the roadmap text below:
record status, decisions and findings in the tracking page instead.

```text
+======================================================================+
|                    CLAWROUTER SECURITY HARDENING                     |
|                         SECURITY ROADMAP                             |
+======================================================================+

PROJECT: ClawRouter
GOAL: Harden ClawRouter for secure Internet-facing production use
STATUS: Proposed
PRIORITY: P0 -> P4


========================================================================
PHASE 1 - NETWORK SECURITY BOUNDARY
========================================================================

SEC-001  SSRF PROTECTION
         Priority: CRITICAL

         Create a centralized outbound-network security layer.

         Requirements:
           [ ] Validate every provider URL
           [ ] Resolve DNS before connecting
           [ ] Reject IPv4 loopback addresses
           [ ] Reject IPv4 private ranges
           [ ] Reject IPv4 link-local ranges
           [ ] Reject multicast/reserved addresses
           [ ] Reject IPv6 loopback
           [ ] Reject IPv6 private ranges
           [ ] Reject IPv6 link-local addresses
           [ ] Block cloud metadata endpoints
           [ ] Prevent DNS rebinding
           [ ] Re-check resolved IP before connection
           [ ] Support explicit allowlists for trusted local providers
           [ ] Centralize all outbound network policy

         Suggested architecture:

           Provider URL
                |
                v
           URL Validator
                |
                v
           DNS Resolver
                |
                v
           IP Classifier
                |
           +----+----+
           |         |
         BLOCK      ALLOW
                     |
                     v
                 HTTP Client

         Suggested files:

           packages/security/
             outbound-network-policy.ts
             ip-classifier.ts
             safe-dns.ts
             ssrf-protection.ts


SEC-002  MCP SECURITY AUDIT
         Priority: CRITICAL

         Treat /v1/mcp as an independent security boundary.

         Test:
           [ ] Authentication
           [ ] API-key authorization
           [ ] Tool enumeration
           [ ] Hidden-tool discovery
           [ ] Tool parameter validation
           [ ] Permission bypass
           [ ] Object ownership
           [ ] Pagination
           [ ] Result-size limits
           [ ] Tool chaining
           [ ] Error information leakage
           [ ] Sensitive-data exposure
           [ ] Rate limiting
           [ ] Concurrent requests
           [ ] Malicious MCP clients

         Test identities:

           [ ] Anonymous
           [ ] Authenticated user
           [ ] Viewer
           [ ] Operator
           [ ] Admin
           [ ] MCP-enabled API key
           [ ] MCP-disabled API key
           [ ] Expired API key
           [ ] Revoked API key
           [ ] Disabled user


SEC-003  BACKUP / RESTORE SECURITY AUDIT
         Priority: CRITICAL

         Audit:

           [ ] Backup creation
           [ ] Backup listing
           [ ] Backup download
           [ ] Backup import
           [ ] Backup restore
           [ ] Configuration export
           [ ] Configuration import
           [ ] Secret-key handling

         Test for:

           [ ] Path traversal
           [ ] ../ traversal
           [ ] Absolute paths
           [ ] Symlink attacks
           [ ] Arbitrary file overwrite
           [ ] Arbitrary file creation
           [ ] Permission manipulation
           [ ] Malicious SQLite databases
           [ ] Corrupted backups
           [ ] Oversized backups
           [ ] Archive bombs
           [ ] Malicious configuration
           [ ] Secret-key exposure

         Required rule:

           Backup path
                |
                v
           Canonicalize
                |
                v
           Verify path is inside backup directory
                |
                v
           Access filesystem


SEC-004  CONTAINER HARDENING
         Priority: CRITICAL

         Docker deployment should use:

           [ ] Non-root user
           [ ] Read-only root filesystem
           [ ] no-new-privileges
           [ ] Drop ALL Linux capabilities
           [ ] No privileged mode
           [ ] No Docker socket
           [ ] No host PID namespace
           [ ] No host networking
           [ ] Minimal writable volumes
           [ ] Temporary filesystem for /tmp
           [ ] Seccomp profile
           [ ] AppArmor/SELinux compatibility

         Goal:

           Application compromise
                  |
                  v
           Container compromise
                  |
                  X
           Host compromise


========================================================================
PHASE 2 - AI GATEWAY ABUSE PROTECTION
========================================================================

SEC-005  COST-BASED RATE LIMITING
         Priority: HIGH

         Add resource/cost limits in addition to request rate limits.

         Limits:

           [ ] Per API key
           [ ] Per user
           [ ] Per model
           [ ] Per provider
           [ ] Per hour
           [ ] Per day
           [ ] Per month

         Controls:

           [ ] maxTokensPerRequest
           [ ] maxEstimatedCostPerRequest
           [ ] maxHourlyCost
           [ ] maxDailyCost
           [ ] maxMonthlyCost
           [ ] maxConcurrentRequests
           [ ] maxStreamingDuration

         Example:

           API Key
             |
             +-- 100 requests/hour
             +-- $5/hour
             +-- $25/day
             +-- $100/month
             +-- 3 concurrent requests


SEC-006  REQUEST RESOURCE LIMITS
         Priority: HIGH

         Do not rely only on request byte limits.

         Add:

           [ ] maxRequestBytes
           [ ] maxJSONDepth
           [ ] maxMessages
           [ ] maxContentParts
           [ ] maxToolDefinitions
           [ ] maxToolSchemaBytes
           [ ] maxImages
           [ ] maxImageBytes
           [ ] maxImageDimensions
           [ ] maxInputTokens
           [ ] maxOutputTokens
           [ ] maxStreamDuration


SEC-007  PROVIDER TLS ENFORCEMENT
         Priority: HIGH

           [ ] HTTPS required by default
           [ ] Reject HTTP provider URLs by default
           [ ] Permit HTTP only for explicitly trusted local endpoints
           [ ] Make insecure HTTP an explicit configuration option
           [ ] Validate TLS certificates normally
           [ ] Never disable TLS verification by default


SEC-008  DNS REBINDING PROTECTION
         Priority: HIGH

         Protect against:

           evil.example.com
                 |
                 v
             DNS lookup
                 |
                 v
             Public IP
                 |
                 v
             Validation passes
                 |
                 v
             DNS changes
                 |
                 v
             127.0.0.1

         Requirements:

           [ ] Validate DNS result
           [ ] Bind connection to validated address
           [ ] Prevent resolution changes between validation/connect
           [ ] Test IPv4 and IPv6
           [ ] Test multiple DNS responses


========================================================================
PHASE 3 - DATA PROTECTION
========================================================================

SEC-009  REQUEST-DATA MINIMIZATION
         Priority: HIGH

         Implement logging modes:

           NONE
           METADATA
           FULL

         Default:

           METADATA

         Metadata may contain:

           [ ] Request ID
           [ ] Timestamp
           [ ] User/API key identity
           [ ] Model
           [ ] Provider
           [ ] HTTP status
           [ ] Latency
           [ ] Token counts
           [ ] Cost

         FULL mode additionally stores:

           [ ] Prompt
           [ ] Response
           [ ] Tool calls
           [ ] Attachment metadata

         FULL mode must display a clear privacy warning.


SEC-010  SECRET SCRUBBING TEST SUITE
         Priority: HIGH

         Test redaction of:

           [ ] API keys
           [ ] Bearer tokens
           [ ] Cookies
           [ ] Passwords
           [ ] Provider credentials
           [ ] SMTP credentials
           [ ] Session IDs
           [ ] Setup tokens
           [ ] OAuth tokens
           [ ] Private keys
           [ ] JWTs
           [ ] MCP credentials

         Test secrets embedded in:

           [ ] JSON
           [ ] Nested JSON
           [ ] Arrays
           [ ] URLs
           [ ] Query parameters
           [ ] Headers
           [ ] Exceptions
           [ ] Stack traces
           [ ] Tool arguments
           [ ] Provider errors


SEC-011  BACKUP CREDENTIAL SEPARATION
         Priority: HIGH

         Normal backup:

           [ ] Database
           [ ] Configuration
           [ ] Non-secret operational data

         Credential backup:

           [ ] Database
           [ ] Configuration
           [ ] Encryption secret key

         Requirements:

           [ ] Explicit confirmation before including secret key
           [ ] Warning that credential backups are sensitive
           [ ] Never expose secret key in normal backup listings
           [ ] Protect credential backups with restrictive permissions


========================================================================
PHASE 4 - SECURITY TESTING
========================================================================

SEC-012  SECURITY REGRESSION SUITE
         Priority: HIGH

         Create:

           tests/security/

         Categories:

           [ ] authentication/
           [ ] authorization/
           [ ] sessions/
           [ ] csrf/
           [ ] api-keys/
           [ ] rate-limits/
           [ ] mcp/
           [ ] ssrf/
           [ ] backup/
           [ ] restore/
           [ ] logging/
           [ ] websocket/
           [ ] provider/
           [ ] configuration/


SEC-013  AUTHENTICATION ATTACK TESTING
         Priority: MEDIUM

           [ ] Credential stuffing
           [ ] Brute force
           [ ] Username enumeration
           [ ] Session fixation
           [ ] Session replay
           [ ] Expired sessions
           [ ] Revoked sessions
           [ ] Disabled accounts
           [ ] Concurrent sessions
           [ ] Setup-token replay
           [ ] Setup-token brute force
           [ ] Password reset abuse
           [ ] 2FA bypass
           [ ] Recovery-code replay


SEC-014  AUTHORIZATION MATRIX TESTING
         Priority: HIGH

         Create a machine-readable authorization matrix.

           Example:

                              ADMIN  OPERATOR  VIEWER  API-KEY
           ----------------------------------------------------
           health                Y       Y        Y       Y
           users                 Y       N        N       N
           providers             Y       Y        N       N
           models                Y       Y        Y       Y
           requests              Y       Y        Y       -
           audit                 Y       Y        N       N
           settings              Y       N        N       N
           MCP                   configurable

         Requirements:

           [ ] Every route has an explicit authorization policy
           [ ] Every role is tested
           [ ] Anonymous access is tested
           [ ] API-key access is tested
           [ ] Regression tests run automatically


SEC-015  WEBSOCKET SECURITY
         Priority: HIGH

         Audit:

           [ ] Authentication
           [ ] Session expiration
           [ ] Session revocation
           [ ] Origin validation
           [ ] Message validation
           [ ] Message-size limits
           [ ] Connection limits
           [ ] Idle timeout
           [ ] Reconnection storms
           [ ] Subscription authorization

         Test:

           [ ] Valid session
           [ ] Expired session
           [ ] Revoked session
           [ ] Invalid session
           [ ] Cross-origin request
           [ ] Oversized message
           [ ] Malformed frame
           [ ] Rapid reconnect


========================================================================
PHASE 5 - CONFIGURATION SECURITY
========================================================================

SEC-016  CONFIGURATION SECURITY CLASSIFICATION
         Priority: MEDIUM

         Classify configuration values:

           PUBLIC
           SENSITIVE
           SECRET
           SECURITY_CRITICAL

         SECRET and SECURITY_CRITICAL values:

           [ ] Never logged
           [ ] Never exposed through normal API
           [ ] Never exposed through MCP
           [ ] Never included in normal errors
           [ ] Never included in normal exports


SEC-017  CONFIGURATION IMPORT SANDBOX
         Priority: HIGH

         Treat imported configuration as untrusted input.

         Validate:

           [ ] Schema
           [ ] Types
           [ ] Ranges
           [ ] URLs
           [ ] Filesystem paths
           [ ] Provider configuration
           [ ] Rate limits
           [ ] Roles
           [ ] Permissions

         Requirements:

           [ ] Reject malformed configuration
           [ ] Reject unknown security-sensitive fields
           [ ] Prevent privilege escalation
           [ ] Prevent filesystem traversal
           [ ] Prevent arbitrary command execution


========================================================================
PHASE 6 - SUPPLY CHAIN SECURITY
========================================================================

SEC-018  DEPENDENCY SECURITY
         Priority: MEDIUM

           [ ] Automated dependency auditing
           [ ] Lockfile verification
           [ ] Automated dependency updates
           [ ] License scanning
           [ ] High-severity vulnerability CI failure
           [ ] Critical-severity vulnerability CI failure


SEC-019  SOFTWARE BILL OF MATERIALS
         Priority: MEDIUM

         Generate an SBOM for every release.

         Supported target formats:

           [ ] SPDX
           [ ] CycloneDX

         Release artifacts should include:

           [ ] Application version
           [ ] Dependencies
           [ ] Dependency versions
           [ ] Runtime dependencies


SEC-020  SIGNED RELEASES
         Priority: MEDIUM

         Release pipeline:

           Source
             |
             v
           Build
             |
             v
           Artifact
             |
             v
           SHA-256
             |
             v
           Digital Signature
             |
             v
           GitHub Release

         Requirements:

           [ ] Sign release artifacts
           [ ] Publish checksums
           [ ] Document verification process
           [ ] Verify release artifacts in CI


========================================================================
PHASE 7 - ADVANCED SECURITY
========================================================================

SEC-021  FUZZ TESTING
         Priority: MEDIUM

         Fuzz:

           [ ] JSON parsing
           [ ] Request validation
           [ ] Provider responses
           [ ] MCP messages
           [ ] Configuration imports
           [ ] Backup files
           [ ] Routing configuration
           [ ] Model metadata
           [ ] Streaming responses


SEC-022  CSP TIGHTENING
         Priority: LOW

         Investigate removal of:

           style-src 'unsafe-inline'

         Requirements:

           [ ] Verify ENTERPRISE-UI compatibility
           [ ] Remove inline styles where practical
           [ ] Maintain application functionality
           [ ] Add CSP regression tests


SEC-023  FILESYSTEM HARDENING
         Priority: MEDIUM

         Review:

           [ ] data/
           [ ] database
           [ ] secret.key
           [ ] setup-token
           [ ] backups/
           [ ] logs/

         Verify:

           [ ] Owner
           [ ] Group
           [ ] Permissions
           [ ] umask

         Suggested baseline:

           secret.key       0600
           setup-token      0600
           database         0600
           configuration    0600
           backups/         0700

         Adjust where deployment architecture requires otherwise.


========================================================================
PHASE 8 - HOST / SYSTEMD HARDENING
========================================================================

SEC-024  SYSTEMD HARDENING
         Priority: HIGH

         Evaluate:

           [ ] NoNewPrivileges=true
           [ ] PrivateTmp=true
           [ ] ProtectSystem=strict
           [ ] ProtectHome=true
           [ ] ProtectKernelTunables=true
           [ ] ProtectKernelModules=true
           [ ] ProtectControlGroups=true
           [ ] RestrictSUIDSGID=true
           [ ] LockPersonality=true
           [ ] RestrictRealtime=true
           [ ] RestrictNamespaces=true

         Explicitly allow only directories ClawRouter requires.


SEC-025  SECURITY HEALTH CHECK
         Priority: MEDIUM

         Expand:

           bun run doctor

         Into:

           bun run doctor --security

         Example output:

           CLAWROUTER SECURITY CHECK

           [PASS] HTTPS configured
           [PASS] Secure cookies enabled
           [PASS] CSRF protection enabled
           [PASS] Trusted proxy configuration valid
           [PASS] API keys hashed
           [PASS] Provider credentials encrypted
           [PASS] Secret key permissions: 0600
           [PASS] Database permissions: 0600
           [PASS] MCP disabled
           [PASS] No insecure provider URLs
           [PASS] No wildcard CORS
           [PASS] Container running non-root

           [WARN] Backup directory permissions too broad
           [WARN] Request logging contains prompt content


========================================================================
PHASE 9 - CONTINUOUS SECURITY
========================================================================

SEC-026  SECURITY CI PIPELINE
         Priority: HIGH

         Every pull request should run:

           TypeScript typecheck
                 |
                 v
           Unit tests
                 |
                 v
           Integration tests
                 |
                 v
           Security tests
                 |
                 v
           Dependency audit
                 |
                 v
           Secret scanning
                 |
                 v
           SAST
                 |
                 v
           Container scanning
                 |
                 v
           SBOM generation
                 |
                 v
           Build verification

         Requirements:

           [ ] Security tests cannot be skipped silently
           [ ] Critical security failures block merge
           [ ] High-severity findings block merge unless explicitly waived
           [ ] Dependency vulnerabilities are reported
           [ ] Secrets detected in commits fail CI
           [ ] Container vulnerabilities are reported
           [ ] Security reports are retained as CI artifacts
           [ ] Release builds use the same security pipeline


SEC-027  SECURITY REGRESSION CORPUS
         Priority: HIGH

         Maintain:

           tests/security/cases/

         Every discovered vulnerability becomes a permanent
         regression test.

         Include cases for:

           [ ] SSRF
           [ ] CSRF
           [ ] XSS
           [ ] Path traversal
           [ ] Authorization bypass
           [ ] Session fixation
           [ ] API-key leakage
           [ ] Secret leakage
           [ ] MCP privilege escalation
           [ ] Request smuggling
           [ ] HTTP desynchronization
           [ ] DNS rebinding
           [ ] Denial of service
           [ ] Configuration injection
           [ ] Backup/restore attacks
           [ ] WebSocket authorization
           [ ] Provider credential leakage

         Rule:

           Vulnerability discovered
                    |
                    v
              Fix vulnerability
                    |
                    v
             Add regression test
                    |
                    v
              Merge fix only
                    |
                    v
          Test remains permanently


========================================================================
PHASE 10 - SECURITY OBSERVABILITY
========================================================================

SEC-028  SECURITY EVENT MODEL
         Priority: MEDIUM

         Define standardized security events.

         Examples:

           AUTH_LOGIN_SUCCESS
           AUTH_LOGIN_FAILURE
           AUTH_ACCOUNT_LOCKED
           AUTH_SESSION_CREATED
           AUTH_SESSION_REVOKED
           AUTH_SESSION_EXPIRED

           API_KEY_CREATED
           API_KEY_REVOKED
           API_KEY_SUSPENDED

           USER_CREATED
           USER_DISABLED
           USER_ROLE_CHANGED

           MCP_ACCESS_GRANTED
           MCP_ACCESS_DENIED
           MCP_TOOL_DENIED

           SSRF_BLOCKED
           INVALID_PROVIDER_URL
           RATE_LIMIT_EXCEEDED
           COST_LIMIT_EXCEEDED

           BACKUP_CREATED
           BACKUP_RESTORED
           CREDENTIAL_BACKUP_CREATED

           CONFIG_IMPORT
           CONFIG_IMPORT_REJECTED

         Requirements:

           [ ] Consistent event names
           [ ] Timestamp
           [ ] Request ID
           [ ] Actor identity where available
           [ ] Source IP where appropriate
           [ ] Result
           [ ] Reason
           [ ] No secrets in events


SEC-029  SECURITY ALERTING
         Priority: MEDIUM

         Detect suspicious activity.

         Examples:

           [ ] Repeated authentication failures
           [ ] API-key brute force
           [ ] Large number of denied requests
           [ ] Repeated SSRF attempts
           [ ] Repeated MCP authorization failures
           [ ] Excessive provider failures
           [ ] Cost-limit violations
           [ ] Large request-volume spikes
           [ ] Configuration changes
           [ ] New administrator accounts
           [ ] Provider credential changes
           [ ] Backup restoration

         Alert severity:

           INFO
           WARNING
           HIGH
           CRITICAL


SEC-030  SECURITY EVENT RETENTION
         Priority: LOW

         Define retention policies for security events.

           [ ] Configurable retention period
           [ ] Automatic expiration
           [ ] Prevent unbounded database growth
           [ ] Protect security logs from ordinary users
           [ ] Preserve critical security events longer
           [ ] Document retention behavior


========================================================================
PHASE 11 - API SECURITY
========================================================================

SEC-031  HTTP REQUEST SMUGGLING REVIEW
         Priority: MEDIUM

         Review:

           [ ] Content-Length handling
           [ ] Transfer-Encoding handling
           [ ] HTTP/1.1 parsing
           [ ] HTTP/2 behavior
           [ ] Reverse-proxy interaction
           [ ] Connection reuse
           [ ] Chunked encoding
           [ ] Malformed headers

         Test ClawRouter both:

           Directly
             AND
           Behind nginx
             AND
           Behind another supported reverse proxy


SEC-032  CORS SECURITY
         Priority: HIGH

         Verify:

           [ ] No wildcard origin when credentials are enabled
           [ ] Explicit allowed origins
           [ ] Allowed methods are minimal
           [ ] Allowed headers are minimal
           [ ] Credentials behavior is explicit
           [ ] Preflight requests are validated
           [ ] Production defaults are restrictive

         Security goal:

           Unknown browser origin
                    |
                    X
              No credentialed
                 access


SEC-033  API ERROR HARDENING
         Priority: MEDIUM

         Ensure API errors never expose:

           [ ] Stack traces
           [ ] Filesystem paths
           [ ] Environment variables
           [ ] Provider API keys
           [ ] Database paths
           [ ] Encryption keys
           [ ] Internal network addresses
           [ ] SQL statements
           [ ] Internal service credentials

         Production response:

           {
             "error": {
               "code": "INVALID_REQUEST",
               "message": "Request could not be processed."
             }
           }

         Detailed information:

           -> Server-side logs only


SEC-034  HTTP METHOD SECURITY
         Priority: LOW

         Verify every route explicitly defines allowed methods.

         Reject:

           [ ] Unexpected HTTP methods
           [ ] Method tunneling where unnecessary
           [ ] Unsupported OPTIONS behavior
           [ ] Unexpected HEAD behavior

         Test:

           GET
           POST
           PUT
           PATCH
           DELETE
           OPTIONS
           HEAD


========================================================================
PHASE 12 - PROVIDER SECURITY
========================================================================

SEC-035  PROVIDER ISOLATION
         Priority: HIGH

         Ensure provider failures cannot compromise other providers.

         Example:

           Provider A
              |
              X
         malformed response
              |
              X
         Provider B

         Requirements:

           [ ] Provider-specific error handling
           [ ] Provider-specific timeouts
           [ ] Provider-specific retry limits
           [ ] Provider-specific circuit breakers
           [ ] No credential cross-contamination
           [ ] No shared mutable provider state


SEC-036  PROVIDER RESPONSE VALIDATION
         Priority: HIGH

         Treat provider responses as untrusted input.

         Validate:

           [ ] Content type
           [ ] JSON structure
           [ ] Maximum response size
           [ ] Maximum nesting depth
           [ ] Expected fields
           [ ] String lengths
           [ ] Numeric ranges
           [ ] Streaming events

         Never assume:

           "Provider response is trusted because
            we initiated the request."


SEC-037  PROVIDER TIMEOUTS
         Priority: HIGH

         Define limits for:

           [ ] DNS resolution
           [ ] TCP connection
           [ ] TLS handshake
           [ ] Request headers
           [ ] Request body
           [ ] First response byte
           [ ] Streaming response
           [ ] Total request duration

         Prevent:

           Slow provider
                |
                v
           Held connection
                |
                v
           Resource exhaustion


SEC-038  PROVIDER RETRY PROTECTION
         Priority: MEDIUM

         Ensure retries cannot create a self-amplifying DoS.

         Requirements:

           [ ] Maximum retry count
           [ ] Exponential backoff
           [ ] Jitter
           [ ] Retry only safe failures
           [ ] Respect provider rate limits
           [ ] Global retry budget
           [ ] Per-request retry budget


========================================================================
PHASE 13 - TENANCY AND DATA ISOLATION
========================================================================

SEC-039  RESOURCE OWNERSHIP TESTING
         Priority: HIGH

         Verify users cannot access resources belonging to another user.

         Test:

           [ ] API keys
           [ ] Requests
           [ ] Usage data
           [ ] Audit events
           [ ] Provider configurations
           [ ] Backups
           [ ] Sessions
           [ ] MCP permissions

         Attack pattern:

           User A
              |
              v
           Resource ID belonging to User B
              |
              v
           MUST return authorization failure


SEC-040  IDOR SECURITY AUDIT
         Priority: HIGH

         Audit every endpoint accepting:

           [ ] User ID
           [ ] API key ID
           [ ] Provider ID
           [ ] Request ID
           [ ] Backup ID
           [ ] Session ID
           [ ] Audit-event ID

         Never rely on:

           "The ID is difficult to guess."

         Always enforce server-side ownership.


========================================================================
PHASE 14 - DOS RESILIENCE
========================================================================

SEC-041  CONNECTION LIMITS
         Priority: MEDIUM

         Protect:

           [ ] HTTP connections
           [ ] WebSocket connections
           [ ] MCP connections
           [ ] Provider connections
           [ ] Concurrent requests

         Configure:

           [ ] Maximum global connections
           [ ] Maximum connections per IP
           [ ] Maximum connections per API key
           [ ] Maximum connections per user


SEC-042  STREAMING RESOURCE PROTECTION
         Priority: HIGH

         Protect streaming requests against:

           [ ] Infinite streams
           [ ] Slow clients
           [ ] Slow providers
           [ ] Large responses
           [ ] Abandoned connections
           [ ] Connection leaks

         Require:

           [ ] Maximum stream duration
           [ ] Maximum output bytes
           [ ] Idle timeout
           [ ] Backpressure
           [ ] Proper cancellation


SEC-043  MEMORY EXHAUSTION TESTING
         Priority: HIGH

         Stress test:

           [ ] Large JSON
           [ ] Many messages
           [ ] Large tool definitions
           [ ] Large provider responses
           [ ] Many simultaneous requests
           [ ] Many WebSockets
           [ ] Many MCP connections
           [ ] Large configuration imports

         Verify:

           [ ] Memory remains bounded
           [ ] Requests are rejected before allocation becomes excessive
           [ ] Process remains responsive
           [ ] Graceful degradation occurs


========================================================================
PHASE 15 - RELEASE SECURITY
========================================================================

SEC-044  REPRODUCIBLE RELEASE BUILD
         Priority: MEDIUM

         Work toward:

           Source
             |
             v
           Deterministic build
             |
             v
           Identical artifact

         Requirements:

           [ ] Pin build dependencies
           [ ] Pin runtime versions
           [ ] Record build environment
           [ ] Record source commit
           [ ] Verify generated artifacts


SEC-045  RELEASE SECURITY MANIFEST
         Priority: LOW

         Every release should publish:

           [ ] Version
           [ ] Git commit
           [ ] Build timestamp
           [ ] Runtime version
           [ ] Dependency versions
           [ ] SBOM
           [ ] Checksums
           [ ] Signature
           [ ] Security status

         Example:

           ClawRouter 1.1.0
           Security baseline: PASS
           SBOM: INCLUDED
           Signature: VERIFIED
           Critical vulnerabilities: 0
           High vulnerabilities: 0


SEC-046  SECURITY CHANGELOG
         Priority: LOW

         Every release should explicitly document:

           [ ] Security fixes
           [ ] Security improvements
           [ ] Dependency security updates
           [ ] Breaking security changes
           [ ] New security configuration
           [ ] Deprecated insecure behavior


========================================================================
PHASE 16 - SECURITY DOCUMENTATION
========================================================================

SEC-047  THREAT MODEL
         Priority: HIGH

         Create:

           docs/security/threat-model.md

         Document:

           [ ] Assets
           [ ] Trust boundaries
           [ ] Attackers
           [ ] Attack surfaces
           [ ] Security assumptions
           [ ] Security controls
           [ ] Residual risks

         Core assets:

           Provider credentials
           API keys
           User accounts
           Sessions
           Prompts
           Responses
           Usage data
           Audit logs
           Encryption key
           Backups
           Host system


SEC-048  SECURITY ARCHITECTURE
         Priority: HIGH

         Create:

           docs/security/architecture.md

         Document:

           Internet
              |
              v
           Reverse Proxy
              |
              v
           HTTP Security Layer
              |
              +--> Authentication
              |
              +--> Authorization
              |
              +--> CSRF
              |
              +--> Rate Limiting
              |
              +--> Resource Limits
              |
              v
           ClawRouter Core
              |
              +--> Admin API
              |
              +--> Gateway API
              |
              +--> MCP
              |
              v
           Outbound Security Layer
              |
              +--> URL validation
              +--> DNS validation
              +--> SSRF protection
              +--> TLS
              +--> Timeout
              |
              v
           AI Providers


SEC-049  SECURITY DEPLOYMENT GUIDE
         Priority: HIGH

         Create deployment-specific guides:

           [ ] Docker
           [ ] systemd
           [ ] nginx
           [ ] Caddy
           [ ] Cloudflare
           [ ] LAN-only deployment
           [ ] Internet-facing deployment

         Document:

           [ ] Firewall requirements
           [ ] TLS requirements
           [ ] Reverse-proxy configuration
           [ ] Trusted proxies
           [ ] File permissions
           [ ] Backup security
           [ ] Secret management
           [ ] Recommended network topology


========================================================================
PHASE 17 - RESPONSIBLE DISCLOSURE
========================================================================

SEC-050  SECURITY POLICY
         Priority: HIGH

         Create:

           SECURITY.md

         Include:

           [ ] Supported versions
           [ ] Vulnerability reporting method
           [ ] Expected response time
           [ ] Security disclosure process
           [ ] CVE process
           [ ] Security update policy


SEC-051  SECURITY ADVISORIES
         Priority: MEDIUM

         Establish a process for:

           Vulnerability discovered
                    |
                    v
           Private investigation
                    |
                    v
           Fix developed
                    |
                    v
           Regression test added
                    |
                    v
           Patch released
                    |
                    v
           Advisory published

         Advisory should contain:

           [ ] Affected versions
           [ ] Fixed versions
           [ ] Severity
           [ ] Attack requirements
           [ ] Impact
           [ ] Mitigation
           [ ] Upgrade instructions


========================================================================
FINAL SECURITY GATE
========================================================================

Before declaring a release "SECURITY HARDENED":

  [ ] SEC-001  SSRF protection
  [ ] SEC-002  MCP security audit
  [ ] SEC-003  Backup/restore security
  [ ] SEC-004  Container hardening

  [ ] SEC-005  Cost-based rate limiting
  [ ] SEC-006  Request resource limits
  [ ] SEC-007  Provider TLS enforcement
  [ ] SEC-008  DNS rebinding protection

  [ ] SEC-009  Request-data minimization
  [ ] SEC-010  Secret scrubbing
  [ ] SEC-011  Backup credential separation

  [ ] SEC-012  Security regression suite
  [ ] SEC-014  Authorization matrix
  [ ] SEC-015  WebSocket security

  [ ] SEC-017  Configuration import sandbox

  [ ] SEC-018  Dependency security
  [ ] SEC-019  SBOM
  [ ] SEC-020  Signed releases

  [ ] SEC-021  Fuzz testing

  [ ] SEC-024  systemd hardening
  [ ] SEC-025  Security health check

  [ ] SEC-026  Security CI
  [ ] SEC-027  Security regression corpus

  [ ] SEC-028  Security event model
  [ ] SEC-029  Security alerting

  [ ] SEC-032  CORS security
  [ ] SEC-033  API error hardening

  [ ] SEC-035  Provider isolation
  [ ] SEC-036  Provider response validation
  [ ] SEC-037  Provider timeouts
  [ ] SEC-038  Provider retry protection

  [ ] SEC-039  Resource ownership testing
  [ ] SEC-040  IDOR audit

  [ ] SEC-041  Connection limits
  [ ] SEC-042  Streaming protection
  [ ] SEC-043  Memory exhaustion testing

  [ ] SEC-047  Threat model
  [ ] SEC-048  Security architecture
  [ ] SEC-049  Security deployment guide

  [ ] SEC-050  Security policy
  [ ] SEC-051  Security advisory process


========================================================================
RECOMMENDED IMPLEMENTATION ORDER
========================================================================

                    +----------------------+
                    | PHASE 1              |
                    | Network Boundary     |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 2              |
                    | AI Abuse Protection  |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 3              |
                    | Data Protection      |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 4              |
                    | Security Testing     |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 5              |
                    | Configuration        |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 6              |
                    | Supply Chain         |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 7              |
                    | Advanced Security    |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 8              |
                    | Host Hardening       |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 9              |
                    | Continuous Security  |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 10             |
                    | Observability        |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 11             |
                    | API Security         |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 12             |
                    | Provider Security    |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 13             |
                    | Data Isolation       |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 14             |
                    | DoS Resilience       |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 15             |
                    | Release Security     |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 16             |
                    | Documentation        |
                    +----------+-----------+
                               |
                               v
                    +----------------------+
                    | PHASE 17             |
                    | Disclosure Program   |
                    +----------------------+
                               |
                               v
                    +----------------------+
                    | SECURITY HARDENED    |
                    +----------------------+


========================================================================
SECURITY PRINCIPLE
========================================================================

  Treat every boundary as hostile:

      Internet
          |
          v
      Reverse Proxy       <-- untrusted
          |
          v
      HTTP API            <-- untrusted
          |
          v
      Authentication
          |
          v
      Authorization
          |
          v
      MCP / Gateway       <-- untrusted input
          |
          v
      Core Services
          |
          v
      Provider URLs       <-- untrusted destination
          |
          v
      External Providers  <-- untrusted response
          |
          v
      Database / Files
          |
          v
      Host System

  Security controls must be enforced at every boundary.

========================================================================
```
