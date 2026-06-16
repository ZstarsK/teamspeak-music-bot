import { describe, expect, it, vi } from "vitest";
import { calculatePcmRmsDb, DuckingDetector } from "./ducking-detector.js";
import { getDefaultDuckingSettings } from "../data/config.js";
import type { Encoder } from "./encoder.js";
import type { TS3VoiceData } from "../ts-protocol/client.js";

const logger = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

function pcmFrame(sample: number): Buffer {
  const pcm = Buffer.alloc(3840);
  for (let i = 0; i < pcm.length; i += 2) {
    pcm.writeInt16LE(sample, i);
  }
  return pcm;
}

function packet(clientId = 1): TS3VoiceData {
  return {
    clientId,
    codec: 4,
    data: Buffer.from([1, 2, 3]),
  };
}

function encoderFor(pcm: Buffer): Encoder {
  return {
    encode() {
      return Buffer.alloc(0);
    },
    decode() {
      return pcm;
    },
  };
}

describe("DuckingDetector", () => {
  it("calculates RMS level in dBFS", () => {
    expect(calculatePcmRmsDb(Buffer.alloc(3840))).toBe(-120);
    expect(calculatePcmRmsDb(pcmFrame(32767))).toBeCloseTo(0, 1);
    expect(calculatePcmRmsDb(pcmFrame(3277))).toBeCloseTo(-20, 1);
  });

  it("requires consecutive frames over threshold before triggering", () => {
    let now = 0;
    const detector = new DuckingDetector({
      logger,
      encoder: encoderFor(pcmFrame(6000)),
      now: () => now,
      sampleIntervalMs: 0,
      requiredConsecutiveFrames: 2,
    });
    const settings = { ...getDefaultDuckingSettings(), thresholdDb: -25 };

    expect(detector.shouldTrigger(packet(), settings)).toBe(false);
    now += 60;
    expect(detector.shouldTrigger(packet(), settings)).toBe(true);
  });

  it("does not trigger when sampled audio is below threshold", () => {
    const detector = new DuckingDetector({
      logger,
      encoder: encoderFor(pcmFrame(500)),
      sampleIntervalMs: 0,
      requiredConsecutiveFrames: 1,
    });
    const settings = { ...getDefaultDuckingSettings(), thresholdDb: -25 };

    expect(detector.shouldTrigger(packet(), settings)).toBe(false);
  });

  it("skips packets inside the per-client sample interval", () => {
    let now = 0;
    const decode = vi.fn(() => pcmFrame(6000));
    const detector = new DuckingDetector({
      logger,
      encoder: {
        encode() {
          return Buffer.alloc(0);
        },
        decode,
      },
      now: () => now,
      sampleIntervalMs: 60,
      requiredConsecutiveFrames: 1,
    });
    const settings = { ...getDefaultDuckingSettings(), thresholdDb: -30 };

    expect(detector.shouldTrigger(packet(), settings)).toBe(true);
    now += 20;
    expect(detector.shouldTrigger(packet(), settings)).toBe(false);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it("ignores undecodable packets", () => {
    const detector = new DuckingDetector({
      logger,
      encoder: {
        encode() {
          return Buffer.alloc(0);
        },
        decode() {
          throw new Error("bad opus");
        },
      },
      sampleIntervalMs: 0,
      requiredConsecutiveFrames: 1,
    });

    expect(detector.shouldTrigger(packet(), getDefaultDuckingSettings())).toBe(false);
  });
});
