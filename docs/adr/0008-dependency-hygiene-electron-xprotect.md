# ADR-0008: Dependency hygiene — current-stable Electron only; npm allowScripts; XProtect posture

**Status:** Accepted
**Date:** 2026-08-16
**Deciders:** Project owner + Claude (post-incident)

## Context

First-launch bring-up on the owner's Mac (macOS Tahoe, Node 26, npm ≥11.19) surfaced three field realities: (1) npm's v12-era **allowScripts** policy blocks install scripts by default — Electron's binary download and serialport's native-binding install silently don't run until approved, and approvals are **version-pinned** (re-approve after upgrades). (2) Our original pin, Electron 31 (EOL Jan 2025), was **flagged as malware by macOS XProtect and auto-trashed** — matching the documented false-positive pattern that hit OpenAI's Codex CLI and Docker Desktop, where stale unsigned dev binaries trip newer detection signatures. (3) Upgrading to current-stable Electron 43 resolved it instantly and also cleared the npm-audit highs.

## Decision

- Pin Electron to **current stable** (`^43.4.0` as of this writing); check `endoflife.date/electron` at every bump; never ship or scaffold an EOL major.
- Document the allowScripts approvals (`electron`, `@serialport/bindings-cpp`) in setup docs; re-approve on every Electron upgrade.
- **Never bypass an XProtect positive detection** (`xattr`, Gatekeeper overrides) — the remedy is fresh, current binaries. If *current* Electron is ever flagged: stop, investigate, report to Apple; do not launch.
- Phase 4 (code-sign + notarize) is the structural fix that removes this whole class of friction for end users; its priority is reaffirmed.

## Consequences

- Slightly faster Electron upgrade treadmill (majors every ~4 months); accepted.
- Setup instructions must never put shell comments on copy-paste command lines (two real incidents: args leaked into `vitest` filters and `ls`).
- Onboarding docs carry the full bring-up pothole list (Homebrew dylib drift, allowScripts, `path.txt`, XProtect).
