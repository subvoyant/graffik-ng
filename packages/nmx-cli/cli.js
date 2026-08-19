#!/usr/bin/env node
/**
 * nmx — headless Graffik NG runner.
 *
 *   nmx ports                          list serial ports
 *   nmx info  --port <path> | --sim    firmware version + handshake
 *   nmx run <file.graffik> --port <path> [--sim] [--passes N] [--cue S] [--motion-only]
 *   nmx stop  --port <path>            broadcast e-stop (program + KF)
 *
 * Same core, same solver, same command sequences as the app (ADR-0009/0010).
 */
import fs from "node:fs/promises";
import process from "node:process";
import { SerialPort } from "serialport";
import {
  NmxClient, SimulatedNmx, handshake,
  buildKeyFrameMove, runSequence, keyFrame, motors, general, broadcast,
  deserializeFilm, filmAxesToMs, filmDurationMs, filmCueMs, formatDuration, timebaseLabel,
} from "@graffik-ng/nmx-protocol";

const NMX_BAUD = 19200;
const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name) => args.includes(`--${name}`);
const die = (msg) => { console.error(`nmx: ${msg}`); process.exit(1); };

async function openClient() {
  if (has("sim")) {
    const sim = new SimulatedNmx();
    sim.startPhysics();
    return { client: new NmxClient(sim, { timeoutMs: 800 }), close: async () => sim.stopPhysics() };
  }
  const path = flag("port") ?? die("--port <path> required (or --sim)");
  const port = new SerialPort({ path, baudRate: NMX_BAUD, autoOpen: false });
  await new Promise((res, rej) => port.open((e) => (e ? rej(e) : res())));
  return {
    client: new NmxClient(port, { timeoutMs: 800 }),
    close: () => new Promise((res) => port.close(() => res())),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  switch (cmd) {
    case "ports": {
      for (const p of await SerialPort.list()) {
        console.log(`${p.path}\t${p.manufacturer ?? ""}`);
      }
      return;
    }

    case "info": {
      const { client, close } = await openClient();
      const v = await handshake(client);
      console.log(`firmware v${v.value}${v.value === 70 ? "" : "  ⚠ differs from verified v70 — programmed moves unsafe"}`);
      await close();
      return;
    }

    case "stop": {
      const { client, close } = await openClient();
      await client.stopAll();
      console.log("broadcast stop + KF-stop sent");
      await close();
      return;
    }

    case "run": {
      const file = args[1] ?? die("usage: nmx run <file.graffik> --port <path>");
      const passes = Number(flag("passes") ?? 1);
      const film = deserializeFilm(await fs.readFile(file, "utf-8"));

      /* This runner drives the NMX and nothing else. A move file can carry two
       * subsystems it has no link to — timeline cues (ADR-0016) and lens axes
       * (ADR-0018), both of which live on a GRAFFIK-TRIG board the CLI does not
       * open. Running anyway would report "pass complete" over a pass where the
       * focus never pulled. Say so, and make the operator say it back. */
      const ignored = [];
      if (film.events?.length) ignored.push(`${film.events.length} timeline cue(s) — no trigger backend here (ADR-0016)`);
      if (film.lensAxes?.length) ignored.push(`${film.lensAxes.length} lens axis/axes — no GRAFFIK-TRIG link here (ADR-0018)`);
      if (ignored.length) {
        for (const line of ignored) console.error(`nmx: WILL NOT RUN: ${line}`);
        if (!has("motion-only")) {
          die("this file needs the app, or pass --motion-only to run the motion axes alone");
        }
        console.error("nmx: --motion-only given; running the motion axes alone");
      }
      /* Soft limits are enforced in the app's main process against limits stored
       * in ITS preferences (ADR-0013). The CLI has no access to them, so it is not
       * a quieter app — it is an unguarded one. Never let that be a surprise. */
      console.error("nmx: soft travel limits are NOT enforced by the CLI — check the rig's clearance yourself (ADR-0013)");

      const cueS = Number(flag("cue") ?? Math.round(filmCueMs(film) / 1000));
      const { client, close } = await openClient();
      const cleanup = async () => { try { await client.stopAll(); await close(); } catch { /* gone */ } };
      process.on("SIGINT", async () => { console.log("\nSIGINT → e-stop"); await cleanup(); process.exit(130); });

      const v = await handshake(client);
      if (v.value !== 70 && !has("force")) {
        await close();
        die(`firmware v${v.value} ≠ verified v70; refusing programmed move (--force to override)`);
      }
      await client.send(general.setJoystickWatchdog(true));
      for (const m of [1, 2, 3]) await client.send(motors.setEnable(m, true));

      console.log(
        `uploading "${film.name}" — ${formatDuration(film.durationFrames, film.timebase)} ` +
        `@ ${timebaseLabel(film.timebase)}, ${film.axes.length} axes…`,
      );
      const packets = buildKeyFrameMove(filmAxesToMs(film), { videoTimeMs: filmDurationMs(film) });
      for (const p of packets) await client.send(p);

      for (let pass = 1; pass <= passes; pass++) {
        for (const { axis, points } of film.axes) {
          await client.send(motors.sendToPosition(axis + 1, Math.round(points[0].position)));
        }
        for (let s = cueS; s > 0; s--) { process.stdout.write(`\rpass ${pass}/${passes} in ${s}s… `); await sleep(1000); }
        process.stdout.write(`\rpass ${pass}/${passes} running   \n`);
        for (const p of runSequence()) await client.send(p);
        for (;;) {
          await sleep(1000);
          const state = await client.query(keyFrame.queryRunState());
          const pct = await client.query(keyFrame.queryPercentComplete());
          process.stdout.write(`\r  ${pct.value}%   `);
          if (state.value === 0 && Number(pct.value) > 0) break;
        }
        console.log(`\npass ${pass} complete`);
      }
      await close();
      return;
    }

    default:
      console.log("usage: nmx <ports|info|run|stop> [args]  (see header of cli.js)");
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => die(err.message));

/* e-stop reference: broadcast.stop()/kfStop() — used via client.stopAll() */
void broadcast;
