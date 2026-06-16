import { describe, expect, it } from "vitest";
import {
  decideSpotifyEndOfTrack,
  decideSpotifySourceClose,
  getSpotifyEndWaitMaxMs,
  getSpotifyEndWaitPollMs,
  isGracefulSpotifySourceClose,
  SPOTIFY_END_WAIT_EARLY_EXTRA_MS,
  SPOTIFY_END_WAIT_LONG_POLL_MS,
  SPOTIFY_END_WAIT_MAX_MS,
  SPOTIFY_END_WAIT_POLL_MS,
} from "./spotify-recovery-policy.js";

describe("SpotifyRecoveryPolicy", () => {
  it("ignores early end_of_track while local playback still has meaningful audio", () => {
    const decision = decideSpotifyEndOfTrack({
      durationSeconds: 240,
      elapsedSeconds: 180,
      playerState: "playing",
    });

    expect(decision.action).toBe("ignore");
    expect(decision.remainingMs).toBeGreaterThan(10_000);
  });

  it("delays near-end end_of_track until local playback catches up", () => {
    const decision = decideSpotifyEndOfTrack({
      durationSeconds: 240,
      elapsedSeconds: 235,
      playerState: "playing",
    });

    expect(decision.action).toBe("delay");
    expect(decision.remainingMs).toBeGreaterThan(0);
    expect(decision.remainingMs).toBeLessThanOrEqual(10_000);
  });

  it("completes end_of_track when local playback is already at the end", () => {
    const decision = decideSpotifyEndOfTrack({
      durationSeconds: 240,
      elapsedSeconds: 240,
      playerState: "playing",
    });

    expect(decision.action).toBe("complete");
  });

  it("waits for early end_of_track long enough for local playback to finish", () => {
    const decision = decideSpotifyEndOfTrack({
      durationSeconds: 286,
      elapsedSeconds: 241.44,
      playerState: "playing",
    });

    expect(decision.action).toBe("ignore");
    expect(getSpotifyEndWaitMaxMs(decision)).toBeGreaterThanOrEqual(decision.remainingMs + SPOTIFY_END_WAIT_EARLY_EXTRA_MS);
    expect(getSpotifyEndWaitMaxMs(decision)).toBeGreaterThan(SPOTIFY_END_WAIT_MAX_MS);
  });

  it("uses a coarse poll while far from the local end and a tight poll near the end", () => {
    expect(getSpotifyEndWaitPollMs(44_000)).toBe(SPOTIFY_END_WAIT_LONG_POLL_MS);
    expect(getSpotifyEndWaitPollMs(2_000)).toBe(SPOTIFY_END_WAIT_POLL_MS);
    expect(getSpotifyEndWaitPollMs(50)).toBe(50);
  });

  it("recovers a real source close when the local track still has audio left", () => {
    const decision = decideSpotifySourceClose({
      remainingMs: 45_000,
      gracefulSourceEnd: false,
      softAttempts: 0,
      maxSoftAttempts: 2,
      hardAttempts: 0,
      maxHardAttempts: 1,
    });

    expect(decision.action).toBe("soft-recover");
    if (decision.action !== "soft-recover") throw new Error("expected soft recovery");
    expect(decision.nextAttempt).toBe(1);
  });

  it("uses a sidecar restart after soft source recovery attempts are exhausted", () => {
    const decision = decideSpotifySourceClose({
      remainingMs: 45_000,
      gracefulSourceEnd: false,
      softAttempts: 2,
      maxSoftAttempts: 2,
      hardAttempts: 0,
      maxHardAttempts: 1,
    });

    expect(decision.action).toBe("hard-recover");
    if (decision.action !== "hard-recover") throw new Error("expected hard recovery");
    expect(decision.nextAttempt).toBe(3);
  });

  it("advances only after all source recovery attempts are exhausted", () => {
    const decision = decideSpotifySourceClose({
      remainingMs: 45_000,
      gracefulSourceEnd: false,
      softAttempts: 2,
      maxSoftAttempts: 2,
      hardAttempts: 1,
      maxHardAttempts: 1,
    });

    expect(decision.action).toBe("advance-failed");
  });

  it("classifies a code=0 close with decoded data as graceful", () => {
    expect(isGracefulSpotifySourceClose({ code: 0, gotData: true })).toBe(true);
    expect(isGracefulSpotifySourceClose({ code: 234, gotData: false })).toBe(false);
  });
});
