import { describe, expect, it } from "vitest";
import { PcmGate } from "./pcm-gate.js";

function collect(gate: PcmGate): Buffer[] {
  const chunks: Buffer[] = [];
  gate.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return chunks;
}

describe("PcmGate", () => {
  it("outputs only complete stereo sample blocks", () => {
    const gate = new PcmGate();
    const chunks = collect(gate);

    gate.write(Buffer.from([1, 2, 3]));
    expect(chunks).toEqual([]);
    expect(gate.getStats().bufferedBytes).toBe(3);

    gate.write(Buffer.from([4]));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(gate.getStats().bufferedBytes).toBe(0);

    gate.write(Buffer.from([5, 6, 7, 8, 9]));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(gate.getStats().bufferedBytes).toBe(1);
  });

  it("consumes input without output while discarding", () => {
    const gate = new PcmGate();
    const chunks = collect(gate);

    gate.beginDiscard("test");
    gate.write(Buffer.from([1, 2, 3, 4]));
    gate.write(Buffer.from([5, 6, 7, 8, 9]));

    expect(chunks).toEqual([]);
    expect(gate.getStats()).toMatchObject({
      inputBytes: 9,
      outputBytes: 0,
      discardedBytes: 8,
      bufferedBytes: 1,
      discarding: true,
    });
  });

  it("drops residual bytes when releasing discard with alignment reset", () => {
    const gate = new PcmGate();
    const chunks = collect(gate);

    gate.beginDiscard("switch");
    gate.write(Buffer.from([1, 2, 3]));
    gate.endDiscard({ resetAlignment: true });
    gate.write(Buffer.from([4, 5, 6, 7]));
    expect(chunks).toEqual([]);
    expect(gate.getStats()).toMatchObject({
      discardedBytes: 4,
      bufferedBytes: 3,
      pendingAlignmentDropBytes: 0,
    });

    gate.write(Buffer.from([8]));

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([5, 6, 7, 8]));
    expect(gate.getStats()).toMatchObject({
      outputBytes: 4,
      discardedBytes: 4,
      bufferedBytes: 0,
      discarding: false,
    });
  });
});
