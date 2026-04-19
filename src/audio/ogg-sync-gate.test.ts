import { describe, expect, it } from "vitest";
import { OggSyncGate } from "./ogg-sync-gate.js";

function collect(gate: OggSyncGate): Buffer[] {
  const chunks: Buffer[] = [];
  gate.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return chunks;
}

function oggPage(headerType: number, payload: number[]): Buffer {
  return Buffer.from([
    0x4f, 0x67, 0x67, 0x53, // OggS
    0x00,
    headerType,
    ...payload,
  ]);
}

describe("OggSyncGate", () => {
  it("consumes input without output while discarding", () => {
    const gate = new OggSyncGate();
    const chunks = collect(gate);

    gate.beginDiscard("test");
    gate.write(Buffer.from([1, 2, 3, 4]));
    gate.write(oggPage(0x02, [5, 6, 7]));

    expect(chunks).toEqual([]);
    expect(gate.getStats()).toMatchObject({
      inputBytes: 13,
      outputBytes: 0,
      discardedBytes: 13,
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
      outputBytes: 9,
      mode: "passthrough",
      syncHits: 1,
    });
  });

  it("finds an Ogg BOS page split across chunks", () => {
    const gate = new OggSyncGate();
    const chunks = collect(gate);

    gate.syncToNextLogicalStream("split");
    gate.write(Buffer.from([1, 2, 0x4f, 0x67]));
    gate.write(Buffer.from([0x67, 0x53, 0x00, 0x02, 9, 10]));

    expect(Buffer.concat(chunks)).toEqual(oggPage(0x02, [9, 10]));
    expect(gate.getStats()).toMatchObject({
      outputBytes: 8,
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
      outputBytes: 7,
      mode: "passthrough",
      syncHits: 1,
    });
  });
});
