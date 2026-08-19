/*
 * GRAFFIK-TRIG — reference trigger + lens firmware for Graffik NG
 * (cues: ADR-0016 · lens axes: ADR-0017 §4 / ADR-0018)
 * MIT licensed, same as the rest of the project.
 *
 * WHY THIS EXISTS
 * ---------------
 * The NMX executes the camera move on its own hardware, which is what makes a
 * pass repeatable. Cues have exactly the same problem: a cue fired by the host
 * arrives with ~±20 ms of jitter that is different every pass, and at 24 fps
 * that is half a frame. A focus pull is *worse* — half a frame of error in a
 * fast pull is a visibly different amount of blur on that frame, and focus is
 * the one thing multiplicity cannot fake, because the rig repeats its path
 * exactly and a human focus puller cannot.
 *
 * So this board takes the whole cue list AND the whole lens curve BEFORE the
 * pass and runs both from millis(). The host sends one GO. Host jitter then
 * shifts the entire pass uniformly instead of smearing its contents, which is
 * the difference between a move you can composite and one you cannot.
 *
 * WIRING
 * ------
 *   Outputs 1..OUT_COUNT  -> OUT_PINS. Drive opto-isolators, MOSFETs or relay
 *                            boards; do NOT drive a solenoid or lamp directly
 *                            from a microcontroller pin.
 *   Inputs 1..IN_COUNT    -> IN_PINS, INPUT_PULLUP, active LOW. A camera
 *                            run/stop signal or a foot switch goes here.
 *   Lens axes 0,1,2       -> focus, iris, zoom. STEP/DIR/EN per axis plus one
 *                            stop-detect pin (see LENS HARDWARE below).
 *
 * PROTOCOL (v2, line-oriented ASCII, 115200 baud)
 * -----------------------------------------------
 *   -> HELLO                       <- GRAFFIK-TRIG 2 <name> <outs> <ins> <lens>
 *   -> CLEAR
 *   -> CUE <id> <ms> <out> PULSE <ms> | LEVEL <0-255>
 *   -> LAXIS <n> <kind> <steps> <maxStepsPerSec> <invert>   <- LAXIS <n> OK
 *   -> LCAL <n>                    <- LCAL <n> <steps>  |  LCALERR <n> <reason>
 *   -> LCLEAR                      <- LCLEAR OK
 *   -> LKEY <n> <ms> <pos0..65535>
 *   -> LSYNC <id>                  <- LSYNC <id> <pointsHeld>
 *   -> LSEEK <n> <pos0..65535>
 *   -> ARM                         <- READY <cues> <lensPoints>
 *   -> GO                          <- STARTED <deviceMs>  |  LERR <n> <reason>
 *   -> ABORT
 *   -> FIRE <out> PULSE <ms>       (immediate, Tier-1 style)
 *                                  <- FIRED <id> <deviceMs>
 *                                  <- IN <n> <RISE|FALL> <deviceMs>
 *                                  <- DONE <deviceMs>
 *
 * Text, not binary, on purpose: anyone can implement this on any board, debug
 * it in a serial monitor, and read a session transcript when a cue fires late
 * on set at 2 a.m. The bytes we would save are bytes nobody needs saved.
 *
 * WHY THE HOST SENDS SAMPLES, NOT KEYFRAMES
 * -----------------------------------------
 * The spline that shapes a pull lives in the host's tested core and is shared
 * with the on-screen preview (ADR-0009). Re-implementing it here would create a
 * second motion solver, and the curve the operator draws would stop being the
 * curve the rig pulls. So the host samples its own spline per frame, decimates
 * under an explicit error bound (half a motor step by default), and sends the
 * result. This firmware only ever interpolates LINEARLY between the points it
 * was given — that is precisely what the host's error bound is stated against,
 * so do not "improve" it with smoothing here.
 *
 * A 24-second pull at 24 fps is 577 dense samples per axis and arrives as a few
 * dozen points. If your program is bigger than MAX_LKEY the extra points are
 * dropped, LSYNC reports the short count, and the host refuses the pass rather
 * than running a truncated focus pull. That failure is safe by construction.
 *
 * LENS HARDWARE
 * -------------
 * Steppers, geared to the barrel through an 0.8 module pinion — the cine gear
 * standard, so it meshes with any lens that has been cine-modded.
 *
 * Use TMC2209 drivers. Two reasons, both practical rather than aesthetic:
 *   - StallGuard4 detects the barrel's mechanical stop with no limit switch, so
 *     calibration needs nothing bolted to the lens. Wire DIAG to the axis's
 *     STOP pin and set the driver's SGTHRS over UART for your motor.
 *   - StealthChop is quiet enough to sit next to a microphone. An A4988 is
 *     audible on a take and cannot detect a stall at all.
 * If you use a limit switch instead, set LENS_STOP_ACTIVE_LOW and wire it to
 * the same pin — the code does not care which it is.
 *
 * CALIBRATION IS NOT OPTIONAL
 * --------------------------
 * A stepper is open loop. Its position means nothing until it has been measured
 * against a physical stop, so LCAL drives to both ends and records the travel
 * between them — the same thing a Preston MDR does whenever a motor is
 * connected. An axis that has not been homed SINCE POWER-UP refuses to run:
 * GO answers LERR instead of STARTED. Driving a curve from an unknown position
 * would slam the barrel into a stop at speed.
 *
 * SAFETY
 * ------
 * ABORT cancels everything immediately, and the host wires it into its e-stop.
 * Outputs go LOW. Lens axes STOP AND HOLD — they must never home on abort and
 * must never release, because a focus ring that free-wheels while a heavy lens
 * is on a tilted head is a way to lose the lens. Drivers stay enabled so the
 * barrel is held.
 *
 * If you attach anything that moves, add a hardware kill switch in series.
 * This firmware is a timer, not a safety system.
 */

