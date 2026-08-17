/**
 * NMX MoCoBus packet codec.
 *
 * Implemented fresh from the official Dynamic Perception protocol
 * documentation ("NMX Commands 0.13 w-data types", "MotionEngineProtocol")
 * and validated byte-for-byte against the sample packets shipped inside the
 * nanoMoCo_Firmware repository (Sample Commands.txt).
 *
 * Wire format (host -> device):
 *   00 00 00 00 00 FF | address | subaddress | command | length | payload...
 *
 * - All multi-byte payload values are BIG ENDIAN.
 * - Default device address over USB is 3. Address 1 is the broadcast address.
 * - Subaddress routing: 0 = main controller / program engine,
 *   1..3 = motors (slide/pan/tilt), 4 = camera, 5 = key-frame engine.
 * - USB serial runs at 19200 baud, 8N1.
 */

export const PACKET_HEADER = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x00, 0xff]);

/** Default NMX device address on USB serial. */
export const DEFAULT_ADDRESS = 3;
/** MoCoBus broadcast address. */
export const BROADCAST_ADDRESS = 1;

export const enum SubAddress {
  General = 0,
  Motor1 = 1,
  Motor2 = 2,
  Motor3 = 3,
  Camera = 4,
  KeyFrame = 5,
}

export interface Packet {
  address: number;
  subAddress: number;
  command: number;
  payload: Uint8Array;
}

function assertByte(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`${name} must be an integer 0..255, got ${value}`);
  }
}

/** Encode a packet into the exact bytes written to the serial port. */
export function encodePacket(p: Packet): Uint8Array {
  assertByte(p.address, "address");
  assertByte(p.subAddress, "subAddress");
  assertByte(p.command, "command");
  if (p.payload.length > 254) {
    throw new RangeError(`payload too long: ${p.payload.length} (max 254)`);
  }
  const out = new Uint8Array(PACKET_HEADER.length + 4 + p.payload.length);
  out.set(PACKET_HEADER, 0);
  out[6] = p.address;
  out[7] = p.subAddress;
  out[8] = p.command;
  out[9] = p.payload.length;
  out.set(p.payload, 10);
  return out;
}

/** Big-endian payload builders (protocol is big-endian for all multi-byte values). */
export const be = {
  u8(v: number): Uint8Array {
    assertByte(v, "u8");
    return Uint8Array.from([v]);
  },
  i16(v: number): Uint8Array {
    if (!Number.isInteger(v) || v < -0x8000 || v > 0x7fff) throw new RangeError(`i16 out of range: ${v}`);
    const u = v < 0 ? v + 0x10000 : v;
    return Uint8Array.from([(u >>> 8) & 0xff, u & 0xff]);
  },
  u16(v: number): Uint8Array {
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) throw new RangeError(`u16 out of range: ${v}`);
    return Uint8Array.from([(v >>> 8) & 0xff, v & 0xff]);
  },
  u32(v: number): Uint8Array {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new RangeError(`u32 out of range: ${v}`);
    return Uint8Array.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  },
  i32(v: number): Uint8Array {
    if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new RangeError(`i32 out of range: ${v}`);
    return be.u32(v >>> 0 === v ? v : v + 0x1_0000_0000);
  },
  f32(v: number): Uint8Array {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, false);
    return new Uint8Array(buf);
  },
  concat(...parts: Uint8Array[]): Uint8Array {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  },
};

/**
 * Streaming response parser.
 *
 * Device responses use the same 00x5 FF header framing. Feed raw serial bytes
 * in with push(); complete packets are returned as they are recognized.
 * Response payload convention (per firmware OM_Serial_Com_Client.ino):
 *  - set/action commands respond 0x01 (success) or 0x00 (fail)
 *  - query commands (>=100) respond with a data-type byte followed by the value
 */
export class ResponseParser {
  private buffer: number[] = [];

  push(chunk: Uint8Array): Packet[] {
    for (const b of chunk) this.buffer.push(b);
    const packets: Packet[] = [];
    for (;;) {
      const start = this.findHeader();
      if (start < 0) {
        // keep at most header-1 trailing bytes that could be a partial header
        if (this.buffer.length > PACKET_HEADER.length) {
          this.buffer = this.buffer.slice(this.buffer.length - PACKET_HEADER.length + 1);
        }
        return packets;
      }
      if (start > 0) this.buffer = this.buffer.slice(start);
      // header(6) + addr + subaddr + command + len
      if (this.buffer.length < 10) return packets;
      const len = this.buffer[9];
      if (this.buffer.length < 10 + len) return packets;
      packets.push({
        address: this.buffer[6],
        subAddress: this.buffer[7],
        command: this.buffer[8],
        payload: Uint8Array.from(this.buffer.slice(10, 10 + len)),
      });
      this.buffer = this.buffer.slice(10 + len);
    }
  }

  private findHeader(): number {
    outer: for (let i = 0; i + PACKET_HEADER.length <= this.buffer.length; i++) {
      for (let j = 0; j < PACKET_HEADER.length; j++) {
        if (this.buffer[i + j] !== PACKET_HEADER[j]) continue outer;
      }
      return i;
    }
    return -1;
  }
}
