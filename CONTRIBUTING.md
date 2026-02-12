# Contributing

## Guardrails
- Do not add bypass flags that allow publishing secrets.
- Keep outbox records stub-only when secrets are detected.
- Never write tokens or credentials to disk.

## Development
- Run `npm test` before submitting changes.
- Keep changes minimal and focused on the requested scope.
