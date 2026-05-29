# Changelog

All notable changes to this project will be documented in this file.

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
