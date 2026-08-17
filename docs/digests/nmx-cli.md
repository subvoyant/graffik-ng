# Digest: packages/nmx-cli

**Verified against** `packages/nmx-cli/cli.js` @ 2026-08-17 (v0.4) · deps: core (file: symlink) + serialport

Headless runner sharing the exact core/solver/sequences as the app (ADR-0009/0010). Commands: `nmx ports` · `nmx info --port <p>|--sim` (handshake + firmware, warns ≠70) · `nmx run <file.graffik> --port <p>|--sim [--passes N] [--cue S] [--force]` (firmware-gated like the app; per pass: all axes → first keyframe, cue countdown, backlash+run, 1s progress poll) · `nmx stop --port <p>` (broadcast e-stop). SIGINT during run → e-stop then exit 130. `--force` bypasses the firmware gate (CLI equivalent of the app's override button).

Gaps: KF engine only (no classic 2-point runs); no camera control; single controller.
