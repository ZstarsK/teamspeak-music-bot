import { describe, expect, it } from "vitest";
import { shouldForceTrackAdvance } from "./instance.js";

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
});
