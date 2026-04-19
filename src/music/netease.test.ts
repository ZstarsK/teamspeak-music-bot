import { describe, it, expect } from "vitest";
import { NeteaseProvider, parseLyrics } from "./netease.js";

describe("NetEase adapter", () => {
  it("parses LRC format lyrics", () => {
    const lrc = `[00:00.00] 作词 : 周杰伦
[00:01.00] 作曲 : 周杰伦
[00:12.50]故事的小黄花
[00:15.80]从出生那年就飘着`;

    const lines = parseLyrics(lrc);
    expect(lines).toHaveLength(2);
    expect(lines[0].time).toBeCloseTo(12.5, 1);
    expect(lines[0].text).toBe("故事的小黄花");
    expect(lines[1].time).toBeCloseTo(15.8, 1);
    expect(lines[1].text).toBe("从出生那年就飘着");
  });

  it("handles empty lyrics", () => {
    const lines = parseLyrics("");
    expect(lines).toHaveLength(0);
  });

  it("merges translation lyrics", () => {
    const lrc = "[00:12.50]Hello world";
    const tlyric = "[00:12.50]你好世界";
    const lines = parseLyrics(lrc, tlyric);
    expect(lines[0].text).toBe("Hello world");
    expect(lines[0].translation).toBe("你好世界");
  });

  it("keeps multiple NetEase accounts and allows switching primary account", async () => {
    const provider = new NeteaseProvider("http://example.test");
    (provider as any).api = {
      get: async (url: string, options?: { params?: Record<string, string> }) => {
        if (url !== "/login/status") {
          throw new Error(`Unexpected URL: ${url}`);
        }
        const cookie = options?.params?.cookie ?? "";
        if (cookie === "MUSIC_U=alice;") {
          return {
            data: {
              data: {
                profile: {
                  userId: 1001,
                  nickname: "Alice",
                  avatarUrl: "https://example.com/alice.png",
                },
              },
            },
          };
        }
        if (cookie === "MUSIC_U=bob;") {
          return {
            data: {
              data: {
                profile: {
                  userId: 1002,
                  nickname: "Bob",
                  avatarUrl: "https://example.com/bob.png",
                },
              },
            },
          };
        }
        return { data: { data: {} } };
      },
    };

    const alice = await provider.upsertAccountFromCookie("MUSIC_U=alice;", true);
    const bob = await provider.upsertAccountFromCookie("MUSIC_U=bob;", false);

    expect(alice?.id).toBe("netease:1001");
    expect(bob?.id).toBe("netease:1002");
    expect(provider.getAccounts().map((account) => ({
      id: account.id,
      primary: account.primary,
    }))).toEqual([
      { id: "netease:1001", primary: true },
      { id: "netease:1002", primary: false },
    ]);

    expect(provider.setPrimaryAccount("netease:1002")).toBe(true);
    expect(provider.getPrimaryAccountId()).toBe("netease:1002");
    expect(provider.removeAccount("netease:1001")).toBe(true);
    expect(provider.getAccounts()[0]?.id).toBe("netease:1002");
  });
});
