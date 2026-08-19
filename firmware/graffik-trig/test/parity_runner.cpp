/*
 * C++ half of the protocol parity check: feed `parity-script.txt` to the
 * reference firmware and print everything it says back. `parity.mjs` runs the
 * same script through the TypeScript SimulatedTriggerDevice and diffs the two.
 *
 * Two implementations of one wire protocol drift silently, and the direction
 * that hurts is the simulator being MORE permissive than the board: every test
 * passes and the rig fails. This check exists because that had already happened
 * once (the simulator accepted `LAXIS 9` on a 3-axis board).
 */
#include "Arduino.h"
#include <fstream>
uint64_t g_micros = 0;
uint8_t g_pinMode[128] = {0}, g_pinState[128] = {0}, g_pinInput[128] = {0};
uint64_t g_stepCount[128] = {0};
FakeBarrel g_barrels[4];
FakeSerial Serial;
#include "../graffik-trig.ino"

int main(int argc, char **argv) {
  setup();
  /* A barrel with a known travel, so LCAL produces a number both sides agree
     on. The TypeScript device is given the same figure. */
  g_barrels[0] = FakeBarrel{ LENS_STEP_PINS[0], LENS_DIR_PINS[0], LENS_STOP_PINS[0], 1500, 4000, true };
  std::ifstream f(argc > 1 ? argv[1] : "parity-script.txt");
  if (!f) { fprintf(stderr, "cannot open parity script\n"); return 2; }
  std::string line;
  while (std::getline(f, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.empty() || line[0] == '#') continue;
    Serial.in += line; Serial.in += "\n";
    loop();
  }
  printf("%s", Serial.out.c_str());
  return 0;
}
