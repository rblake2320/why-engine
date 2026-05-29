# Why Engine

Standalone CLI + MCP server for capturing root-cause analyses, sanitizing evidence, and publishing safe, idempotent "why cases" to aihangout.ai.

## Safe Publish Modes

- **Default mode (recommended):** `--target outbox` writes to `.why-engine/outbox/<idempotencyKey>.json` with dedupe via ledger.
- **Secrets present:** outbox **always** writes a stub-only record (hashes + metadata only) and blocks API publish.
- **API publish:** use `--target api` or `--target both` with `--dry-run true` first; require `--problem-id` initially to avoid creating new problems by accident.
- **History:** optional `--keep-history` writes `.why-engine/outbox/history/<idempotencyKey>-<timestamp>.json`.

## Updates & Fixes in v0.1.3

- **Full Command Parity**: Added `verify-audit` command alias to resolve web-to-CLI invocation mismatches.
- **Outbox Detail Retrieval**: Fixed the critical outbox page 404 by adding fallback routing lookup on `idempotencyKey`.
- **Advanced Secret Redaction**: Recursive deep object and array traversal scanner to detect and redact Stripe keys, JWT tokens, GitHub tokens, and DB connection strings.
- **Testing Coverage**: Expanded the test suite from 11 tests to **50 tests** covering all CLI endpoints, tamper detection, and security constraints.
