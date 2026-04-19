import { describe, expect, it } from "vitest";
import { AudioPlayer } from "./player.js";

const logger = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

function peakSample(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
  }
  return peak;
}

describe("AudioPlayer ducking", () => {
  it("fades volume down and back up when ducking toggles", () => {
    const player = new AudioPlayer(logger);
    const pcm = Buffer.alloc(3840);
    for (let i = 0; i < pcm.length; i += 2) {
      pcm.writeInt16LE(20000, i);
    }

    player.setVolume(10);
    const normal = peakSample((player as any).applyVolume(pcm));

    player.setDuckingActive(true);
    let ducked = normal;
    for (let i = 0; i < 12; i++) {
      ducked = peakSample((player as any).applyVolume(pcm));
    }

    player.setDuckingActive(false);
    let restored = ducked;
    for (let i = 0; i < 24; i++) {
      restored = peakSample((player as any).applyVolume(pcm));
    }

    expect(ducked).toBeLessThan(normal);
    expect(restored).toBeGreaterThan(ducked);
    expect(restored).toBe(normal);
  });
});
