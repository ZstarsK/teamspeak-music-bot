import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { AudioPlayer } from "./player.js";
import { getDefaultDuckingSettings } from "../data/config.js";

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
    player.setDuckingConfig(getDefaultDuckingSettings());
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

  it("respects configured ducking percentage", () => {
    const player = new AudioPlayer(logger);
    player.setDuckingConfig({ enabled: true, volumePercent: 20, recoveryMs: 300 });
    const pcm = Buffer.alloc(3840);
    for (let i = 0; i < pcm.length; i += 2) {
      pcm.writeInt16LE(20000, i);
    }

    player.setVolume(10);
    player.setDuckingActive(true);
    let ducked = 0;
    for (let i = 0; i < 12; i++) {
      ducked = peakSample((player as any).applyVolume(pcm));
    }

    expect(ducked).toBe(400);
  });

  it("clamps volume using the configured max volume", () => {
    const player = new AudioPlayer(logger, { maxVolume: 12 });
    player.setVolume(99);
    expect(player.getVolume()).toBe(12);
  });

  it("flushes buffered pcm without breaking stereo sample alignment", () => {
    const player = new AudioPlayer(logger);
    (player as any).pcmBuffer = Buffer.from([1, 2, 3, 4, 5, 6, 7]);

    player.flushBufferedAudio();

    expect((player as any).pcmBuffer).toEqual(Buffer.from([5, 6, 7]));
    expect(player.getBufferedAudioBytes()).toBe(0);
  });

  it("discards pcm output while preserving stream byte alignment", () => {
    const player = new AudioPlayer(logger);
    (player as any).pcmBuffer = Buffer.from([1, 2, 3]);

    player.setDiscardingAudio(true);
    (player as any).discardPcmChunk(Buffer.from([4, 5, 6, 7, 8, 9]));

    expect((player as any).pcmBuffer).toEqual(Buffer.from([9]));
    expect(player.getBufferedAudioBytes()).toBe(0);
  });

  it("reports structured source close data for externally controlled streams", async () => {
    const player = new AudioPlayer(logger);
    const input = new PassThrough();
    const events: any[] = [];
    let resolveEvent!: () => void;
    const eventPromise = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });

    player.playEncodedStream(input, {
      inputFormat: "ogg",
      suppressTrackEnd: true,
      onSourceClosed: (event) => {
        events.push(event);
        resolveEvent();
      },
    });
    input.end(Buffer.from("not an ogg stream"));
    await Promise.race([
      eventPromise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    player.stop({ skipCleanup: true });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "encoded-stream",
      gotData: false,
      framesPlayed: 0,
      reason: "closed",
    });
    expect(typeof events[0].elapsed).toBe("number");
  });
});