#include <Arduino.h>

static const char DEVICE_NAME[] = "graffik-trig";
static const uint8_t PROTOCOL_VERSION = 2;

/* ---- configure for your board ---- */
static const uint8_t OUT_PINS[] = { 2, 3, 4, 5, 6, 7, 8, 9 };
static const uint8_t IN_PINS[]  = { 10, 11 };
static const uint8_t OUT_COUNT  = sizeof(OUT_PINS);
static const uint8_t IN_COUNT   = sizeof(IN_PINS);
static const uint8_t MAX_CUES   = 64;

/* ---- lens axes: 0 = focus, 1 = iris, 2 = zoom ---- */
static const uint8_t LENS_COUNT = 3;
static const uint8_t LENS_STEP_PINS[LENS_COUNT] = { 22, 24, 26 };
static const uint8_t LENS_DIR_PINS[LENS_COUNT]  = { 23, 25, 27 };
static const uint8_t LENS_EN_PINS[LENS_COUNT]   = { 28, 29, 30 };  // active LOW on a TMC2209
static const uint8_t LENS_STOP_PINS[LENS_COUNT] = { 31, 32, 33 };  // DIAG, or a limit switch
static const bool LENS_STOP_ACTIVE_LOW = false;                    // TMC2209 DIAG idles LOW

/* Points per axis. 6 bytes each, so 3 axes x 128 = 2.3 kB — comfortable on a
   Mega/RP2040/ESP32, too much for an Uno's 2 kB. If you are on an ATmega328,
   drop this to 32: the host's decimation puts a typical pull well inside that,
   and anything larger is refused loudly rather than truncated silently. */
#if defined(__AVR_ATmega328P__) || defined(__AVR_ATmega168__)
static const uint8_t MAX_LKEY = 32;
#else
static const uint8_t MAX_LKEY = 128;
#endif

