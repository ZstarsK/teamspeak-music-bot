import { describe, expect, it } from "vitest";
import { QQMusicProvider } from "./qq.js";

describe("QQ Music adapter", () => {
  it("maps search results from current QQ search payload shape", async () => {
    const provider = new QQMusicProvider("http://example.test");
    (provider as any).api = {
      get: async () => ({
        data: {
          data: {
            song: {
              list: [
                {
                  mid: "0012g3Et1iFQCC",
                  name: "晴天",
                  interval: 269,
                  singer: [{ name: "周杰伦" }],
                  album: { mid: "001Q4q2X1Gz4Wk", name: "叶惠美" },
                  file: { media_mid: "004Z8Ihr0JIu5s" },
                },
              ],
            },
          },
        },
      }),
    };

    const result = await provider.search("晴天");

    expect(result.songs).toEqual([
      {
        id: "0012g3Et1iFQCC",
        name: "晴天",
        artist: "周杰伦",
        album: "叶惠美",
        duration: 269,
        coverUrl: "https://y.gtimg.cn/music/photo_new/T002R300x300M000001Q4q2X1Gz4Wk.jpg",
        platform: "qq",
        mediaId: "004Z8Ihr0JIu5s",
      },
    ]);
  });

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
