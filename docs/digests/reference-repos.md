# Digest: external ground truth (reference repos)

**Verified against** upstream clones @ 2026-08-15. These are read for FACTS only — no code copying (ADR-0003). Clone fresh when needed: `git clone https://github.com/DynamicPerception/<name>.git`

| Repo | What it is | Use it for |
|---|---|---|
| **nanoMoCo_Firmware** | The NMX firmware (Arduino/AVR, GPLv3, last commit Nov 2018) | **Protocol ground truth** (ADR-0004). Dispatch: `Firmware/Motion_Engine/OM_Serial_Com_Client.ino` — `serCommandHandler` routes subaddr → `serMain`/`serMotor`/`serCamera`/`serKeyFrame`; each `case N:` is a command. KF engine: `OM_KeyFrameControl.ino`. In-tree docs: `NMX Commands 0.13 w-data types.pdf`, `MotionEngineProtocol.pdf`, `Sample Commands.txt` (literal packets; two entries stale vs dispatch). `SERIAL_VERSION = 70` in `Motion_Engine.ino`; `USBSerial.begin(19200)`. |
| **OMLibraries** | AVR-side MoCoBus lib | Broadcast enum: `OMMoCoBus/OMMoCoDefs.h` (start 1/stop 2/pause 3/setAddr 4/graffikUSB 5/graffikBLE 6/kfStart 7/kfStop 8/kfPause 9/getAddr 10). `ntof` = big-endian IEEE754 float. |
| **nmx-motion-ios** | Official mobile app source (GPLv2, Jul 2017) | **KF engine usage playbook.** Composition: `Joystick/ReviewStatusViewController.m` `initKeyFrameValues` (per-axis upload order; 3-point moves). Velocity solver behavior: `Joystick/HSpline.m` (`optimizePointVelForAxis` — increment until `reverses`, 100-sample check). Run: `takeUpBacklash → setControllerCount → startKeyFrameProgram`. 2-point moves bypass KF → `mainStartPlannedMove`. Positions scaled ×(microstep/16). |
| **Graffik** (reboot, 2015) | Qt5/QML NMX app, unfinished (GPLv3) | Reference NMX client: `motionController.{h,cpp}` (~1.1k lines). Beware: its cmd 25 usage is stale (now lead-out). Baud never set (bug). |
| **Graffik_Legacy** (2011-15) | Qt 4.8.1 nanoMoCo app (GPLv3) | **UX/feature reference only** — cannot drive NMX (no sub-address). Film exec concepts: `gui/film/FilmExec`, `JogControlManager`, `MotionArea` spline editing. |
| **NMXComs / NMXCommander** | Official Java serial API + CLI (2016) | Cross-check protocol behavior questions. |
| djordan2/Graffik, thisdroneeatspeople/Graffik | Forks of Legacy | Nothing unmerged — ignore. |

Also delivered into the Claude project chat: the two protocol PDFs extracted from the firmware repo (authoritative command tables).
