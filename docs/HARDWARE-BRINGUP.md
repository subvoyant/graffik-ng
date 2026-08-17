# Hardware bring-up & test protocol

The plan for the first session with a physical NMX, and for the replay-fidelity
comparison that ratifies [ADR-0006](adr/0006-engine-selection-2point-vs-keyframe.md).
Written **before** hardware arrives so the session is spent shooting, not deciding.

> Everything in this project has been verified against the firmware's published
> protocol, its own sample packets, its dispatch source, and a simulator — but
> **never against motors**. Treat step 1 as genuinely unknown.

## Before you plug anything in

- [ ] **Sanity-check the rig with the stock NMX Motion app.** Does it move? Does
      it repeat? This separates "our software is wrong" from "the hardware is
      dead" — a distinction that is miserable to untangle later.
- [ ] **Nothing precious on the rig.** No cinema camera for session 1. A phone or
      a sandbag stands in fine.
- [ ] **Know where the power switch is.** STOP ALL is a software path; the
      firmware watchdog is a second layer; your hand is the third.
- [ ] Confirm the slider is level and the carriage runs its full travel by hand.

## Phase 1 — first contact (~10 min)

| # | Action | Expected | If not |
|---|---|---|---|
| 1 | Plug NMX into USB, launch app, ↻ | A `/dev/tty.usbserial-*` or `usbmodem-*` appears | Try another cable (charge-only cables are the classic trap); power-cycle the NMX |
| 2 | Select it, **Connect** | Status: *Connected · Graffik mode on · joystick watchdog armed*; chip reads **fw v70** | See "firmware mismatch" below |
| 3 | Note the firmware number | — | **Record it in the decision log either way** |

**Firmware mismatch:** if the chip is red and reads anything but v70, programmed
moves are blocked by design ([ADR-0004](adr/0004-firmware-dispatch-is-ground-truth.md)) —
command numbers genuinely differ between firmware eras. Update the controller from
Dynamic Perception's `nanoMoCo_Firmware` repo before proceeding. Overriding the
gate is possible but means every command number is a guess.

## Phase 2 — first motion (~15 min)

Do this with **one axis at a time** and a hand near STOP ALL.

1. **Enable** motors. Listen: steppers energizing produce a faint hold current
   hum, and the carriage should resist being pushed by hand.
2. Set jog speed to **200 steps/s** (well below the 800 default) for the first move.
3. Tap — don't hold — **Slide +**. Expect a short, smooth move.
   - *Nothing moves:* check motor cabling; confirm Enable was pressed.
   - *Moves the wrong way:* note it; direction inversion is a config question, not a bug.
   - *Grinds/stalls:* speed too high for the load, or the carriage is binding.
4. Verify the **position readout** changes and returns plausible values.
5. Repeat for Pan and Tilt.
6. **Test STOP ALL mid-jog.** Hold a jog button, hit STOP ALL, confirm immediate halt.
   *Do this before trusting any programmed move.*
7. **Test the watchdog:** start a jog and quit the app (⌘Q). The motor should
   stop on its own within a second or two. This is the safety net that matters
   most if the host ever crashes mid-shot.

Only after step 6 and 7 pass should anything run unattended.

## Phase 3 — 2-point repeatability (~20 min)

The classic engine, simplest possible move.

1. Jog Slide to one end of the intended move → **Mark START**.
2. Jog to the other end → **Mark END**.
3. Duration 20 s → **Arm** → **⏮ All to start** → **▶ Run**.
4. Watch the whole pass. Note: does it accelerate smoothly? Does it stop cleanly?

**Repeatability measurement** — this is the number the whole project exists for:

- Tape a fine marker/needle to the carriage, and a strip of paper alongside it.
- Run **⏮ → ▶** five times. After each pass, mark the resting position.
- Measure the spread of the five marks.

| Spread | Reading |
|---|---|
| < 0.5 mm | Excellent — composites will line up invisibly |
| 0.5–2 mm | Usable; may need a stabilize pass in post |
| > 2 mm | Investigate: belt tension, missed steps (speed too high for load), or backlash |

Record the number. Repeat the same test with a **camera-weight payload** — steppers
that repeat beautifully unloaded can drop steps under mass.

## Phase 4 — key-frame engine, and the ADR-0006 shootout (~30 min)

1. In the timeline, build a **3-point move** (jog → ⏺ Capture at 0 s, mid, end).
2. **↑ Upload** → **⏮** → **▶ Run**. Watch for smooth easing through the middle key
   with no hesitation or reversal at the keyframe.
3. Run the same 5-pass repeatability test as Phase 3.

**The comparison that ratifies ADR-0006:** we currently mirror the official app —
classic engine for 2-point, key-frame engine for 3+. If the KF engine measurably
repeats *better* even for a straight A→B move, we should use it for everything and
supersede ADR-0006. Run both, same distance, same duration, five passes each, and
compare the spreads.

Also verify: **does the spline preview match the physical move?** Watch where the
carriage is at the 50% mark versus where the on-screen curve says it should be.
That validates [ADR-0009](adr/0009-single-source-motion-math.md) in the only way
that counts.

## Phase 5 — camera & the full multiplicity rehearsal

1. Wire the NMX shutter output to the camera. **Arm** → **Test fire**. Confirm the
   camera actually triggers.
2. Full dress rehearsal: 3-point move, 5 s cue delay, **three passes** with a
   person standing in a different position each time.
3. Pull the three clips into an editor, stack them, mask. **Do the backgrounds
   line up?** That is the whole project, answered.

## Recording results

Update `claude/graffik-ng-decisions.md` (or the repo's decision log) with:

- Firmware version reported
- Repeatability spread: classic vs key-frame, unloaded vs loaded
- Maximum speed that ran reliably under camera load → set as the jog clamp
- Anything the app got wrong, in the app's own words (the status line text)

## Safe-limits worksheet

Fill in once, keep with the rig:

| Parameter | Value | How determined |
|---|---|---|
| Payload (camera + lens + plate) | ____ kg | Scale |
| Slider rating | ~5.5–6.8 kg (12–15 lb) | Manufacturer |
| Max reliable jog speed, loaded | ____ steps/s | Phase 2, increase until it stalls, take 60% |
| Max program speed, loaded | ____ steps/s | Phase 3 with payload |
| Usable travel (soft limits) | ____ → ____ steps | Jog to each mechanical end, back off 5 % |

If payload approaches the slider's rating, reduce speed *and* acceleration before
anything else — inertia at the ends is what drops steps and, in the worst case,
what throws a camera.
