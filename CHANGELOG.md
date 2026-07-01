# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-07-01

### Added
- **Recall engine** (`why-engine search`, MCP `why.recall`): the case store is now queryable institutional memory. Given an error message, stack trace, or symptom description, returns ranked prior cases with root causes, why the fixes worked, and prevention guidance. TF-IDF over field-weighted tokens, zero dependencies, deterministic, offline. Agents should call `why.recall` **before** attempting a fix.
- **Stats** (`why-engine stats`, MCP `why.stats`): fleet-level insight including recurring root-cause clusters — the same class of failure occurring twice means a prevention did not hold, the highest-value signal a root-cause system can surface.
- **Doctor** (`why-engine doctor [--fix]`, MCP `why.doctor`): eight-point store health check covering audit chain integrity, torn-tail classification, head-cache consistency, case/ledger/outbox referential integrity, stale locks, and gitleaks availability. `--fix` performs the one safe auto-repair (torn-tail quarantine).
- **`audit-repair` command**: quarantines a torn audit tail (never deletes), restores chain validity, and chains a `why.audit_repair` entry so the repair is itself auditable.
- **Durable filesystem core** (`src/core/durable-fs.ts`): atomic write (temp + fsync + rename + directory fsync), fsync'd appends, and cross-process advisory locks via atomic mkdir with stale-lock breaking.

### Changed
- **Audit chain is now crash-safe**: appends are fsync'd, serialized under an advisory lock, and resolve the previous hash in O(1) via a self-healing `audit.head` cache with tail-scan fallback (was O(n) full-file read per append).
- **Torn tails are diagnosed, not fatal**: `verifyAuditChain` classifies a malformed final line as a repairable torn tail instead of throwing; mid-log corruption remains non-repairable tamper evidence. Appending onto a torn tail is refused to prevent silent chain forks.
- All case, outbox, and ledger writes are atomic — readers can never observe a partially written file.
- MCP server version aligned with package version.

### Compatibility
- Audit logs written by v0.1.x verify unchanged and are extended seamlessly (covered by a dedicated regression test).


## [0.1.3] - 2026-05-29

### Added
- Comprehensive test coverage with 39 new test cases across CLI commands, audit chain tamper detection, outbox routing, and advanced secret scanner capabilities.
- Full local `gitleaks` tool integration in the test suite to verify high-fidelity secret scanning capabilities.
- Advanced parameter support in web backend/frontend client schemas (`keepHistory`, `allowSecrets`, `gitleaksMode`, `forceStub`, `evidenceLink`, etc.).

### Fixed
- **CLI Command Discrepancy**: Added a CLI command alias `verify-audit` (in addition to `verify-audit-chain`) to align perfectly with the web backend and MCP server command executions, resolving a 500 error when clicking "Verify" on the audit page.
- **Outbox Detail Routing**: Updated the backend outbox router and React frontend pages (`CaseCard` and `CaseDetail`) to correctly query and retrieve outbox cases by `idempotencyKey` as well as `caseId`, resolving a critical 404 error when navigating to individual case details.
- **Secret Scanner Redaction**: Enhanced the secret scanner to support robust recursive scanning of deep nested objects and arrays, ensuring zero leaks in restricted cases.
- **Web Package Build Errors**: Added missing TypeScript declaration dependencies (`@types/express`, `@types/cors`) in the web workspace packages to ensure a 100% clean compile.
