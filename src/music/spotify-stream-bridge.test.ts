import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SpotifyStreamBridge } from "./spotify-stream-bridge.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

describe("SpotifyStreamBridge", () => {
  it("attaches encoded streams through a gated externally controlled player source", () => {
    const bridge = new SpotifyStreamBridge(logger);
    const source = new PassThrough();
    const calls: string[] = [];
    const player = {
      playEncodedStream(input: NodeJS.ReadableStream, options: any) {
        calls.push(`encoded:${options.inputFormat}:${Boolean(input)}`);
      },
      stop() {
        calls.push("stop");
      },
    } as any;

    bridge.setSource(source, "encoded");
    bridge.attachPlayer(player, { cleanup() {} });

    expect(calls).toEqual(["encoded:ogg:true"]);
    expect(bridge.isStreamAttachedTo(player)).toBe(true);

    bridge.prepareEncodedBoundary(player, "spotify:track:old");

    expect(calls).toEqual(["encoded:ogg:true", "stop"]);
    expect(bridge.isStreamAttachedTo(player)).toBe(false);
  });

  it("attaches PCM streams through the PCM gate", () => {
    const bridge = new SpotifyStreamBridge(logger);
    const source = new PassThrough();
    const calls: string[] = [];
    const player = {
      playPcmStream(input: NodeJS.ReadableStream, options: any) {
        calls.push(`pcm:${options.inputSampleRate}:${Boolean(input)}`);
      },
    } as any;

    bridge.setSource(source, "pcm");
    bridge.attachPlayer(player, { cleanup() {} });

    expect(calls).toEqual(["pcm:44100:true"]);
    expect(bridge.isStreamAttachedTo(player)).toBe(true);
  });
});
