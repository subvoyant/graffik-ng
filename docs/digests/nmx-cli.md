# Digest: packages/nmx-cli

**Verified against** `packages/nmx-cli/cli.js` @ 2026-08-19 (v0.20) · deps: core (file: symlink) + serialport

Headless runner sharing the exact core/solver/sequences as the app (ADR-0009/0010). Commands: `nmx ports` · `nmx info --port <p>|--sim` (handshake + firmware, warns ≠70) · `nmx run <file.graffik> --port <p>|--sim [--passes N] [--cue S] [--force] [--motion-only]` (firmware-gated like the app; per pass: all axes → first keyframe, cue countdown, backlash+run, 1s progress poll) · `nmx stop --port <p>` (broadcast e-stop). SIGINT during run → e-stop then exit 130. `--force` bypasses the firmware gate (CLI equivalent of the app's override button).

`nmx run` is **timecode-aware** (duration, cue and timebase come from `filmDurationMs`/`filmCueMs`/`timebaseLabel`, so a v2+ file reports `240f · 00:00:10:00 @ 24`, not milliseconds).

**What it refuses, and why (v0.20 — ADR-0026).** The CLI opens a link to the NMX and to nothing else. A `.graffik` can carry two subsystems that live on a GRAFFIK-TRIG board — timeline cues (ADR-0016) and lens axes (ADR-0018) — and until v0.19 `nmx run` loaded them, ignored them, and printed `pass complete`. It now **exits 1** naming each one, and runs only if the operator passes `--motion-only`, which is them saying it back. `scripts/check.sh` asserts both halves: the refusal, and a full `--motion-only` pass against the simulator (the only end-to-end exercise of the run path in CI).

**It is not a quieter app — it is an unguarded one.** Soft travel limits are enforced in the Electron main process against limits in *its* preferences (ADR-0013); the CLI cannot read them and does not enforce anything. It says so on every run. Do not let that line get deleted for being noisy.

Gaps: KF engine only (no classic 2-point runs); no camera control; single controller; no cue or lens execution (refused, above); **no limit enforcement of any kind** — note that the pre-pass `sendToPosition` to the first keyframe is a real unbounded move, not just the pass itself. (ADR-0023's untaught-axis creep cap has nothing to apply to here: there is no `nmx jog`.)
