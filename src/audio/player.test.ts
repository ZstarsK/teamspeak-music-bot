import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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

function mockFfmpegProcess() {
  const process = new EventEmitter() as any;
  process.stdin = { destroy: vi.fn() };
  process.stdout = { destroy: vi.fn() };
  process.stderr = { destroy: vi.fn() };
  process.exitCode = null;
  process.signalCode = null;
  process.killed = false;
  process.pid = 1234;
  process.kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === "SIGTERM") {
      process.killed = true;
    }
    if (signal === "SIGKILL") {
      process.signalCode = "SIGKILL";
    }
    return true;
  });
  return process;
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
    player.setDuckingConfig({ enabled: true, volumePercent: 20, recoveryMs: 300, thresholdDb: -42 });
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

  it("waits for a future audio frame without waiting for old frames", async () => {
    vi.useFakeTimers();
    const player = new AudioPlayer(logger);
    (player as any).lastFrameAt = 1000;

    let resolved = false;
    const wait = player.waitForNextFrame(500).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(false);

    (player as any).lastFrameAt = Date.now();
    await vi.advanceTimersByTimeAsync(50);
    await wait;

    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it("stops waiting for a future audio frame after timeout", async () => {
    vi.useFakeTimers();
    const player = new AudioPlayer(logger);

    const wait = player.waitForNextFrame(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(wait).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("force kills a stopped ffmpeg process that does not close", async () => {
    vi.useFakeTimers();
    const player = new AudioPlayer(logger);
    const ffmpeg = mockFfmpegProcess();
    (player as any).ffmpeg = ffmpeg;
    (player as any).ffmpegProcesses.add(ffmpeg);

    player.stop();

    expect(ffmpeg.stdin.destroy).toHaveBeenCalled();
    expect(ffmpeg.stdout.destroy).toHaveBeenCalled();
    expect(ffmpeg.stderr.destroy).toHaveBeenCalled();
    expect(ffmpeg.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1500);
    expect(ffmpeg.kill).toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });

  it("does not force kill ffmpeg after the close handler forgets it", async () => {
    vi.useFakeTimers();
    const player = new AudioPlayer(logger);
    const ffmpeg = mockFfmpegProcess();
    (player as any).ffmpegProcesses.add(ffmpeg);

    (player as any).terminateFfmpegProcess(ffmpeg, "test");
    (player as any).forgetFfmpegProcess(ffmpeg);
    await vi.advanceTimersByTimeAsync(1500);

    expect(ffmpeg.kill).toHaveBeenCalledWith("SIGTERM");
    expect(ffmpeg.kill).not.toHaveBeenCalledWith("SIGKILL");
    vi.useRealTimers();
  });
});
