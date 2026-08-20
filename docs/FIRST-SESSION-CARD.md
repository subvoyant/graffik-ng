# First session — the one-page card

`docs/HARDWARE-BRINGUP.md` is the full procedure and it is long. This is the
short version, in the order things happen, with **what each answer means**.
Everything here is a question the software has never been able to ask a real
NMX. Write the answers down; several of them change what the software should do.

Print it, or keep it on the second screen.

---

## 0 · Before power

- Cable is a **data** cable, not charge-only. This is the single most common
  cause of a handshake that times out.
- NMX on its own power supply. USB alone will enumerate and then behave oddly.
- Rig clear, camera **off** the head for first motion. Nothing on this card is
  worth a lens.

## 1 · Connect

Expect: `fw v70`, Graffik mode on, joystick watchdog armed.

- **No port listed / handshake times out** → the ports list ranks candidates and
  marks Bluetooth; then run the **connection doctor**. It separates *silence*
  (nothing is talking) from *garbage* (something is, at the wrong baud), and asks
  every plausible address. Record which cause it named and whether it was right.
- **Firmware ≠ 70** → programmed moves are blocked. Do not override to get going;
  note the version and stop, because every command number in this app came from
  the 2018 dispatch.

**Then check the limit-trust line** in the Soft limits panel.

- It should say nothing at all on a fresh rig with no limits taught.
- **Connect twice without power-cycling.** The second connect must report *no*
  power cycle. If it says *yes* every time, the one-shot latch is not behaving as
  the source says — write that down, it changes ADR-0030.
- If it offers **"Remember position across a power cycle"**, take it now, before
  teaching any limits. Then power-cycle deliberately and confirm the position
  survives. Until that is verified, a taught limit is good for one session only.

## 2 · First motion

The first jog on an axis with nothing taught **creeps at 500 steps/s**. That is
deliberate and it clears the moment you teach either bound.

- Jog each axis a short distance. Watch for direction: does + move the way you
  expect? Note any axis that is reversed.
- Teach both bounds on each axis, well inside the mechanical stops.
- Then confirm full speed returns, and that jogging **into** a bound stops while
  jogging **away** from it stays allowed.

## 3 · Upload a move, and read three things

Upload any small key-frame move. Before running it, look at:

1. **The plan type**, read back off the device. It must say **continuous video**.
   Anything else means percent-complete is divided by the wrong thing and the
   playhead and every recorded comparison are skewed.
2. **The pre-flight**. It asks the controller whether each axis can actually
   reach the speed and acceleration the move needs. Silence means yes.
3. **Anything it refuses.** Note the exact wording — if it refuses a move that
   then runs perfectly, the gate is an obstacle and people will route around it.

## 4 · Run a pass, then read the recording

Every pass is recorded while it runs and **written to disk as it ends** — the
folder is printed in **◉ Passes…**. A restart does not cost you the day.

Three numbers matter on the very first pass:

- **`ms/sample`** — the measured cost of one sample. Under ~150 ms is comfortable
  at the 500 ms poll. Much above and the poll is backing up: turn off
  `checkSending` in preferences (saves three of eight queries) and say so.
- **The device-timing line.** If it says the device divided percent by more
  milliseconds than the move you uploaded, **stop and fix that first** — every
  number joined on percent is scaled by the same ratio.
- **Worst blind spot** — the biggest gap in percent between samples. A large one
  means the poll missed a stretch of the move.

Also watch for: the shutter firing **once at the end** of a classic pass. That is
continuous-video mode doing start/stop record, it is intended, and nobody has
ever seen it on a real camera.

## 5 · Repeatability — the number this project exists for

Tape a marker to the carriage and a strip of paper beside it. Run **⏮ → ▶** five
times, mark the resting position each time, measure the spread.

| Spread | Reading |
|---|---|
| < 0.5 mm | composites line up invisibly |
| 0.5–2 mm | usable; may need a stabilise pass |
| > 2 mm | belt tension, missed steps, or backlash |

Then open **◉ Passes…** and compare pass 1 with pass 5. That is the deviation
**along the whole move**, which the tape cannot see. Read the two as different
measurements — the tape is better at the endpoint, the app is the only thing
measuring the middle. If a comparison says *"a bound, not a measurement"*, that
means the deviation was smaller than a whole-percent progress report can
resolve. It is a real result: "at least this good", not "exactly this".

**Repeat with the camera payload on.** Steppers that repeat beautifully unloaded
drop steps under mass.

## 6 · Before leaving the room

- **Export the bring-up report.** It carries the firmware, the limit-trust
  verdict, the plan type, every taught bound, every measured span, the
  repeatability verdict, every recorded pass with its coverage, and an automatic
  comparison of the last two complete passes. Everything unmeasured says **"not
  measured"** rather than being left out.
- Export the CSVs for anything that has to leave this machine.
- Note anything the app got **wrong**, in the app's own words. That sentence is
  more useful than a description of it.

---

### The five things most likely to be wrong

In rough order of how much they would cost:

1. **The percent denominator** (plan type / start delay). Skews the playhead and
   every comparison, silently, with plausible numbers.
2. **Taught limits after a power cycle.** If position is not restored, they point
   at different places on the rail while looking correct.
3. **`ms/sample` too high**, so the poll backs up and the progress bar lags the
   rig.
4. **The feasibility gate being wrong in either direction** — refusing good moves,
   or passing ones the rig cannot track.
5. **The doctor's classifications**, which were reasoned from the firmware and
   have never been observed.

Every one of those is a question, not an assumption, and the software will tell
you which. That is the whole point of the last week.