/* Calibration safety bound: give up after this many steps in one direction so a
   disconnected motor or a slipped belt reports an error instead of grinding. */
static const uint32_t LCAL_MAX_STEPS = 200000UL;
static const uint16_t LCAL_STEPS_PER_SEC = 800;   // slow — this one pushes into a stop
static const uint16_t LENS_STEP_PULSE_US = 3;     // TMC2209 needs >= 100 ns; 3 us is safe

struct Cue {
  uint16_t id;
  uint32_t atMs;      // from GO
  uint8_t  out;       // 1-based
  uint8_t  kind;      // 0 = pulse, 1 = level
  uint16_t arg;       // pulse width ms, or level 0-255
  bool     fired;
};

struct LensPoint {
  uint32_t ms;        // from GO
  uint16_t pos;       // 0..65535 of barrel travel
};

struct LensAxis {
  uint32_t travelSteps;    // measured by LCAL; 0 = unknown
  uint16_t maxStepsPerSec;
  bool     invert;
  bool     homed;          // TRUE only after LCAL ran THIS power cycle
  int32_t  curStep;        // 0 .. travelSteps
  int32_t  targetStep;
  uint32_t nextStepAtUs;
  LensPoint keys[MAX_LKEY];
  uint8_t  keyCount;
};

static Cue cues[MAX_CUES];
static uint8_t cueCount = 0;
static bool running = false;
static uint32_t startedAt = 0;

static LensAxis lens[LENS_COUNT];
static uint16_t lensTotalPoints = 0;   // across all axes, for LSYNC
static bool lensRunning = false;

/* Pulses are released without blocking — delay() inside a cue would make every
   later cue late, which is precisely the failure this board exists to avoid. */
static uint32_t pulseUntil[sizeof(OUT_PINS)];
static bool lastInput[sizeof(IN_PINS)];

static char line[96];
static uint8_t lineLen = 0;

/* ------------------------------------------------------------------ */

static void allOutputsOff() {
  for (uint8_t i = 0; i < OUT_COUNT; i++) {
    digitalWrite(OUT_PINS[i], LOW);
    pulseUntil[i] = 0;
  }
}

static void applyAction(uint8_t out, uint8_t kind, uint16_t arg) {
  if (out < 1 || out > OUT_COUNT) return;
  uint8_t idx = out - 1;
  if (kind == 0) {                       // PULSE
    digitalWrite(OUT_PINS[idx], HIGH);
    pulseUntil[idx] = millis() + arg;
  } else {                               // LEVEL
    analogWrite(OUT_PINS[idx], arg);     // falls back to on/off where unsupported
    pulseUntil[idx] = 0;
  }
}

/* ---- lens primitives ---- */

static bool stopHit(uint8_t n) {
  bool level = digitalRead(LENS_STOP_PINS[n]);
  return LENS_STOP_ACTIVE_LOW ? !level : level;
}

/** One step. Direction is in barrel space; `invert` is applied at the pin. */
static void stepOnce(uint8_t n, int8_t dir) {
  bool physical = (dir > 0) != lens[n].invert;
  digitalWrite(LENS_DIR_PINS[n], physical ? HIGH : LOW);
  digitalWrite(LENS_STEP_PINS[n], HIGH);
  delayMicroseconds(LENS_STEP_PULSE_US);
  digitalWrite(LENS_STEP_PINS[n], LOW);
  lens[n].curStep += dir;
}

/**
 * Drive until the stop is reached, or give up. Returns steps travelled, or -1
 * if the bound was hit first — which means the motor is not connected, the belt
 * slipped, or StallGuard is not tuned. Any of those must be an ERROR, not a
 * calibration: a bogus travel figure produces a bogus pull on every take after.
 *
 * This is the ONE place blocking is correct. Nothing else can happen during a
 * calibration, and the host gives LCAL its own long timeout for exactly this.
 */
