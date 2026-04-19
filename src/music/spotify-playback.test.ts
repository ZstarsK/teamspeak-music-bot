import { describe, expect, it } from "vitest";
import {
  buildLibrespotArgs,
  getSpotifyLibrespotCachePaths,
  isLibrespotAudioReadyEvent,
  shouldReuseSpotifyStreamForTrackSwitch,
} from "./spotify-playback.js";

describe("spotify librespot helpers", () => {
  it("builds sanitized account cache paths for credentials-cache mode", () => {
    const paths = getSpotifyLibrespotCachePaths("/tmp/spotify-librespot", {
      userId: "spotify:user@example.com",
    });

    expect(paths.accountKey).toBe("spotify_user_example.com");
    expect(paths.baseDir).toBe("/tmp/spotify-librespot/accounts/spotify_user_example.com");
    expect(paths.audioDir).toBe("/tmp/spotify-librespot/accounts/spotify_user_example.com/audio-cache");
    expect(paths.systemDir).toBe("/tmp/spotify-librespot/accounts/spotify_user_example.com/system-cache");
  });

  it("omits access-token when using credentials-cache mode", () => {
    const args = buildLibrespotArgs({
      mode: "credentials-cache",
      deviceName: "TSMusicBot Spotify",
      eventScriptPath: "/tmp/spotify-event.cjs",
      audioCacheDir: "/tmp/audio-cache",
      systemCacheDir: "/tmp/system-cache",
      usePassthrough: true,
    });

    expect(args).toContain("--system-cache");
    expect(args).toContain("/tmp/system-cache");
    expect(args).toContain("--disable-discovery");
    expect(args).toContain("--passthrough");
    expect(args[args.indexOf("--backend") + 1]).toBe("pipe");
    expect(args).not.toContain("--access-token");
  });

  it("uses S16 output when passthrough is disabled", () => {
    const args = buildLibrespotArgs({
      mode: "credentials-cache",
      deviceName: "TSMusicBot Spotify",
      eventScriptPath: "/tmp/spotify-event.cjs",
      audioCacheDir: "/tmp/audio-cache",
      systemCacheDir: "/tmp/system-cache",
      usePassthrough: false,
    });

    const formatIndex = args.indexOf("--format");
    expect(formatIndex).toBeGreaterThan(-1);
    expect(args[args.indexOf("--backend") + 1]).toBe("pipe");
    expect(args[formatIndex + 1]).toBe("S16");
  });

  it("passes access-token when using access-token mode", () => {
    const args = buildLibrespotArgs({
      mode: "access-token",
      deviceName: "TSMusicBot Spotify",
      eventScriptPath: "/tmp/spotify-event.cjs",
      audioCacheDir: "/tmp/audio-cache",
      systemCacheDir: "/tmp/system-cache",
      usePassthrough: true,
      accessToken: "abc123",
    });

    const index = args.indexOf("--access-token");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe("abc123");
  });

  it("reuses the spotify sidecar when the local player is still attached", () => {
    expect(shouldReuseSpotifyStreamForTrackSwitch({ sameProcess: true, playerState: "playing", outputMode: "encoded" })).toBe(true);
    expect(shouldReuseSpotifyStreamForTrackSwitch({ sameProcess: true, playerState: "paused", outputMode: "encoded" })).toBe(true);
    expect(shouldReuseSpotifyStreamForTrackSwitch({ sameProcess: true, playerState: "idle", outputMode: "encoded" })).toBe(false);
    expect(shouldReuseSpotifyStreamForTrackSwitch({ sameProcess: true, playerState: "playing", outputMode: "pcm" })).toBe(true);
    expect(shouldReuseSpotifyStreamForTrackSwitch({ sameProcess: true, playerState: "paused", outputMode: "pcm" })).toBe(true);
    expect(shouldReuseSpotifyStreamForTrackSwitch({ sameProcess: true, playerState: "idle", outputMode: "pcm" })).toBe(false);
    expect(shouldReuseSpotifyStreamForTrackSwitch({ sameProcess: false, playerState: "playing", outputMode: "encoded" })).toBe(false);
  });

  it("matches librespot audio-ready events for the target track", () => {
    expect(isLibrespotAudioReadyEvent(
      { PLAYER_EVENT: "playing", TRACK_ID: "abc", POSITION_MS: "1200" },
      { trackId: "abc" },
    )).toBe(true);
    expect(isLibrespotAudioReadyEvent(
      { PLAYER_EVENT: "loading", TRACK_ID: "abc" },
      { trackId: "abc" },
    )).toBe(false);
    expect(isLibrespotAudioReadyEvent(
      { PLAYER_EVENT: "playing", TRACK_ID: "old", POSITION_MS: "1200" },
      { trackId: "abc" },
    )).toBe(false);
  });

  it("requires seek events to be close to the target position", () => {
    expect(isLibrespotAudioReadyEvent(
      { PLAYER_EVENT: "seeked", TRACK_ID: "abc", POSITION_MS: "30200" },
      { trackId: "abc", targetProgressMs: 30_000 },
    )).toBe(true);
    expect(isLibrespotAudioReadyEvent(
      { PLAYER_EVENT: "seeked", TRACK_ID: "abc", POSITION_MS: "90000" },
      { trackId: "abc", targetProgressMs: 30_000 },
    )).toBe(false);
    expect(isLibrespotAudioReadyEvent(
      { PLAYER_EVENT: "started", TRACK_ID: "abc" },
      { trackId: "abc", targetProgressMs: 30_000 },
    )).toBe(false);
  });
});
