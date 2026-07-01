# Why Engine

Standalone CLI + MCP server for capturing root-cause analyses, sanitizing evidence, and publishing safe, idempotent "why cases" to aihangout.ai.

## Safe Publish Modes

- **Default mode (recommended):** `--target outbox` writes to `.why-engine/outbox/<idempotencyKey>.json` with dedupe via ledger.
- **Secrets present:** outbox **always** writes a stub-only record (hashes + metadata only) and blocks API publish.
- **Sensitive prose present:** content classification can block API publish even when no literal token/key is present.
- **API publish:** use `--target api` or `--target both` with `--dry-run true` first; require `--problem-id` initially to avoid creating new problems by accident.
- **History:** optional `--keep-history` writes `.why-engine/outbox/history/<idempotencyKey>-<timestamp>.json`.


## Recall: Institutional Memory for Agents and Humans

The store is no longer write-only. Before attempting a fix, ask whether this failure has happened before:

```bash
why-engine search --repo-path . --query "ECONNRESET during retry storm in api client"
why-engine search --repo-path . --query "torn audit line after crash" --tags durability --json
```

Agents get the same capability via the MCP tool `why.recall` — call it with the raw error message or stack trace before writing a fix. Matching is field-weighted TF-IDF (titles, root causes, tags, error snippets weighted highest), fully offline and deterministic.

## Store Health & Crash Recovery

```bash
why-engine doctor --repo-path .          # 8-point health check, exit 1 on failure
why-engine doctor --repo-path . --fix    # quarantine a torn audit tail (auditable repair)
why-engine stats  --repo-path .          # totals, tags, recurring root-cause clusters
why-engine audit-repair --repo-path .    # repair-only entrypoint
```

Durability guarantees in v0.2.0: audit appends are fsync'd and lock-serialized across processes; case, outbox, and ledger writes are atomic (readers never see partial files); a crash mid-append leaves a *classified, repairable* torn tail rather than an unreadable log; mid-log corruption remains non-repairable tamper evidence. Recurring clusters in `stats` flag the same root cause happening twice — a prevention that did not hold.

## WHY.md Promotion

`WHY.md` is the reviewed, human/agent-readable surface for project rationale.
Architectural decisions are written proactively. Fix Intelligence is promoted from
public WhyCases with a meaningful `generalizablePattern`.

```bash
why-engine promote-why --repo-path .                    # dry-run by default
why-engine promote-why --repo-path . --dry-run false    # write qualifying cases
```

Promotion requires the quality gate to pass, the score to meet `--min-score`
(default `70`), `sensitivity === "public"`, and content classification to allow
publication.

## Updates & Fixes in v0.2.0

- Recall engine (`search`/`why.recall`), `stats` with recurring-cluster detection, `doctor --fix`, `audit-repair`.
- Crash-safe audit chain: fsync + cross-process locking + O(1) appends + torn-tail repair with quarantine.
- Atomic writes everywhere (cases, outbox, ledger). 83-test suite. Fully backwards compatible with v0.1.x stores.

## Updates & Fixes in v0.1.3

- **Full Command Parity**: Added `verify-audit` command alias to resolve web-to-CLI invocation mismatches.
- **Outbox Detail Retrieval**: Fixed the critical outbox page 404 by adding fallback routing lookup on `idempotencyKey`.
- **Advanced Secret Redaction**: Recursive deep object and array traversal scanner to detect and redact Stripe keys, JWT tokens, GitHub tokens, and DB connection strings.
- **Testing Coverage**: Expanded the test suite from 11 tests to **50 tests** covering all CLI endpoints, tamper detection, and security constraints.
