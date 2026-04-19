import { describe, expect, it } from "vitest";
import { BotProfileManager, getImageDownloadHeaders, isPngBuffer } from "./profile.js";
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
  it("detects png signature correctly", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);

    expect(isPngBuffer(png)).toBe(true);
    expect(isPngBuffer(jpeg)).toBe(false);
  });

  it("adds bilibili headers for hdslb image downloads", () => {
    expect(getImageDownloadHeaders("https://i1.hdslb.com/bfs/archive/test.jpg")).toEqual({
      Referer: "https://www.bilibili.com/",
      "User-Agent": "Mozilla/5.0",
    });
    expect(getImageDownloadHeaders("https://music.126.net/test.jpg")).toEqual({});
  });

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
