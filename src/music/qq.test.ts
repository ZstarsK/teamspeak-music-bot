import { describe, expect, it } from "vitest";
import { QQMusicProvider } from "./qq.js";

describe("QQ Music adapter", () => {
  it("maps playlist songs from current QQ songlist shape", async () => {
    const provider = new QQMusicProvider("http://example.test");
    (provider as any).api = {
      get: async () => ({
        data: {
          response: {
            cdlist: [
              {
                songlist: [
                  {
                    id: 205651247,
                    mid: "000avZ7R1PADbh",
                    name: "太多",
                    interval: 271,
                    singer: [{ name: "陈冠蒲" }],
                    album: { mid: "003KQjyV0iODqP", name: "新蜀山剑侠 电视原声带1" },
                    file: { media_mid: "003TULnJ1Tr9Hf" },
                  },
                ],
              },
            ],
          },
        },
      }),
    };

    const songs = await provider.getPlaylistSongs("3615835273");

    expect(songs).toEqual([
      {
        id: "000avZ7R1PADbh",
        name: "太多",
        artist: "陈冠蒲",
        album: "新蜀山剑侠 电视原声带1",
        duration: 271,
        coverUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000003KQjyV0iODqP.jpg",
        platform: "qq",
        mediaId: "003TULnJ1Tr9Hf",
      },
    ]);
  });

  it("keeps multiple QQ accounts and allows switching primary account", () => {
    const provider = new QQMusicProvider("http://example.test");
    provider.setCookie("uin=o12345; foo=bar;");
    provider.setCookie("uin=o67890; foo=baz;");

    expect(provider.getAccounts().map((account) => ({
      id: account.id,
      primary: account.primary,
    }))).toEqual([
      { id: "qq:67890", primary: true },
      { id: "qq:12345", primary: false },
    ]);

    expect(provider.setPrimaryAccount("qq:12345")).toBe(true);
    expect(provider.getPrimaryAccountId()).toBe("qq:12345");
    expect(provider.getAccounts()[0]?.id).toBe("qq:12345");
    expect(provider.getAccounts()[0]?.primary).toBe(true);
  });
});
