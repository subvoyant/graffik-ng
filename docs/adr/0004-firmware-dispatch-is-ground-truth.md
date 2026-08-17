# ADR-0004: The 2018 firmware dispatch source is protocol ground truth

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Claude (recon finding), ratified by project direction

## Context

The historical protocol references **disagree with each other** because they snapshot different firmware eras. Confirmed conflicts: `Sample Commands.txt` shows program-mode as byte `0x22` while shipping firmware dispatches it at general cmd 22 (`0x16`); motor cmd 10 changed meaning entirely ("steps per interval" → "set end limit here"); the 2015 reboot app's motor cmd 25 ("send to start") is now "set lead-out" — a command that would silently do the wrong thing mid-shoot.

## Decision

`DynamicPerception/nanoMoCo_Firmware` @ master (`OM_Serial_Com_Client.ino` dispatch: `serMain`/`serMotor`/`serCamera`/`serKeyFrame`, plus `OMLibraries/OMMoCoBus/OMMoCoDefs.h` for broadcast constants) is the **single source of truth** for command numbers, payload types, and response behavior. Older references are used only where the firmware is silent, and every deviation from a historical source is documented in code comments.

Corollary: **the client queries firmware version at connect** (`handshake()`), because a user's NMX running pre-2018 firmware has a different command map. The device should be updated to the last official firmware before programmed moves are trusted.

## Consequences

- Byte-exact tests cite which source verified each command; two tests intentionally deviate from `Sample Commands.txt` with the reason inline.
- If a user's hardware reports an unexpected firmware version, the correct response is *warn/refuse*, not *guess* — resolution is a firmware update from the same repo.
- We keep the ability to build and flash the firmware ourselves (it's open, GPLv3) as a long-term escape hatch.
