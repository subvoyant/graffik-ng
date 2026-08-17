# ADR-0011: Commit lockfiles; CI installs with `npm ci`

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Project owner (audit finding) + Claude

## Context

The initial `.gitignore` (v0.4.0, first commit) excluded `package-lock.json`. That
was a mistake, caught in the owner's post-push repo audit. Without committed
lockfiles, every CI run and every fresh clone re-resolved dependency versions from
scratch: builds were not reproducible, a green CI run said nothing about the tree a
developer would get tomorrow, and a compromised or broken transitive release could
enter silently. This project already has a documented history of dependency-supply
pain (ADR-0008: npm allowScripts policy, XProtect flagging a stale Electron), which
raises the value of pinning exactly what was tested.

The counter-argument — lockfiles cause merge conflicts and churn — applies mainly to
libraries published for others to resolve against. This repo ships **applications**
(an Electron app, a CLI); the ecosystem convention for applications is to commit them.

## Decision

Commit `package-lock.json` for every package in the repo. CI installs with **`npm ci`**
(not `npm install`) so it fails loudly on lockfile/manifest drift instead of silently
resolving something new, and `actions/setup-node` caches on `**/package-lock.json`.
The first commit was amended in place (single commit, no collaborators yet) rather
than adding a follow-up "oops" commit.

## Options Considered

**A. Keep lockfiles ignored** — smaller diffs, no conflict noise. Rejected: gives up
reproducibility on an app repo, and this project's dependency risk profile is
demonstrably nonzero.
**B. Commit lockfiles, keep `npm install` in CI** — half measure; CI would still be
free to drift from the lockfile without complaint.
**C. Commit lockfiles + `npm ci` (chosen)** — CI installs exactly the audited tree, or
fails.

## Consequences

- CI is reproducible and faster (npm cache now has a key to hash).
- Dependency bumps become explicit, reviewable commits — which is the point.
- Cost accepted: lockfile merge conflicts on concurrent dependency changes; resolve by
  taking one side and re-running `npm install`.
- `npm ci` requires lockfile and `package.json` to stay in sync — a manifest edit
  without a matching install will now fail CI rather than pass quietly. Intended.
