import { describe, expect, it } from "vitest";
import { BotProfileManager } from "./profile.js";
import type { QueuedSong } from "../audio/queue.js";

const logger = {
  child() {
    return this;
  },
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any;

const profileConfig = {
  avatarEnabled: true,
  descriptionEnabled: true,
  nicknameEnabled: true,
  awayStatusEnabled: true,
  channelDescEnabled: true,
  nowPlayingMsgEnabled: true,
};

describe("BotProfileManager", () => {
  it("uses the music note, song name, and artist while playing", () => {
    const manager = new BotProfileManager({} as any, logger, profileConfig, "MusicBot");
    const song: QueuedSong = {
      id: "1",
      name: "富士山下",
      artist: "陈奕迅",
      album: "What's Going On...?",
      duration: 259,
      coverUrl: "",
      platform: "netease",
    };

    expect((manager as any).buildNickname(song)).toBe("♪ 富士山下-陈奕迅");
  });

  it("caps the nickname at 30 characters without appending ellipsis or bot name", () => {
    const manager = new BotProfileManager({} as any, logger, profileConfig, "MusicBot");
    const song: QueuedSong = {
      id: "1",
      name: "1234567890123456789012345678",
      artist: "ABCDEFGHIJ",
      album: "Album",
      duration: 200,
      coverUrl: "",
      platform: "netease",
    };

    const nickname = (manager as any).buildNickname(song) as string;
    expect(nickname.startsWith("♪ ")).toBe(true);
    expect(nickname.includes("MusicBot")).toBe(false);
    expect(nickname.includes("…")).toBe(false);
    expect(Array.from(nickname)).toHaveLength(30);
    expect(nickname).toBe("♪ 1234567890123456789012345678");
  });

  it("uses remaining nickname space for the artist", () => {
    const manager = new BotProfileManager({} as any, logger, profileConfig, "MusicBot");
    const song: QueuedSong = {
      id: "1",
      name: "12345678901234567890",
      artist: "ABCDEFGHIJKLMN",
      album: "Album",
      duration: 200,
      coverUrl: "",
      platform: "netease",
    };

    expect((manager as any).buildNickname(song)).toBe("♪ 12345678901234567890-ABCDEFG");
  });
});
