/*
 * A host-side Arduino shim, so the reference firmware can be COMPILED and
 * EXERCISED on a machine with no board attached.
 *
 * This is not an emulator and does not pretend to be. It provides just enough
 * of the Arduino API to (a) prove the sketch compiles, and (b) drive the
 * protocol state machine and the curve interpolation against assertions. Motor
 * timing, StallGuard behaviour and electrical anything remain unverified until
 * hardware exists — the sketch says so, and so does the digest.
 */
#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#define HIGH 1
#define LOW 0
#define OUTPUT 1
#define INPUT 0
#define INPUT_PULLUP 2

/* ---- fake clock, advanced explicitly by the test ---- */
extern uint64_t g_micros;
inline uint32_t micros() { return (uint32_t)g_micros; }
inline uint32_t millis() { return (uint32_t)(g_micros / 1000ULL); }
inline void delayMicroseconds(uint32_t us) { g_micros += us; }
inline void delay(uint32_t ms) { g_micros += ms * 1000ULL; }

/* ---- pins ---- */
extern uint8_t g_pinMode[128];
extern uint8_t g_pinState[128];
/** Set by the test to make a STOP pin read as "hit". */
extern uint8_t g_pinInput[128];
extern uint64_t g_stepCount[128];

/**
 * A simulated lens barrel with two hard stops.
 *
 * This is the part that makes the calibration path testable at all: the sketch
 * measures travel by driving into stops, so the test needs something to drive
 * into. Each STEP rising edge moves the barrel in whatever direction the DIR
 * pin currently says, the position clamps at the ends, and the STOP pin reads
 * true at either end — which is what both a limit switch and a StallGuard DIAG
 * line do. Because DIR is read (not inferred), this also exercises the sketch's
 * `invert` handling rather than assuming it.
 */
struct FakeBarrel {
  uint8_t stepPin = 255, dirPin = 0, stopPin = 0;
  long pos = 0, travel = 0;
  bool attached = false;      // false = motor unplugged; it never reaches a stop
};
extern FakeBarrel g_barrels[4];

inline void pinMode(uint8_t p, uint8_t m) {
  g_pinMode[p] = m;
  /* A pin with the internal pull-up and nothing wired to it reads HIGH. Without
     this the sketch sees a phantom falling edge on every GPI at boot, which is
     the shim being wrong rather than the firmware. */
  if (m == INPUT_PULLUP) g_pinInput[p] = 1;
}
inline void digitalWrite(uint8_t p, uint8_t v) {
  if (v && !g_pinState[p]) {
    g_stepCount[p]++;                             // count rising edges (STEP pulses)
    for (auto &b : g_barrels) {
      if (b.stepPin != p || !b.attached) continue;
      b.pos += g_pinState[b.dirPin] ? +1 : -1;
      if (b.pos < 0) b.pos = 0;
      if (b.pos > b.travel) b.pos = b.travel;
      g_pinInput[b.stopPin] = (b.pos <= 0 || b.pos >= b.travel) ? 1 : 0;
    }
  }
  g_pinState[p] = v;
}
inline int digitalRead(uint8_t p) { return g_pinInput[p]; }
inline void analogWrite(uint8_t p, int v) { g_pinState[p] = v ? 1 : 0; }

/* ---- serial ---- */
struct FakeSerial {
  std::string out;             // everything the sketch printed
  std::string in;              // what the host has queued for it
  size_t inPos = 0;
  void begin(long) {}
  int available() { return (int)(in.size() - inPos); }
  int read() { return inPos < in.size() ? (unsigned char)in[inPos++] : -1; }
  int peek() { return inPos < in.size() ? (unsigned char)in[inPos] : -1; }
  void print(const char *s) { out += s; }
  void print(char c) { out += c; }
  void print(int v) { out += std::to_string(v); }
  void print(unsigned int v) { out += std::to_string(v); }
  void print(long v) { out += std::to_string(v); }
  void print(unsigned long v) { out += std::to_string(v); }
  void println() { out += "\r\n"; }
  void println(const char *s) { out += s; out += "\r\n"; }
  void println(int v) { out += std::to_string(v); out += "\r\n"; }
  void println(unsigned int v) { out += std::to_string(v); out += "\r\n"; }
  void println(long v) { out += std::to_string(v); out += "\r\n"; }
  void println(unsigned long v) { out += std::to_string(v); out += "\r\n"; }
};
extern FakeSerial Serial;
