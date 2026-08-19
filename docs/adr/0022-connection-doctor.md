# ADR-0022: A connection doctor — one symptom, six causes

**Status:** Accepted (v0.15)
**Date:** 2026-08-19
**Deciders:** Project owner + Claude

## Context

Hardware arrives in two days. The single most likely way a first bring-up
session gets eaten is not a bug in the editor — it is ninety minutes spent on a
handshake that times out.

A failed handshake produces exactly **one** symptom for at least six unrelated
causes:

1. the USB cable is charge-only,
2. the NMX is not powered,
3. it is in BLE mode rather than USB,
4. the wrong port was picked from a list that is mostly Bluetooth entries,
5. the device address is not the default 3,
6. the port is open at the wrong baud rate.

They are indistinguishable from a timeout, so they get told apart by swapping
things one at a time. Every piece of evidence needed to separate them is already
observable — the app just never looked.

## Decision

### 1. Count the bytes. Silence and noise are different failures.

The distinction the whole feature turns on:

- **Zero bytes** means nothing is talking to us. Power, cable, mode, wrong port.
- **Bytes that never form a valid frame** means something *is* talking and we
  cannot hear it. That is a baud mismatch (the NMX is 19200 8N1) or a different
  device on that path entirely.

A timeout throws that distinction away. The probe taps the port's raw data
alongside the client so it survives.

### 2. Ask every plausible address before concluding anything

A non-default address is a legitimate configuration — it is how two controllers
share a bus — and it presents as a completely dead link. So the probe asks 3, 2,
4, 5, 6, 7, 8 and stops at the first answer. When one of them replies, the report
says *which*, and that a dead-looking rig is actually a correctly-working one
with a different address.

Broadcast (address 1) is skipped: it never replies, by design.

Having asked, the silence report **says it has asked**, so nobody spends any
more of the afternoon on an address that has already been ruled out.

### 3. The classification is a pure function

`explainProbe(probes, ctx)` takes evidence and returns a verdict, a headline and
ordered steps. No port, no timers, no IO — so the reasoning is the part under
test rather than the plumbing, and it can be reviewed by reading it. The probe
is a thin shell that gathers evidence and hands it over.

### 4. Rank the port list, but never hide anything

A macOS port list is mostly `Bluetooth-Incoming-Port`, `wlan-debug` and friends,
and on a first bring-up nobody knows which of eight identical-looking paths is
the rig. `judgePort` ranks by name and manufacturer, likely entries sort first,
and unlikely ones are **marked rather than removed** — hiding a port the operator
can see in the system would look like a missing device, which is a worse problem
than a cluttered list.

When nothing in the list looks usable at all, that is said before anything is
opened, because opening a Bluetooth port can block for seconds.

### 5. The button appears at the moment of failure

Offering "Diagnose…" before there is a problem is clutter that gets ignored.
Offering it the instant a connect fails is the only moment anybody will run it,
and it disappears again on a successful connect.

### 6. Failing to *open* the port is its own diagnosis

The probe never runs in that case, and it does not need to: "something else has
this port open" is a far more specific answer than anything a probe could infer,
and a serial monitor or a second copy of the app left running is a common cause.

## Consequences

- The first hardware session should spend its time on the rig rather than on a
  cable. That is the entire justification for building this now rather than
  after the rig arrives.
- The probe opens its **own** port. It runs when the normal connect has already
  failed, so there is nothing to reuse, and it must not disturb a connection
  that did succeed.
- `SimulatedNmx` gained `off()`. A real `SerialPort` can detach a listener and a
  simulator that cannot is a simulator that quietly leaks in any code which taps
  a port temporarily — which this does. Same rule as the firmware parity check:
  **the simulator must be at least as capable and at least as strict as the
  thing it stands in for.**
- **Unverified against a real NMX.** Every failure mode above is reasoned from
  the protocol and from how USB serial behaves on macOS. The first real session
  is also the first test of this, and the classifications should be corrected
  against what actually happens.

## Alternatives considered

**Better error text on the existing timeout.** Cheapest, and it can only ever
list all six causes — which is what a bring-up doc already does and what nobody
reads at the moment it matters.

**Auto-connect at whatever address answers.** Convenient, and it hides a rig
configuration the operator should know about; two controllers on one bus with
silently-adopted addresses is a much worse afternoon than one clear message.

**Probe automatically on every failed connect.** Tempting. Rejected because it
opens ports and writes to them without being asked, and a first-run failure is
sometimes just "I have not plugged it in yet" — seven probes deep into a
Bluetooth port is not a helpful response to that.
