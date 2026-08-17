# ADR-0002: Platform — TypeScript + Electron with a headless protocol core

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Project owner (explicit choice from presented options)

## Context

With ADR-0001 removing the inherited-codebase constraint, the platform was an open question. Requirements: (a) USB serial at 19200 baud; (b) ~10–20 Hz jog command rate (NOT hard real-time — the firmware executes moves, see ADR-0005); (c) a timeline/keyframe editor UI as the bulk of future work; (d) macOS-first signed/notarized distribution, Windows later; (e) maintainable by a small team with AI-assisted development.

## Decision

TypeScript everywhere. A **zero-dependency headless package `@graffik-ng/nmx-protocol`** containing all protocol knowledge, and an **Electron** shell (`apps/jog-slice`, later the full editor) consuming it. The core must never import Electron or serialport — it receives a `PortLike` duplex (see ADR-0007).

## Options Considered

| Option | Serial | Editor-UI velocity | Notarization | Windows | Verdict |
|---|---|---|---|---|---|
| Qt6 + C++ (original plan) | QSerialPort | Slowest; QML Controls 1 rebuild anyway | Manual | Good | Rational only when inheriting big working C++ — we aren't |
| **Electron + TS (chosen)** | node-serialport | Best (web canvas/SVG) | electron-builder, best-trodden | Nearly free | ✔ |
| Tauri + TS/Rust | serialport crate | Same web UI | Good | Good | Strong runner-up; revisit if bundle size ever matters |
| Swift/SwiftUI | ORSSerialPort | Good | Best | Full rewrite | Kills cross-platform goal |
| Python + PySide6 | pyserial | Medium | Weak | OK | Distribution pain |

## Trade-off Analysis

The classic anti-Node argument (GC jitter, no real-time guarantees) does not apply because determinism lives in the firmware (ADR-0005). Given that, UI-iteration speed dominates — and the keyframe/curve editor is the single strongest use case for web rendering tech. Cost accepted: ~150 MB app bundle, Chromium in the loop.

## Consequences

- macOS packaging (Phase 4) reduces to electron-builder + notarization config.
- A CLI or scripted-shoot runner falls out of the headless core for free.
- BLE control is future-possible (noble/WebBluetooth; the NMX has BLE — `nmx-motion-ios` proves the path).
- We own Electron version hygiene (see ADR-0008).
