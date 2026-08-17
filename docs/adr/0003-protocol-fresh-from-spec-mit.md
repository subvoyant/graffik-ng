# ADR-0003: Implement the protocol fresh from spec — MIT license

**Status:** Accepted
**Date:** 2026-08-15
**Deciders:** Project owner (explicit choice)

## Context

All prior Graffik-family code is GPL (Legacy app GPLv3, OpenMoCo lib LGPLv3, reboot GPLv3, iOS app GPLv2, firmware GPLv3). Porting/translating any of it line-by-line makes our code a derivative work and locks the license. However, the **protocol itself** is fully specified by non-code artifacts: the official PDFs shipped inside the firmware repo (`NMX Commands 0.13 w-data types.pdf`, `MotionEngineProtocol.pdf`), `Sample Commands.txt` (literal packets), and the observable dispatch behavior of the firmware.

## Decision

Write all protocol code as **original expression against the spec**, validated byte-for-byte against `Sample Commands.txt` and the firmware dispatch. License the codebase **MIT**. GPL sources are read for *facts* (command numbers, sequencing, units), never copied or mechanically translated. Where an algorithm's *behavior* must match (e.g., keyframe velocity solving), reimplement the math independently (our solver uses bisection where the iOS app uses linear increment — same boundary, original expression).

## Consequences

- The codebase can be relicensed, embedded, or dual-licensed freely; contributors face no copyleft barrier.
- Every command builder carries a provenance tag (`[S]`ample / `[F]`irmware / `[R]`eboot-observed) so "fresh from spec" is auditable.
- Discipline required: future contributors must not paste GPL code in. CONTRIBUTING must state this.
- Moral attribution to Dynamic Perception, LLC is maintained in README regardless of license freedom.
