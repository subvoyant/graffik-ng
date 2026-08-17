# ADR-0007: All serial I/O in the Electron main process; renderer gets a narrow IPC surface

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Claude (architecture), standing convention

## Context

The plan's oldest guardrail: keep a clean seam between the motion/comms core and the UI so the core is testable headless and reusable (CLI, scripted shoots, BLE later). In Electron, the natural enforcement is the process boundary.

## Decision

The renderer never touches serial, `nmx-protocol`, or Node APIs. All hardware access lives in the **main process** (`main.js`), exposed via `contextBridge` (`preload.cjs`) as a small `window.nmx` API of intent-level operations (connect, jog, markStart, armMove, runPass, stopAll…), not raw packet passing. `contextIsolation: true`, `nodeIntegration: false` — non-negotiable. The protocol core itself depends on nothing but a `PortLike` duplex, so `NmxClient` runs identically against a real `SerialPort`, the `SimulatedNmx`, or a future BLE transport.

## Consequences

- The simulator plugs in at the `PortLike` seam → full end-to-end tests and the app's demo mode share one fake.
- IPC surface is the app's API contract; digest `jog-slice.md` maintains the channel table.
- Intent-level IPC means renderer compromise can't emit arbitrary packets — relevant once we load remote content (we don't today).
- Cost: every new UI capability needs an IPC handler + preload entry; accepted as the price of the seam.
