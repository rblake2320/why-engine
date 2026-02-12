# Security Policy

## Data Handling Guarantees
- If secrets are detected (regex or gitleaks), the outbox record is **stub-only** (hashes + metadata only).
- API publishing is **blocked by default** when secrets are detected.
- Tokens/credentials are never written to disk.

## Reporting
If you find a vulnerability or a way to bypass the secret gates, open a GitHub issue with minimal reproduction steps.
Do not post real secrets or customer data in issues.
