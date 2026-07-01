# WHY.md - Project Rationale & Fix Intelligence

This file makes important design rationale and reusable fix intelligence visible
to humans and agents reading the repository. It is a projection layer over the
Why Engine, not a replacement for the structured `.why-engine/` case store.

## Architectural Decisions

### [WHY-001] Why file-based outbox over direct API publish as the default

- **Date:** 2026-06-15
- **Status:** Accepted
- **Context:** The engine must publish safely from environments where network
  access may be restricted, secrets may be present, or an operator has not yet
  reviewed prose for sensitivity.
- **Decision:** Outbox-first is the safe default. API publish requires explicit
  target selection and `--dry-run false`.
- **Rejected Options:** Direct API publish by default; SQLite-only local store.
- **Why This Holds:** A plain file outbox is inspectable, replayable, and easy to
  scan before anything leaves the repo boundary.
- **Consequences:** Operators do one extra review step, but the default path is
  CI-safe and audit-friendly.

### [WHY-002] Why content-hash idempotency keys instead of UUIDs

- **Date:** 2026-06-15
- **Status:** Accepted
- **Context:** Agents and CI jobs may retry the same incident capture. Random IDs
  would create duplicates for the same root cause.
- **Decision:** `computeIdempotencyKey` hashes repo remote, commit range, title,
  and root cause.
- **Rejected Options:** Random UUIDs; timestamp-based keys.
- **Why This Holds:** The key is deterministic and verifiable offline.
- **Consequences:** Editing one of the hash inputs creates a new case. Treat
  analyzed cases as immutable.

### [WHY-003] Why the quality gate is separate from schema validation

- **Date:** 2026-06-15
- **Status:** Accepted
- **Context:** Schemas prove the fields exist and have the right shape. They do
  not prove that prose like "bug" or "fixed it" contains useful root-cause
  intelligence.
- **Decision:** `quality-gate.ts` runs inside `analyzeWhyCase()` before a case is
  written.
- **Rejected Options:** Zod-only validation; post-write linting.
- **Why This Holds:** Semantic quality failures need human-readable guidance and
  must fail before durable storage.
- **Consequences:** Tests and users must write real causal prose, not placeholders.

### [WHY-004] Why WHY.md has two separate sections

- **Date:** 2026-06-15
- **Status:** Accepted
- **Context:** Dark code has two causes: missing design rationale and missing
  explanation of why fixes held.
- **Decision:** Keep proactive design rationale in Architectural Decisions and
  incident-derived lessons in Fix Intelligence.
- **Rejected Options:** One flat section; separate rationale files.
- **Why This Holds:** The authorship boundary stays clear: humans/agents write
  design decisions, and reviewed WhyCases feed fix intelligence.
- **Consequences:** Agents can load one file without mixing proactive decisions
  with incident reports.

### [WHY-005] Why the content classifier is separate from the secret scanner

- **Date:** 2026-06-15
- **Status:** Accepted
- **Context:** Secret scanners catch structured credentials. They do not classify
  sensitive operational prose such as enclave failure modes, auth bypass details,
  or internal topology.
- **Decision:** `content-classifier.ts` runs on narrative fields before publish.
- **Rejected Options:** Regex-only expansion inside the secret scanner; manual
  sensitivity tagging only.
- **Why This Holds:** Structured credentials and sensitive prose are different
  risk classes and need separate reporting.
- **Consequences:** API publish can be blocked even when no literal token or key
  is present.

### [WHY-006] Why torn-tail repair quarantines instead of deleting

- **Date:** 2026-07-01
- **Status:** Accepted
- **Context:** fsync'd appends make acknowledged writes durable, but a crash
  *during* an append can still leave a partial final line. That torn tail is
  expected crash residue, not tampering — yet an audit system must never
  silently discard bytes.
- **Decision:** `repairAuditChain` moves the torn bytes to a timestamped
  quarantine file, rewrites the log atomically, and chains a
  `why.audit_repair` entry so the repair is itself on the audit record.
- **Rejected Options:** Silent truncation; refusing all repair; auto-repair of
  any broken entry.
- **Why This Holds:** A malformed *final* line is the unique signature of a
  crash mid-append. Any mid-log defect is evidence of tampering or bit rot and
  is deliberately not auto-repairable.
- **Consequences:** Operators may see quarantine files after crashes; those
  files are the proof the repair touched nothing else.

### [WHY-007] Why recall is lexical TF-IDF instead of embeddings

- **Date:** 2026-07-01
- **Status:** Accepted
- **Context:** The killer query is "have we seen this failure before?" asked
  from CI, air-gapped environments, and agent loops. Failure symptoms are
  dominated by rare, exact tokens: error codes, file paths, stack frames.
- **Decision:** Field-weighted TF-IDF with a tokenizer that preserves compound
  identifiers (paths, error codes) alongside their parts. Zero dependencies,
  zero network, deterministic, works offline.
- **Rejected Options:** Embedding models (network or heavy local deps, breaks
  IL5/air-gap posture); SQLite FTS (adds a native dependency).
- **Why This Holds:** ENOENT matching ENOENT beats semantic similarity for
  incident recall, and determinism means the same query always returns the
  same evidence.
- **Consequences:** Paraphrase-only matches score lower than exact-symptom
  matches. An optional embedding layer can be added later without changing the
  recall contract.

### [WHY-008] Why the advisory lock uses mkdir instead of a lockfile or native flock

- **Date:** 2026-07-01
- **Status:** Accepted
- **Context:** CLI, MCP server, and web backend can write the same
  `.why-engine` store concurrently. Interleaved appends would fork the hash
  chain.
- **Decision:** `withLock` acquires via atomic `mkdir`, records owner
  metadata, and breaks locks whose mtime exceeds a staleness threshold.
- **Rejected Options:** `flock` (needs native deps or platform-specific
  behavior); O_EXCL lockfiles (equivalent but leaves less room for owner
  metadata); no locking (status quo, unsound).
- **Why This Holds:** Directory creation is atomic on every platform Node
  supports, requires no dependencies, and stale-breaking handles crashed
  holders without operator intervention.
- **Consequences:** Locks are advisory: only code that goes through
  `withLock` is protected, which all engine write paths now do.

## Fix Intelligence

Promoted from reviewed WhyCases where `generalizablePattern` is non-empty,
`sensitivity === "public"`, the quality gate score meets the threshold, and
content classification does not block promotion.

Use:

```bash
why-engine promote-why --repo-path .                    # dry-run by default
why-engine promote-why --repo-path . --dry-run false    # write to WHY.md
```

_(No fix intelligence entries yet - run promote-why after a reviewed public WhyCase has a generalizablePattern.)_
