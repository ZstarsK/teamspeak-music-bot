import { describe, expect, it } from "vitest";
import { SpotifyPlaybackSession } from "./spotify-playback-session.js";

describe("SpotifyPlaybackSession", () => {
  it("treats callbacks from older commands as stale", () => {
    const session = new SpotifyPlaybackSession();
    const first = session.beginPlay({
      trackUri: "spotify:track:a",
      trackId: "a",
      durationSeconds: 100,
    });
    const second = session.beginPlay({
      trackUri: "spotify:track:b",
      trackId: "b",
      durationSeconds: 200,
    });

    expect(session.isCurrent(first)).toBe(false);
    expect(session.isCurrent(second)).toBe(true);
    expect(session.isCurrentTrack(first, "spotify:track:a", "a")).toBe(false);
    expect(session.isCurrentTrack(second, "spotify:track:b", "b")).toBe(true);
  });

  it("resets recovery counters for each new track", () => {
    const session = new SpotifyPlaybackSession();
    session.beginPlay({ trackUri: "spotify:track:a", trackId: "a", durationSeconds: 100 });
    expect(session.reserveSoftRecovery()).toBe(1);
    expect(session.reserveHardRecovery(2, 1)).toBe(3);

    session.beginPlay({ trackUri: "spotify:track:b", trackId: "b", durationSeconds: 100 });

    expect(session.reserveSoftRecovery()).toBe(1);
    expect(session.reserveHardRecovery(2, 1)).toBe(3);
  });

  it("rejects hard recovery attempts after the configured limit", () => {
    const session = new SpotifyPlaybackSession();
    session.beginPlay({ trackUri: "spotify:track:a", trackId: "a", durationSeconds: 100 });

    expect(session.reserveHardRecovery(2, 1)).toBe(3);
    expect(session.reserveHardRecovery(2, 1)).toBe(null);
  });

  it("can restore recovery counters across a forced sidecar restart", () => {
    const session = new SpotifyPlaybackSession();
    session.beginPlay({ trackUri: "spotify:track:a", trackId: "a", durationSeconds: 100 });
    session.restoreRecoveryCounters("spotify:track:a", 2, 1);

    expect(session.getSoftRecoveryAttempts()).toBe(2);
    expect(session.getHardRecoveryAttempts()).toBe(1);
    expect(session.reserveHardRecovery(2, 1)).toBe(null);
  });

  it("can restore active track after process-level cleanup without changing command id", () => {
    const session = new SpotifyPlaybackSession();
    const command = session.beginPlay({ trackUri: "spotify:track:a", trackId: "a", durationSeconds: 100 });

    session.clearActive();
    session.setActiveTrack({ trackUri: "spotify:track:a", trackId: "a", durationSeconds: 100 });

    expect(session.isCurrent(command)).toBe(true);
    expect(session.isCurrentTrack(command, "spotify:track:a", "a")).toBe(true);
  });

  it("treats recovery as a new command while preserving same-track recovery counters", () => {
    const session = new SpotifyPlaybackSession();
    const playCommand = session.beginPlay({ trackUri: "spotify:track:a", trackId: "a", durationSeconds: 100 });
    expect(session.reserveSoftRecovery()).toBe(1);

    const recoveryCommand = session.beginRecovery({ trackUri: "spotify:track:a", trackId: "a", durationSeconds: 100 });

    expect(session.isCurrent(playCommand)).toBe(false);
    expect(session.isCurrent(recoveryCommand)).toBe(true);
    expect(session.getSoftRecoveryAttempts()).toBe(1);
  });
});
