import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PCM_FRAME_BYTES } from "./encoder.js";

const childProcessMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  execSync: vi.fn(() => Buffer.from("ffmpeg version")),
}));

vi.mock("node:child_process", () => childProcessMock);

const { AudioPlayer } = await import("./player.js");

const logger = {
  child() {
    return this;
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function createMockFfmpegProcess() {
  const process = new EventEmitter() as any;
  process.stdin = new PassThrough();
  process.stdout = new PassThrough();
  process.stderr = new PassThrough();
  process.exitCode = null;
  process.signalCode = null;
  process.killed = false;
  process.pid = 4321;
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

describe("AudioPlayer external stream stall watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports stalled PCM streams when ffmpeg stays alive but stops producing PCM", async () => {
    const ffmpeg = createMockFfmpegProcess();
    childProcessMock.spawn.mockReturnValueOnce(ffmpeg);
    const player = new AudioPlayer(logger);
    const input = new PassThrough();
    const closedEvents: any[] = [];
    const failures: Error[] = [];

    player.playPcmStream(input, {
      suppressTrackEnd: true,
      onSourceClosed: (event) => {
        closedEvents.push(event);
      },
      onSourceFailure: (err) => {
        failures.push(err);
      },
    });

    ffmpeg.stdout.emit("data", Buffer.alloc(PCM_FRAME_BYTES));
    (player as any).pcmBuffer = Buffer.alloc(0);

    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.resolve();

    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]).toMatchObject({
      source: "pcm-stream",
      input: "stdin",
      gotData: true,
      reason: "stalled",
    });
    expect(failures[0]?.message).toContain("No PCM data received from pcm-stream");
    expect(ffmpeg.kill).toHaveBeenCalledWith("SIGTERM");
    player.stop({ skipCleanup: true });
  });

  it("ignores stale stream stall checks after the ffmpeg process closes", async () => {
    const ffmpeg = createMockFfmpegProcess();
    childProcessMock.spawn.mockReturnValueOnce(ffmpeg);
    const player = new AudioPlayer(logger);
    const input = new PassThrough();
    const closedEvents: any[] = [];

    player.playPcmStream(input, {
      suppressTrackEnd: true,
      onSourceClosed: (event) => {
        closedEvents.push(event);
      },
    });

    ffmpeg.stdout.emit("data", Buffer.alloc(PCM_FRAME_BYTES));
    ffmpeg.emit("close", 0, null);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(7_000);

    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]).toMatchObject({
      reason: "closed",
      gotData: true,
    });
    expect(ffmpeg.kill).not.toHaveBeenCalled();
  });
});
