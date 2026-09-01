---
applyTo: "**/*.ts,**/*.tsx"
---

# TypeScript Instructions

Use the existing strict TypeScript configuration and native Node test runner.
Prefer small, explicit functions over broad abstractions. Do not introduce
dependencies, Vitest globals, or browser-only types.

Preserve Takeout input immutability, safe streaming ZIP handling, SHA-256
deduplication, durable state, and recovery behavior. Add focused tests whenever
the change affects parsing, validation, state transitions, destructive guards,
or recovery.

When an issue explicitly supersedes existing behavior, implement its contract
only within the stated scope and update the corresponding tests and
documentation together.
