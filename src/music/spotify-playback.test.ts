import { describe, expect, it } from "vitest";
import {
  buildLibrespotArgs,
  getSpotifyLibrespotCachePaths,
  shouldResetSpotifyPcmPipeline,
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
    });

    expect(args).toContain("--system-cache");
    expect(args).toContain("/tmp/system-cache");
    expect(args).toContain("--disable-discovery");
    expect(args).not.toContain("--access-token");
  });

  it("passes access-token when using access-token mode", () => {
    const args = buildLibrespotArgs({
      mode: "access-token",
      deviceName: "TSMusicBot Spotify",
      eventScriptPath: "/tmp/spotify-event.cjs",
      audioCacheDir: "/tmp/audio-cache",
      systemCacheDir: "/tmp/system-cache",
      accessToken: "abc123",
    });

    const index = args.indexOf("--access-token");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe("abc123");
  });

  it("resets the PCM pipeline when switching tracks on the same active spotify process", () => {
    expect(shouldResetSpotifyPcmPipeline({ sameProcess: true, playbackStarted: true })).toBe(true);
    expect(shouldResetSpotifyPcmPipeline({ sameProcess: true, playbackStarted: false })).toBe(false);
    expect(shouldResetSpotifyPcmPipeline({ sameProcess: false, playbackStarted: true })).toBe(false);
  });
});
