/*
 * Host-side exercise of graffik-trig.ino. Build and run:
 *     g++ -std=c++17 -I firmware/graffik-trig/test \
 *         -o /tmp/fwtest firmware/graffik-trig/test/test_firmware.cpp && /tmp/fwtest
 *
 * WHAT THIS PROVES: the sketch compiles; its protocol state machine answers
 * exactly what the host's SerialTriggerBackend parses; calibration measures a
 * real travel by driving into simulated hard stops and refuses when it cannot;
 * an un-homed axis will not run; over-capacity uploads are refused rather than
 * truncated; ABORT stops and HOLDS; and the curve interpolation lands where the
 * host's own model says it should.
 *
 * WHAT IT DOES NOT PROVE: step timing under real load, StallGuard tuning, motor
 * torque, or anything electrical. Those need a board — HARDWARE-BRINGUP Phase 7.
 * It found one bug the first time it ran: `seekStop` backed off a stop in the
 * wrong direction and reported zero travel, which would have looked like a dead
 * motor on every calibration.
 */
#include "Arduino.h"

uint64_t g_micros = 0;
uint8_t g_pinMode[128] = {0};
uint8_t g_pinState[128] = {0};
uint8_t g_pinInput[128] = {0};
uint64_t g_stepCount[128] = {0};
FakeBarrel g_barrels[4];
FakeSerial Serial;

#include "../graffik-trig.ino"

/* ------------------------------------------------------------------ */

static int failures = 0, checks = 0;
static void ok(bool cond, const std::string &what) {
  checks++;
  if (cond) return;
  failures++;
  printf("  FAIL  %s\n", what.c_str());
}
static void eq(const std::string &got, const std::string &want, const std::string &what) {
  checks++;
  if (got == want) return;
  failures++;
  printf("  FAIL  %s\n        got  [%s]\n        want [%s]\n", what.c_str(), got.c_str(), want.c_str());
}

static std::string trim(std::string s) {
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
  return s;
}
/** Feed one line in and run loop() until it has been consumed. */
static std::string send(const std::string &line) {
  Serial.out.clear();
  Serial.in += line + "\n";
  loop();
  return trim(Serial.out);
}
static void quiet(const std::string &line) { Serial.out.clear(); Serial.in += line + "\n"; loop(); }
/** Advance the fake clock in slices, spinning loop() the way a board would. */
static void advance(uint32_t ms) {
  for (uint32_t i = 0; i < ms * 20; i++) { g_micros += 50; loop(); }
}

static void attachBarrel(int axis, long travel, long startPos, bool attached = true) {
  g_barrels[axis] = FakeBarrel{ LENS_STEP_PINS[axis], LENS_DIR_PINS[axis], LENS_STOP_PINS[axis],
                                startPos, travel, attached };
  g_pinInput[LENS_STOP_PINS[axis]] = (startPos <= 0 || startPos >= travel) ? 1 : 0;
}

int main() {
  setup();
  printf("graffik-trig v%d firmware exercise\n", PROTOCOL_VERSION);

  /* ---- handshake ---------------------------------------------------- */
  eq(send("HELLO"), "GRAFFIK-TRIG 2 graffik-trig 8 2 3",
     "HELLO advertises v2 and the lens axis count the host parses");
  eq(send("LAXIS 0 focus 0 3000 0"), "LAXIS 0 OK", "LAXIS acknowledges");
  eq(send("LAXIS 9 focus 0 3000 0"), "ERR no axis 9", "LAXIS rejects an axis the board does not have");
  eq(send("LCLEAR"), "LCLEAR OK", "LCLEAR acknowledges");

  /* ---- a remembered travel figure is NOT homing ---------------------- */
  quiet("LAXIS 1 iris 4000 2000 0");          // host replays a figure it stored
  quiet("LKEY 1 0 0");
  quiet("LKEY 1 1000 65535");
  ok(send("GO").rfind("LERR 1", 0) == 0,
     "GO refuses an axis that has a curve but has not homed since power-up");
  quiet("ABORT");

  /* ---- calibration measures the real travel -------------------------- */
  attachBarrel(0, /*travel*/ 3200, /*startPos*/ 1500);
  quiet("LAXIS 0 focus 0 4000 0");
  eq(send("LCAL 0"), "LCAL 0 3200", "LCAL measures the barrel's travel between its stops");
  ok(g_barrels[0].pos == 0, "LCAL parks the barrel at the low stop and calls it zero");

  /* ---- calibration fails loudly when nothing moves -------------------- */
  attachBarrel(2, 3200, 1500, /*attached*/ false);      // motor unplugged
  quiet("LAXIS 2 zoom 0 4000 0");
  ok(send("LCAL 2").rfind("LCALERR 2", 0) == 0,
     "LCAL reports a reason rather than a plausible-looking zero when the barrel never moves");

  /* ---- upload capacity is refused, never truncated -------------------- */
  quiet("LCLEAR");
  for (int i = 0; i < MAX_LKEY + 20; i++) quiet("LKEY 0 " + std::to_string(i * 10) + " " + std::to_string(i * 3));
  {
    std::string sync = send("LSYNC 1");
    eq(sync, "LSYNC 1 " + std::to_string((int)MAX_LKEY),
       "LSYNC reports what it actually holds, so the host refuses a short program");
  }

  /* ---- run a curve on the device's own clock -------------------------- */
  quiet("LCLEAR");
  attachBarrel(0, 3200, 0);
  quiet("LAXIS 0 focus 3200 4000 0");
  /* 0% -> 100% -> 50% of travel over four seconds. */
  quiet("LKEY 0 0 0");
  quiet("LKEY 0 2000 65535");
  quiet("LKEY 0 4000 32768");
  eq(send("LSYNC 2"), "LSYNC 2 3", "the device holds every uploaded point");
  eq(send("ARM"), "READY 0 3", "ARM reports the cue count AND the lens point count");
  ok(g_barrels[0].pos == 0, "ARM pre-positions the barrel at the curve's first point");
  ok(send("GO").rfind("STARTED", 0) == 0, "GO starts a homed axis");

  advance(2000);
  ok(g_barrels[0].pos > 3100, "at t=2s the barrel is at the top of the pull (got " + std::to_string(g_barrels[0].pos) + ")");
  advance(2000);
  long want = 3200 / 2;
  ok(std::abs(g_barrels[0].pos - want) < 40,
     "at t=4s the barrel is at mid-travel (got " + std::to_string(g_barrels[0].pos) + ", want ~" + std::to_string(want) + ")");

  /* ---- ABORT holds -------------------------------------------------- */
  quiet("LCLEAR");
  quiet("LKEY 0 0 32768");
  quiet("LKEY 0 4000 0");
  quiet("ARM");
  quiet("GO");
  advance(1000);
  long midPull = g_barrels[0].pos;
  ok(midPull < want, "the pull is under way before the abort");
  quiet("ABORT");
  advance(3000);
  eq(std::to_string(g_barrels[0].pos), std::to_string(midPull),
     "ABORT stops the barrel where it was — it does not home and does not release");
  ok(g_pinState[LENS_EN_PINS[0]] == LOW, "the driver stays ENABLED after abort, so the barrel is held");

  /* ---- LSEEK -------------------------------------------------------- */
  quiet("LSEEK 0 65535");
  advance(2000);
  ok(g_barrels[0].pos > 3100, "LSEEK parks the barrel where it was told");

  printf("\n%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