static int32_t seekStop(uint8_t n, int8_t dir) {
  const uint32_t periodUs = 1000000UL / LCAL_STEPS_PER_SEC;
  int32_t moved = 0;
  /* STEP FIRST, then test.
     The obvious shape — test, then step — reports zero whenever we are already
     standing on a stop, which is exactly the situation after the first leg of a
     calibration. Stepping first walks off the near stop and keeps counting, so
     the total that comes back is the real travel between the two ends rather
     than an instant, silent, plausible-looking zero. */
  while (moved < (int32_t)LCAL_MAX_STEPS) {
    stepOnce(n, dir);
    moved++;
    delayMicroseconds(periodUs);
    if (stopHit(n)) return moved;
    /* Any byte from the host abandons the calibration. The only thing it has
       to say mid-LCAL is ABORT, and losing a calibration to a stray newline is
       a far better trade than sitting through one while an e-stop waits. */
    if ((moved & 0x3F) == 0 && Serial.available()) return -1;
  }
  return -1;
}

static void calibrate(uint8_t n) {
  digitalWrite(LENS_EN_PINS[n], LOW);            // enable (TMC2209: active LOW)
  lens[n].homed = false;
  lens[n].curStep = 0;

  if (seekStop(n, -1) < 0) {
    Serial.print("LCALERR "); Serial.print(n); Serial.println(" barrel did not reach a stop");
    return;
  }
  lens[n].curStep = 0;
  int32_t travel = seekStop(n, +1);
  if (travel <= 0) {
    Serial.print("LCALERR "); Serial.print(n); Serial.println(" barrel did not reach a stop");
    return;
  }
  lens[n].travelSteps = travel;
  /* Park back at the low stop and call that zero. The host is told the barrel
     is at 0 by convention, so a curve that starts elsewhere seeks there before
     GO rather than slamming across the barrel at t=0. */
  seekStop(n, -1);
  lens[n].curStep = 0;
  lens[n].targetStep = 0;
  lens[n].homed = true;
  Serial.print("LCAL "); Serial.print(n); Serial.print(' '); Serial.println(travel);
}

/** Travel units (0..65535) -> motor steps for this barrel. */
static int32_t unitsToSteps(uint8_t n, uint32_t units) {
  if (!lens[n].travelSteps) return 0;
  return (int32_t)((units * (uint64_t)lens[n].travelSteps) / 65535UL);
}

/** Where the uploaded curve says this axis should be at `elapsed` ms. */
static int32_t curveTargetAt(uint8_t n, uint32_t elapsed) {
  LensAxis &a = lens[n];
  if (!a.keyCount) return a.targetStep;
  if (elapsed <= a.keys[0].ms) return unitsToSteps(n, a.keys[0].pos);
  const LensPoint &last = a.keys[a.keyCount - 1];
  if (elapsed >= last.ms) return unitsToSteps(n, last.pos);
  for (uint8_t i = 0; i + 1 < a.keyCount; i++) {
    const LensPoint &p = a.keys[i], &q = a.keys[i + 1];
    if (elapsed >= p.ms && elapsed <= q.ms) {
      uint32_t span = q.ms - p.ms;
      if (!span) return unitsToSteps(n, q.pos);
      /* Interpolate in UNITS then convert, so the rounding happens once. */
      int32_t d = (int32_t)q.pos - (int32_t)p.pos;
      int32_t units = (int32_t)p.pos + (int32_t)((int64_t)d * (int64_t)(elapsed - p.ms) / (int64_t)span);
      if (units < 0) units = 0;
      if (units > 65535) units = 65535;
      return unitsToSteps(n, (uint32_t)units);
    }
  }
  return unitsToSteps(n, last.pos);
}

/**
 * Move every axis toward its target, rate-limited to its own top speed.
 *
 * The axis LAGS rather than clipping when the curve asks for more speed than
 * the motor has. That is the right failure: a lagging pull is late, a clipped
 * one goes to the wrong place and stays there. The host pre-flights the same
 * limit and warns before the take, so this path should never be reached.
 */
