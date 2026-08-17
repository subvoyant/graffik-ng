/*
 * GRAFFIK-TRIG — reference trigger firmware for Graffik NG (ADR-0016)
 * MIT licensed, same as the rest of the project.
 *
 * WHY THIS EXISTS
 * ---------------
 * The NMX executes the camera move on its own hardware, which is what makes a
 * pass repeatable. Cues have exactly the same problem: a cue fired by the host
 * arrives with ~±20 ms of jitter that is different every pass, and at 24 fps
 * that is half a frame. Anything an audience will see A/B'd between passes —
 * a focus pull, an animatronic, a practical dimming — has to be timed by
 * something with its own clock.
 *
 * So this board takes the whole cue list BEFORE the pass and runs it from
 * millis(). The host sends one GO. Host jitter then shifts the entire pass
 * uniformly instead of smearing the cues inside it, which is the difference
 * between a move you can composite and one you cannot.
 *
 * WIRING
 * ------
 *   Outputs 1..OUT_COUNT  -> OUT_PINS below. Drive opto-isolators, MOSFETs or
 *                            relay boards; do NOT drive a solenoid or a lamp
 *                            directly from a microcontroller pin.
 *   Inputs 1..IN_COUNT    -> IN_PINS, INPUT_PULLUP, active LOW.
 *                            Wire a camera run/stop signal or a foot switch
 *                            here to start a pass from the camera rather than
 *                            from a mouse click.
 *
 * PROTOCOL (v1, line-oriented ASCII, 115200 baud)
 * -----------------------------------------------
 *   -> HELLO                     <- GRAFFIK-TRIG 1 <name> <outs> <ins>
 *   -> CLEAR
 *   -> CUE <id> <ms> <out> PULSE <ms>
 *   -> CUE <id> <ms> <out> LEVEL <0-255>
 *   -> ARM                       <- READY <count>
 *   -> GO                        <- STARTED <deviceMs>
 *   -> ABORT
 *   -> FIRE <out> PULSE <ms>     (immediate, Tier-1 style)
 *                                <- FIRED <id> <deviceMs>
 *                                <- IN <n> <RISE|FALL> <deviceMs>
 *                                <- DONE <deviceMs>
 *
 * Text, not binary, on purpose: anyone can implement this on any board, debug
 * it in a serial monitor, and read a session transcript when a cue fires late
 * on set at 2 a.m. The bytes we would save are bytes nobody needs saved.
 *
 * SAFETY
 * ------
 * ABORT must cancel everything immediately, and the host wires it into its
 * e-stop. Outputs are driven LOW on boot and on ABORT. If you attach anything
 * that moves, add a hardware kill switch in series — this firmware is a timer,
 * not a safety system.
 */

#include <Arduino.h>

static const char DEVICE_NAME[] = "graffik-trig";
static const uint8_t PROTOCOL_VERSION = 1;

/* ---- configure for your board ---- */
static const uint8_t OUT_PINS[] = { 2, 3, 4, 5, 6, 7, 8, 9 };
static const uint8_t IN_PINS[]  = { 10, 11 };
static const uint8_t OUT_COUNT  = sizeof(OUT_PINS);
static const uint8_t IN_COUNT   = sizeof(IN_PINS);
static const uint8_t MAX_CUES   = 64;

struct Cue {
  uint16_t id;
  uint32_t atMs;      // from GO
  uint8_t  out;       // 1-based
  uint8_t  kind;      // 0 = pulse, 1 = level
  uint16_t arg;       // pulse width ms, or level 0-255
  bool     fired;
};

static Cue cues[MAX_CUES];
static uint8_t cueCount = 0;
static bool running = false;
static uint32_t startedAt = 0;

/* Pulses are released without blocking — delay() inside a cue would make every
   later cue late, which is precisely the failure this board exists to avoid. */
static uint32_t pulseUntil[sizeof(OUT_PINS)];
static bool lastInput[sizeof(IN_PINS)];

static char line[96];
static uint8_t lineLen = 0;

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
    // analogWrite where the pin supports it; otherwise treat as on/off.
    analogWrite(OUT_PINS[idx], arg);
    pulseUntil[idx] = 0;
  }
}

static void handleLine(char *s) {
  char *verb = strtok(s, " ");
  if (!verb) return;

  if (!strcmp(verb, "HELLO")) {
    Serial.print("GRAFFIK-TRIG ");
    Serial.print(PROTOCOL_VERSION); Serial.print(' ');
    Serial.print(DEVICE_NAME);      Serial.print(' ');
    Serial.print(OUT_COUNT);        Serial.print(' ');
    Serial.println(IN_COUNT);
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
    Serial.print("READY "); Serial.println(cueCount);
    return;
  }

  if (!strcmp(verb, "GO")) {
    startedAt = millis();
    running = true;
    for (uint8_t i = 0; i < cueCount; i++) cues[i].fired = false;
    Serial.print("STARTED "); Serial.println(startedAt);
    return;
  }

  if (!strcmp(verb, "ABORT")) {
    running = false;
    cueCount = 0;
    allOutputsOff();
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
    if (!remaining) {
      running = false;
      Serial.print("DONE "); Serial.println(now);
    }
  }

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
