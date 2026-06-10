# GitHub Copilot Instructions

This repository's authoritative agent guidance lives in **[`AGENTS.md`](../AGENTS.md)** and [`CLAUDE.md`](../CLAUDE.md).
Read it before generating code. It defines the project boundary, stack, Linear
routing, branch/PR process, verification gates, and design standards for this repo.

Copilot does not auto-read `AGENTS.md`, so the key rules are restated here:

- **Never push directly to `main`.** Branch + PR per the workflow in `AGENTS.md`.
- **Match the existing stack and conventions** — read `package.json`/`AGENTS.md`
  before introducing new libraries, patterns, or styling.
- **Never hardcode or invent secrets/API keys.** Source them from `.env`.
- **Verify before claiming success** — run the smallest meaningful check
  (lint / type-check / build / tests) defined in `AGENTS.md`.
- **Use the existing design system / shared components** before adding new ones.

For anything not covered here, defer to `AGENTS.md` (and `CLAUDE.md` where present).
