import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayMode } from "../audio/queue.js";
import { chooseInitialQueueIndex, shouldForceTrackAdvance } from "./instance.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shouldForceTrackAdvance", () => {
  it("forces advance when playback stalls near the reported end", () => {
    expect(
      shouldForceTrackAdvance({
        playerState: "playing",
        duration: 271,
        elapsed: 270.2,
        msSinceLastFrame: 2600,
      }),
    ).toBe(true);
  });

  it("does not force advance while frames are still flowing", () => {
    expect(
      shouldForceTrackAdvance({
        playerState: "playing",
        duration: 271,
        elapsed: 270.2,
        msSinceLastFrame: 200,
      }),
    ).toBe(false);
  });

  it("does not force advance when far from the track end", () => {
    expect(
      shouldForceTrackAdvance({
        playerState: "playing",
        duration: 271,
        elapsed: 120,
        msSinceLastFrame: 5000,
      }),
    ).toBe(false);
  });

  it("does not force advance quickly for Spotify because librespot has its own end signal", () => {
    expect(
      shouldForceTrackAdvance({
        playerState: "playing",
        platform: "spotify",
        duration: 271,
        elapsed: 270.2,
        msSinceLastFrame: 2600,
      }),
    ).toBe(false);
  });

  it("still has a conservative Spotify stall fallback near the true end", () => {
    expect(
      shouldForceTrackAdvance({
        playerState: "playing",
        platform: "spotify",
        duration: 271,
        elapsed: 270.8,
        msSinceLastFrame: 16_000,
      }),
    ).toBe(true);
  });
});

describe("chooseInitialQueueIndex", () => {
  it("uses the requested start index when provided", () => {
    expect(
      chooseInitialQueueIndex({
        mode: PlayMode.Random,
        queueSize: 8,
        startIndex: 5,
      }),
    ).toBe(5);
  });

  it("uses the first song for sequential modes", () => {
    expect(
      chooseInitialQueueIndex({
        mode: PlayMode.Loop,
        queueSize: 8,
      }),
    ).toBe(0);
  });

  it("picks a random initial index for random modes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.6);
    expect(
      chooseInitialQueueIndex({
        mode: PlayMode.RandomLoop,
        queueSize: 5,
      }),
    ).toBe(3);
  });

  it("rejects invalid start indices", () => {
    expect(
      chooseInitialQueueIndex({
        mode: PlayMode.Sequential,
        queueSize: 3,
        startIndex: 4,
      }),
    ).toBeNull();
  });
});