static void serviceLens(uint32_t nowUs) {
  for (uint8_t n = 0; n < LENS_COUNT; n++) {
    LensAxis &a = lens[n];
    if (!a.homed || !a.maxStepsPerSec) continue;
    if (a.curStep == a.targetStep) continue;
    if ((int32_t)(nowUs - a.nextStepAtUs) < 0) continue;
    int8_t dir = (a.targetStep > a.curStep) ? +1 : -1;
    /* Never step past a known stop, whatever the curve says. */
    int32_t next = a.curStep + dir;
    if (next < 0 || (a.travelSteps && next > (int32_t)a.travelSteps)) { a.targetStep = a.curStep; continue; }
    stepOnce(n, dir);
    a.nextStepAtUs = nowUs + (1000000UL / a.maxStepsPerSec);
  }
}

static void lensAbort() {
  lensRunning = false;
  for (uint8_t n = 0; n < LENS_COUNT; n++) {
    /* Stop where we are and HOLD. Do not home. Do not disable the driver. */
    lens[n].targetStep = lens[n].curStep;
    lens[n].keyCount = 0;
  }
  lensTotalPoints = 0;
}

/* ------------------------------------------------------------------ */

static void handleLine(char *s) {
  char *verb = strtok(s, " ");
  if (!verb) return;

  if (!strcmp(verb, "HELLO")) {
    Serial.print("GRAFFIK-TRIG ");
    Serial.print(PROTOCOL_VERSION); Serial.print(' ');
    Serial.print(DEVICE_NAME);      Serial.print(' ');
    Serial.print(OUT_COUNT);        Serial.print(' ');
    Serial.print(IN_COUNT);         Serial.print(' ');
    Serial.println(LENS_COUNT);
    return;
  }

  if (!strcmp(verb, "CLEAR")) { cueCount = 0; running = false; return; }

  if (!strcmp(verb, "CUE")) {
    if (cueCount >= MAX_CUES) return;    // silently dropped; ARM reports short
    Cue &c = cues[cueCount];
    c.id   = atoi(strtok(NULL, " "));
    c.atMs = strtoul(strtok(NULL, " "), NULL, 10);
    c.out  = atoi(strtok(NULL, " "));
    char *kind = strtok(NULL, " ");
    c.kind = (kind && !strcmp(kind, "LEVEL")) ? 1 : 0;
    char *arg = strtok(NULL, " ");
    c.arg  = arg ? atoi(arg) : 30;
    c.fired = false;
    cueCount++;
    return;
  }

  /* ---- lens ---- */

  if (!strcmp(verb, "LAXIS")) {
    uint8_t n = atoi(strtok(NULL, " "));
    if (n >= LENS_COUNT) { Serial.print("ERR no axis "); Serial.println(n); return; }
    strtok(NULL, " ");                                   // kind: informational
    uint32_t steps = strtoul(strtok(NULL, " "), NULL, 10);
    uint16_t maxSps = atoi(strtok(NULL, " "));
    char *inv = strtok(NULL, " ");
    /* The host may send back a travel figure it remembered from a previous
       session. Accept it as a HINT, but never as homing: only this board knows
       whether it has seen a stop since power-up, and only that makes a step
       count mean a position. */
    if (steps) lens[n].travelSteps = steps;
    lens[n].maxStepsPerSec = maxSps ? maxSps : 2000;
    lens[n].invert = inv && inv[0] == '1';
    Serial.print("LAXIS "); Serial.print(n); Serial.println(" OK");
    return;
  }

  if (!strcmp(verb, "LCAL")) {
    uint8_t n = atoi(strtok(NULL, " "));
    if (n >= LENS_COUNT) { Serial.print("LCALERR "); Serial.print(n); Serial.println(" no such axis"); return; }
    calibrate(n);
    return;
  }

  if (!strcmp(verb, "LCLEAR")) {
    for (uint8_t n = 0; n < LENS_COUNT; n++) lens[n].keyCount = 0;
    lensTotalPoints = 0;
    lensRunning = false;
    Serial.println("LCLEAR OK");
    return;
  }

  if (!strcmp(verb, "LKEY")) {
    uint8_t n = atoi(strtok(NULL, " "));
    if (n >= LENS_COUNT) return;
    LensAxis &a = lens[n];
    /* Out of room: drop it. LSYNC then reports a short count and the host
       refuses the pass. Silent truncation of a focus pull is the one outcome
       this must never produce. */
    if (a.keyCount >= MAX_LKEY) return;
    a.keys[a.keyCount].ms  = strtoul(strtok(NULL, " "), NULL, 10);
    uint32_t pos = strtoul(strtok(NULL, " "), NULL, 10);
    a.keys[a.keyCount].pos = pos > 65535UL ? 65535 : (uint16_t)pos;
    a.keyCount++;
    lensTotalPoints++;
    return;
  }

  if (!strcmp(verb, "LSYNC")) {
    uint32_t id = strtoul(strtok(NULL, " "), NULL, 10);
    Serial.print("LSYNC "); Serial.print(id); Serial.print(' '); Serial.println(lensTotalPoints);
    return;
  }

  if (!strcmp(verb, "LSEEK")) {
    uint8_t n = atoi(strtok(NULL, " "));
    if (n >= LENS_COUNT) return;
    uint32_t pos = strtoul(strtok(NULL, " "), NULL, 10);
    if (pos > 65535UL) pos = 65535UL;
    if (!lens[n].homed) return;          // no reference, no move
    lens[n].targetStep = unitsToSteps(n, pos);
    return;
  }

  /* ---- transport ---- */

  if (!strcmp(verb, "ARM")) {
    // Insertion-sort by time: the list is short and almost always already
    // ordered, and the host must never depend on our ordering anyway.
    for (uint8_t i = 1; i < cueCount; i++) {
      Cue key = cues[i];
      int8_t j = i - 1;
      while (j >= 0 && cues[j].atMs > key.atMs) { cues[j + 1] = cues[j]; j--; }
      cues[j + 1] = key;
    }
    for (uint8_t i = 0; i < cueCount; i++) cues[i].fired = false;
    running = false;
    lensRunning = false;
    /* Pre-position every lens axis at its first point, so GO does not begin
       with a slam across the barrel. */
    for (uint8_t n = 0; n < LENS_COUNT; n++) {
      if (lens[n].keyCount && lens[n].homed) lens[n].targetStep = unitsToSteps(n, lens[n].keys[0].pos);
    }
    Serial.print("READY "); Serial.print(cueCount); Serial.print(' '); Serial.println(lensTotalPoints);
    return;
  }

  if (!strcmp(verb, "GO")) {
    /* Refuse rather than start blind. An axis with a curve but no homing has no
       idea where the barrel is, and running it would drive into a stop at
       speed. The host turns this line into a sentence the operator can act on. */
    for (uint8_t n = 0; n < LENS_COUNT; n++) {
      if (lens[n].keyCount && !lens[n].homed) {
        Serial.print("LERR "); Serial.print(n); Serial.println(" is not calibrated — run Calibrate first");
        return;
      }
    }
    startedAt = millis();
    running = true;
    lensRunning = lensTotalPoints > 0;
    for (uint8_t i = 0; i < cueCount; i++) cues[i].fired = false;
    Serial.print("STARTED "); Serial.println(startedAt);
    return;
  }

  if (!strcmp(verb, "ABORT")) {
    running = false;
    cueCount = 0;
    allOutputsOff();
    lensAbort();
    return;
  }

  if (!strcmp(verb, "FIRE")) {           // immediate, host-timed
    uint8_t out = atoi(strtok(NULL, " "));
    char *kind = strtok(NULL, " ");
    uint16_t arg = atoi(strtok(NULL, " "));
    applyAction(out, (kind && !strcmp(kind, "LEVEL")) ? 1 : 0, arg);
    return;
  }

  Serial.print("ERR unknown "); Serial.println(verb);
}

