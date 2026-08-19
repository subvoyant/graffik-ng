# ADR Index

Immutable decision records. Accepted = in force. Supersede, never edit. See ADR-0000 for the operating model.

| # | Title | Status |
|---|---|---|
| [0000](0000-adopt-adrs-and-digest-system.md) | Adopt ADRs + digest knowledge system | Accepted |
| [0001](0001-rebuild-fresh-not-fork-legacy.md) | Rebuild fresh instead of forking Graffik_Legacy | Accepted |
| [0002](0002-platform-typescript-electron.md) | Platform: TypeScript + Electron, headless protocol core | Accepted |
| [0003](0003-protocol-fresh-from-spec-mit.md) | Protocol fresh from spec — MIT license | Accepted |
| [0004](0004-firmware-dispatch-is-ground-truth.md) | 2018 firmware dispatch is protocol ground truth | Accepted |
| [0005](0005-determinism-lives-in-firmware.md) | Determinism lives in firmware; host orchestrates | Accepted |
| [0006](0006-engine-selection-2point-vs-keyframe.md) | Classic engine for 2-point, KF engine for 3+ | Accepted (pending hardware ratification) |
| [0007](0007-serial-in-main-process-only.md) | All serial I/O in Electron main process | Accepted |
| [0008](0008-dependency-hygiene-electron-xprotect.md) | Dependency hygiene: current Electron, allowScripts, XProtect | Accepted |
| [0009](0009-single-source-motion-math.md) | Timeline preview and firmware program share one solver | Accepted |
| [0010](0010-film-file-format.md) | Versioned `.graffik` JSON move files, schema in core | Accepted |
| [0011](0011-commit-lockfiles-npm-ci.md) | Commit lockfiles; CI installs with `npm ci` | Accepted |
| [0012](0012-ui-design-system.md) | UI design system: 3D-app idiom, validated axis palette | Accepted |
| [0013](0013-soft-limits-host-enforced.md) | Soft travel limits, enforced host-side | Accepted |
| [0014](0014-timecode-and-timebase.md) | Frames are the authoring unit; SMPTE timecode is the display | Accepted |
| [0015](0015-3d-export-usd-and-chan.md) | 3D camera export via OpenUSD + `.chan`, not Alembic | Accepted (calibration pending hardware) |
| [0016](0016-timeline-events-and-trigger-backends.md) | Timeline events; host- vs device-scheduled tiers | Accepted (backends staged) |
| [0017](0017-lens-axes-focus-iris-zoom.md) | Lens axes: normalised travel + witness marks, driven device-side | Accepted (§5 motor `invert` superseded by 0018) |
| [0018](0018-lens-device-protocol-v2.md) | GRAFFIK-TRIG v2: decimated lens curves, mandatory calibration, schema v4 | Accepted (unverified against a motor) |
| [0019](0019-lens-library.md) | Lens library: marks belong to a lens, merged by id, never replaced | Accepted |
| [0020](0020-commissioning-measured-not-guessed.md) | Commissioning: the app measures the rig — spans, spread, and named suspects | Accepted |
| [0021](0021-physical-controls-stop-is-instant.md) | Physical controls: stopping is instant, starting is a hold | Accepted (unverified against a controller) |
| [0022](0022-connection-doctor.md) | Connection doctor: silence vs noise, every address asked, ranked ports | Accepted (unverified against an NMX) |
| [0023](0023-first-motion-creep-and-the-bringup-report.md) | Creep on an untaught axis; a bring-up report that states what is still unknown | Accepted |
| [0024](0024-dead-export-audit.md) | Dead-export audit: "tested" is not "reachable" | Accepted |
| [0025](0025-playhead-follows-the-pass.md) | Playhead follows a running pass, anchored to the firmware's clock | Accepted |
| [0026](0026-partial-execution-refuse-or-say-so.md) | Partial execution: a headless runner refuses, a supervised UI says so and proceeds | Accepted |
| [0027](0027-the-flight-recorder.md) | The flight recorder: record every pass, compare at matched percent, state the resolution floor | Accepted (unverified against hardware) |
| [0028](0028-plan-type-and-what-percent-means.md) | Plan type is CONT_VID: it decides what percent complete is divided by | Accepted (unverified against hardware) |
