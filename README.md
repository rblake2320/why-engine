# Why Engine

Standalone CLI + MCP server for capturing root-cause analyses, sanitizing evidence, and publishing safe, idempotent "why cases" to aihangout.ai.

## Safe Publish Modes

- **Default mode (recommended):** `--target outbox` writes to `.why-engine/outbox/<idempotencyKey>.json` with dedupe via ledger.
- **Secrets present:** outbox **always** writes a stub-only record (hashes + metadata only) and blocks API publish.
- **API publish:** use `--target api` or `--target both` with `--dry-run true` first; require `--problem-id` initially to avoid creating new problems by accident.
- **History:** optional `--keep-history` writes `.why-engine/outbox/history/<idempotencyKey>-<timestamp>.json`.
