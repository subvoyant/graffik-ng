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

---

## Phase 6 — Rig calibration (required before any 3D export)

The NMX reports **motor steps** and has no encoder. Nothing in the software can
know how far a step moves the carriage: that is belt pitch, pulley diameter,
gear ratio and microstepping — a property of your physical rig. Until these
numbers are measured, a 3D export (ADR-0015) is a *shape*, not a camera move.

Measure once per mechanical configuration, and re-measure after changing a belt,
a pulley, a gearbox, or the driver's microstep setting.

### 6.1 Slide — steps per millimetre

1. Jog the carriage to one end of safe travel. Note the reported position, `p₀`.
2. Mark the carriage against the rail with tape and a fine line.
3. Jog roughly 400–600 mm along the rail. Mark again.
4. Note the reported position, `p₁`. Measure the distance between the two marks
   with a steel rule or tape — millimetres, read twice.

```
slideStepsPerMm = (p₁ − p₀) / distance_mm
```

Use the longest travel you can: the measurement error is fixed (~0.5 mm), so a
500 mm baseline gives ten times the accuracy of a 50 mm one.

### 6.2 Pan and tilt — steps per degree

Rotation is harder to measure well than translation, and a 1% error over a 90°
pan is nearly a degree of drift by the end of the move.

1. Put a **digital inclinometer** on the head (for tilt) or use a printed
   360° protractor taped under the pan axis with a pointer on the rotating part.
2. Zero it. Note the reported position, `p₀`.
3. Rotate as far as the rig allows — **90° or more**. Note `p₁` and the angle.

```
panStepsPerDeg  = (p₁ − p₀) / angle_deg
tiltStepsPerDeg = (p₁ − p₀) / angle_deg
```

Cross-check: command a 45° move using the number you just derived and confirm
the inclinometer agrees within a few tenths of a degree. If it does not, the
error is usually microstepping (a factor of exactly 2, 4, 8 or 16) rather than
a measurement mistake — look for the round number before re-measuring.

### 6.3 Nodal offset

Distance from the **tilt axis** to the lens's **entrance pupil**, along the lens
axis, in millimetres. Positive means the pupil sits forward of the tilt axis.

The quick method: mark two vertical objects at different distances that line up
in frame. Tilt the head. If they stay lined up, the offset is zero; if they
separate, the camera is swinging on an arc and the offset is non-zero. Slide the
camera on its plate until they stop separating, then measure from the tilt axis
to the pupil mark on the lens barrel.

Getting this wrong is the classic reason a perfectly tracked CG element slides
against the plate on a tilt.

### 6.4 Head height

Height of the pan axis above the rail, in millimetres. Pure scene placement —
it does not affect the move, only where the exported rig sits in the 3D scene.

### 6.5 Record it

Write the values into the export dialog's calibration fields (they persist in
preferences) **and** into this table, so a future session can tell whether the
rig has been re-measured since:

| Date | Slide steps/mm | Pan steps/deg | Tilt steps/deg | Nodal mm | Head mm | Measured by |
|---|---|---|---|---|---|---|
| _(pending first hardware session)_ | | | | | | |

### 6.6 Verify the export end to end

1. Build a short move that ends 200 mm along the rail and 45° panned.
2. Export `.usda` with metres / Y-up.
3. Open it in Blender (Z-up, metres — the importer will honour the stage
   metadata) or Maya (Y-up, centimetres — export a second file at
   `metersPerUnit = 0.01` if the import looks 100× off).
4. Confirm the carriage travels 0.2 units and the pan reads 45°.

If the scale is out by exactly 100, the unit setting is the culprit, not the
calibration. If it is out by 2, 4, 8 or 16, it is microstepping.

## Phase 7 — Lens axes: first motor, calibration, and a pull that repeats

Everything in ADR-0018 is verified against a simulated barrel and a compiled-on-
the-desktop firmware. **Nothing has moved a real lens.** This phase is where the
reasoning meets a motor.

### 7.0 — What to build first

One axis. Focus. Do not wire three motors before one of them works.

| part | what to get | why |
|---|---|---|
| driver | **TMC2209** (UART) | StallGuard4 finds the barrel stop with no switch; StealthChop is quiet next to a mic |
| motor | NEMA-11 or NEMA-14, ~0.5–1 A | enough torque through a reduction, small enough to hang off a lens support |
| gear | **0.8 module** pinion | the cine standard — meshes with any cine-modded lens |
| board | Mega / RP2040 / ESP32 | an Uno's 2 kB RAM caps `MAX_LKEY` at 32 per axis |

Pick the reduction so the motor's travel comfortably **exceeds** the barrel's,
then let calibration find the real limits.

### 7.1 — Bench it before it touches glass

Run the motor with the pinion **off the lens**, free-spinning, and confirm:

- [ ] `HELLO` reports `GRAFFIK-TRIG 2 … 3` — the app's Cues… dialog says "3 lens axes"
- [ ] the motor turns at all, and `LSEEK` moves it both ways
- [ ] `motor runs backwards` flips the direction it goes (this is the setting
      that moved out of the move file in ADR-0018 §5 — set it here, once)

### 7.2 — Tune StallGuard, or fit a switch

With the pinion still off the lens, hold the shaft gently and watch DIAG. Set
`SGTHRS` over UART until a light finger stops it and free running does not.
Record the value in this file next to the motor it belongs to.

**If tuning fights you, fit a limit switch instead and set
`LENS_STOP_ACTIVE_LOW`.** The firmware does not care which it is, and an
afternoon lost to StallGuard is an afternoon not spent shooting.

### 7.3 — Calibrate against the lens

Mesh the pinion. Open ⌾ Lens… → **Calibrate…**

- [ ] the barrel drives to one stop, then the other, then parks at the low stop
- [ ] the reported travel is **stable across three runs** (±0.5 % or better)
- [ ] the barrel is not being driven hard into either stop at the end

Record: `lens ____________ travel ______ steps · run 1/2/3 ______/______/______`

A travel figure that wanders between runs means StallGuard is triggering on
friction rather than the stop. Fix that before going further — every number
downstream is scaled by it.

### 7.4 — Top speed, measured not assumed

Raise **Top speed** until the motor audibly loses steps against the barrel, then
back off **30 %**. That is the figure the feasibility pre-flight uses, so an
optimistic one turns a pre-flight warning you would have acted on into a lagging
pull you discover in the rushes.

Record: `usable top speed ______ steps/s (lost steps at ______)`

### 7.5 — Does the pull repeat?

The whole point. Mark the barrel with tape at one witness mark. Then, five times:

1. Arm and run a pass with a focus lane that ends at 70 % travel
2. Photograph the barrel against the tape at rest

- [ ] all five photographs are indistinguishable
- [ ] recalibrating between passes does not shift the endpoint

**Threshold:** any visible difference between passes means the axis is losing
steps — reduce top speed or increase current before trusting it in a composite.

### 7.6 — Against the picture

- [ ] a mapped lens reads correctly: jog to a witness mark, and the app's map
      says what the barrel says (if it does not, the marks are wrong, not the app)
- [ ] `STOP ALL` mid-pull stops the barrel and **holds** it — it must not home
      and must not go slack
- [ ] power-cycle the board mid-session: the app must refuse to run until the
      axis is recalibrated, and say so
