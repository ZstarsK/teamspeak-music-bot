import { describe, expect, it } from "vitest";
import { OggSyncGate } from "./ogg-sync-gate.js";

function collect(gate: OggSyncGate): Buffer[] {
  const chunks: Buffer[] = [];
  gate.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return chunks;
}

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i++) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 0x80000000) !== 0
        ? ((value << 1) ^ 0x04c11db7)
        : value << 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function calculateOggCrc(page: Buffer): number {
  let crc = 0;
  for (let i = 0; i < page.length; i++) {
    const byte = i >= 22 && i < 26 ? 0 : page[i];
    crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) & 0xff) ^ byte]) >>> 0;
  }
  return crc >>> 0;
}

function oggPage(headerType: number, payload: number[]): Buffer {
  if (payload.length > 255) throw new Error("test helper only supports one Ogg segment");
  const body = Buffer.from(payload);
  const page = Buffer.alloc(28 + body.length);
  page.write("OggS", 0, "ascii");
  page[4] = 0;
  page[5] = headerType;
  page.writeUInt32LE(0x12345678, 14);
  page[26] = 1;
  page[27] = body.length;
  body.copy(page, 28);
  page.writeUInt32LE(calculateOggCrc(page), 22);
  return page;
}

describe("OggSyncGate", () => {
  it("consumes input without output while discarding", () => {
    const gate = new OggSyncGate();
    const chunks = collect(gate);

    gate.beginDiscard("test");
    gate.write(Buffer.from([1, 2, 3, 4]));
    const page = oggPage(0x02, [5, 6, 7]);
    gate.write(page);

    expect(chunks).toEqual([]);
    expect(gate.getStats()).toMatchObject({
      inputBytes: 4 + page.length,
      outputBytes: 0,
      discardedBytes: 4 + page.length,
      mode: "discard",
    });
  });

  it("releases from the next Ogg BOS page", () => {
    const gate = new OggSyncGate();
    const chunks = collect(gate);

    gate.syncToNextLogicalStream("switch");
    gate.write(Buffer.concat([
      Buffer.from([1, 2, 3]),
      oggPage(0x00, [4, 5, 6]),
      Buffer.from([7, 8]),
      oggPage(0x02, [9, 10, 11]),
    ]));

    expect(Buffer.concat(chunks)).toEqual(oggPage(0x02, [9, 10, 11]));
    expect(gate.getStats()).toMatchObject({
      outputBytes: oggPage(0x02, [9, 10, 11]).length,
      mode: "passthrough",
      syncHits: 1,
    });
  });

  it("finds an Ogg BOS page split across chunks", () => {
    const gate = new OggSyncGate();
    const chunks = collect(gate);

    gate.syncToNextLogicalStream("split");
    gate.write(Buffer.from([1, 2, 0x4f, 0x67]));
    gate.write(oggPage(0x02, [9, 10]).subarray(2));

    expect(Buffer.concat(chunks)).toEqual(oggPage(0x02, [9, 10]));
    expect(gate.getStats()).toMatchObject({
      outputBytes: oggPage(0x02, [9, 10]).length,
      mode: "passthrough",
      syncHits: 1,
    });
  });

  it("ignores Ogg-looking BOS pages with an invalid CRC", () => {
    const gate = new OggSyncGate();
    const chunks = collect(gate);
    const invalidPage = oggPage(0x02, [1, 2, 3]);
    invalidPage[invalidPage.length - 1] ^= 0xff;
    const validPage = oggPage(0x02, [4, 5, 6]);

    gate.syncToNextLogicalStream("crc");
    gate.write(Buffer.concat([invalidPage, validPage]));

    expect(Buffer.concat(chunks)).toEqual(validPage);
    expect(gate.getStats()).toMatchObject({
      discardedBytes: invalidPage.length,
      outputBytes: validPage.length,
      mode: "passthrough",
      syncHits: 1,
    });
  });

  it("can switch from discard to sync mode on release", () => {
    const gate = new OggSyncGate();
    const chunks = collect(gate);

    gate.beginDiscard("release");
    gate.write(Buffer.from([1, 2, 3]));
    gate.endDiscard({ syncToOggPage: true });
    gate.write(Buffer.concat([Buffer.from([4, 5]), oggPage(0x02, [6])]));

    expect(Buffer.concat(chunks)).toEqual(oggPage(0x02, [6]));
    expect(gate.getStats()).toMatchObject({
      outputBytes: oggPage(0x02, [6]).length,
      mode: "passthrough",
      syncHits: 1,
    });
  });
});