void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < OUT_COUNT; i++) { pinMode(OUT_PINS[i], OUTPUT); digitalWrite(OUT_PINS[i], LOW); }
  for (uint8_t i = 0; i < IN_COUNT; i++)  { pinMode(IN_PINS[i], INPUT_PULLUP); lastInput[i] = true; }
  for (uint8_t n = 0; n < LENS_COUNT; n++) {
    pinMode(LENS_STEP_PINS[n], OUTPUT); digitalWrite(LENS_STEP_PINS[n], LOW);
    pinMode(LENS_DIR_PINS[n], OUTPUT);
    pinMode(LENS_EN_PINS[n], OUTPUT);   digitalWrite(LENS_EN_PINS[n], HIGH);   // disabled until asked
    pinMode(LENS_STOP_PINS[n], LENS_STOP_ACTIVE_LOW ? INPUT_PULLUP : INPUT);
    lens[n].travelSteps = 0;
    lens[n].maxStepsPerSec = 2000;
    lens[n].invert = false;
    lens[n].homed = false;
    lens[n].curStep = lens[n].targetStep = 0;
    lens[n].nextStepAtUs = 0;
    lens[n].keyCount = 0;
  }
  allOutputsOff();
}

void loop() {
  /* ---- serial in ---- */
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (lineLen) { line[lineLen] = 0; handleLine(line); lineLen = 0; }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = ch;
    }
  }

  uint32_t now = millis();

  /* ---- due cues ---- */
  if (running) {
    uint32_t elapsed = now - startedAt;
    bool remaining = false;
    for (uint8_t i = 0; i < cueCount; i++) {
      if (cues[i].fired) continue;
      if (cues[i].atMs <= elapsed) {
        applyAction(cues[i].out, cues[i].kind, cues[i].arg);
        cues[i].fired = true;
        Serial.print("FIRED "); Serial.print(cues[i].id); Serial.print(' '); Serial.println(now);
      } else {
        remaining = true;
      }
    }
    if (!remaining && !lensRunning) {
      running = false;
      Serial.print("DONE "); Serial.println(now);
    }
  }

  /* ---- lens curve ---- */
  if (lensRunning) {
    uint32_t elapsed = now - startedAt;
    bool anyLeft = false;
    for (uint8_t n = 0; n < LENS_COUNT; n++) {
      if (!lens[n].keyCount) continue;
      lens[n].targetStep = curveTargetAt(n, elapsed);
      if (elapsed < lens[n].keys[lens[n].keyCount - 1].ms || lens[n].curStep != lens[n].targetStep) anyLeft = true;
    }
    if (!anyLeft) {
      lensRunning = false;
      if (!running) { Serial.print("DONE "); Serial.println(now); }
    }
  }
  serviceLens(micros());

  /* ---- release finished pulses ---- */
  for (uint8_t i = 0; i < OUT_COUNT; i++) {
    if (pulseUntil[i] && (int32_t)(now - pulseUntil[i]) >= 0) {
      digitalWrite(OUT_PINS[i], LOW);
      pulseUntil[i] = 0;
    }
  }

  /* ---- GPI edges, reported with the DEVICE's timestamp ---- */
  for (uint8_t i = 0; i < IN_COUNT; i++) {
    bool level = digitalRead(IN_PINS[i]);
    if (level != lastInput[i]) {
      lastInput[i] = level;
      Serial.print("IN "); Serial.print(i + 1); Serial.print(' ');
      Serial.print(level ? "RISE" : "FALL");   // INPUT_PULLUP: LOW = pressed
      Serial.print(' '); Serial.println(now);
    }
  }
}
