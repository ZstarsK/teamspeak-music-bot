import axios, { type AxiosInstance } from "axios";
import type {
  MusicProvider,
  Song,
  Playlist,
  PlaylistDetail,
  LyricLine,
  SearchResult,
  QrCodeResult,
  AuthStatus,
} from "./provider.js";
import { parseLyrics } from "./netease.js";

export class QQMusicProvider implements MusicProvider {
  readonly platform = "qq" as const;
  private api: AxiosInstance;
  private cookie = "";
  private quality = "exhigh";

  constructor(baseUrl: string) {
    this.api = axios.create({
      baseURL: baseUrl,
      timeout: 10000,
    });
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  private get cookieParams(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  private mapSong(s: any): Song {
    const id = String(s.songmid ?? s.mid ?? s.songMid ?? s.id ?? s.songid ?? "");
    const albumMid = s.albummid ?? s.album?.mid ?? s.album?.pmid ?? "";
    const mediaId = s.strMediaMid ?? s.media_mid ?? s.file?.media_mid ?? s.file?.mediaMid ?? "";
    return {
      id,
      name: s.songname ?? s.name ?? s.title ?? "",
      artist: (s.singer ?? []).map((a: any) => a.name ?? a.title).filter(Boolean).join(" / "),
      album: s.albumname ?? s.album?.name ?? s.album?.title ?? "",
      duration: s.interval ?? 0,
      coverUrl: albumMid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg`
        : "",
      platform: "qq",
      ...(mediaId ? { mediaId: String(mediaId) } : {}),
    };
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const res = await this.api.get("/getSearchByKey", {
      params: { key: query, pageSize: limit, ...this.cookieParams },
    });

    const songs: Song[] = (res.data?.response?.data?.song?.list ?? [])
      .map((s: any) => this.mapSong(s))
      .filter((s: Song) => s.id);

    return { songs, playlists: [], albums: [] };
  }

  async getSongUrl(songId: string, _quality?: string, song?: Song): Promise<string | null> {
    const res = await this.api.get("/getMusicPlay", {
      params: {
        songmid: songId,
        ...(song?.mediaId ? { mediaId: song.mediaId } : {}),
        ...this.cookieParams,
      },
    });
    const playUrl = res.data?.data?.playUrl?.[songId];
    return playUrl?.url || null;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    // Try /getSongInfo for full metadata, but fall through to a minimal
    // stub if the library endpoint fails (current @sansenjian/qq-music-api
    // returns upstream code 500001 for this route — the param format it
    // sends doesn't match QQ's current API). The bot's resolveAndPlay path
    // only needs `id` and `platform` to fetch a play URL, and the fallback
    // stub is sufficient to let /play-by-id and /add-by-id flows succeed.
    try {
      const res = await this.api.get("/getSongInfo", {
        params: { songmid: songId, ...this.cookieParams },
      });
      const s = res.data?.response?.data;
      if (s && s.track_info) {
        return this.mapSong(s.track_info);
      }
    } catch {
      // fall through to stub
    }
    // Minimal stub — resolveAndPlay only needs id + platform to fetch a
    // play URL. Name/artist/album will be empty in play history, but the
    // song will actually play, which is the important part.
    return {
      id: songId,
      name: "",
      artist: "",
      album: "",
      duration: 0,
      coverUrl: "",
      platform: "qq",
    };
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    const res = await this.api.get("/getSongListDetail", {
      params: { disstid: playlistId, ...this.cookieParams },
    });
    const cdlist = res.data?.response?.cdlist ?? [];
    const p = cdlist[0];
    if (!p) return null;

    return {
      id: String(p.disstid ?? p.dissid ?? playlistId),
      name: p.dissname ?? p.title ?? "",
      description: p.desc ?? p.dissdesc ?? p.description ?? "",
      coverUrl: p.logo ?? p.picurl ?? p.cover_url ?? "",
      songCount:
        Number(
          p.total_song_num ??
            p.songnum ??
            p.song_count ??
            p.songlist?.length ??
            0
        ) || 0,
      platform: "qq",
    };
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const res = await this.api.get("/getSongListDetail", {
      params: { disstid: playlistId, ...this.cookieParams },
    });
    const cdlist = res.data?.response?.cdlist ?? [];
    if (cdlist.length === 0) return [];
    return (cdlist[0].songlist ?? [])
      .map((s: any) => this.mapSong(s))
      .filter((s: Song) => s.id);
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    const res = await this.api.get("/getSongLists", {
      params: { categoryId: 10000000, pageSize: 10, ...this.cookieParams },
    });
    return (res.data?.response?.data?.list ?? []).map((p: any) => ({
      id: String(p.dissid),
      name: p.dissname ?? "",
      coverUrl: p.imgurl ?? "",
      songCount: p.listennum ?? 0,
      platform: "qq",
    }));
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const res = await this.api.get("/getAlbumInfo", {
      params: { albummid: albumId, ...this.cookieParams },
    });
    return (res.data?.response?.data?.list ?? [])
      .map((s: any) => this.mapSong(s))
      .filter((s: Song) => s.id);
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    const res = await this.api.get("/getLyric", {
      params: { songmid: songId, ...this.cookieParams },
    });
    return parseLyrics(
      res.data?.response?.lyric ?? res.data?.lyric ?? "",
      res.data?.response?.trans ?? res.data?.trans ?? ""
    );
  }

  async getQrCode(): Promise<QrCodeResult> {
    // @sansenjian/qq-music-api 2.x returns { img, qrsig, ptqrtoken } via
    // customResponse (no { response: ... } wrapping). /checkQQLoginQr
    // requires BOTH qrsig AND ptqrtoken — passing only one gives a 400
    // "参数错误". Pack both into the opaque `key` field so the polling
    // endpoint can split them back out. Separator "|" is safe: QQ tokens
    // are alphanumeric.
    const res = await this.api.get("/getQQLoginQr");
    const qrsig: string = res.data?.qrsig ?? "";
    const ptqrtoken: string = String(res.data?.ptqrtoken ?? "");
    return {
      qrUrl: "",
      qrImg: res.data?.img ?? "",
      key: `${qrsig}|${ptqrtoken}`,
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const [qrsig, ptqrtoken] = key.split("|");
    if (!qrsig || !ptqrtoken) return "expired";

    // NOTE: /checkQQLoginQr is registered as POST only in
    // @sansenjian/qq-music-api 2.x. GET returns 405 Method Not Allowed.
    let res;
    try {
      res = await this.api.post("/checkQQLoginQr", null, {
        params: { qrsig, ptqrtoken },
      });
    } catch {
      return "expired";
    }

    // customResponse shape:
    //   success:  { isOk: true, message: '登录成功', session: { cookie, ... } }
    //   scanning: { isOk: false, refresh: false, message: '未扫描二维码' }
    //   expired:  { isOk: false, refresh: true,  message: '二维码已失效' }
    const body = res.data;
    if (body?.isOk === true) {
      const cookie: string = body.session?.cookie ?? "";
      if (cookie) this.cookie = cookie;
      return "confirmed";
    }
    if (body?.refresh === true) return "expired";
    if (typeof body?.message === "string" && body.message.includes("未扫描"))
      return "waiting";
    return "waiting";
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie) return { loggedIn: false };
    // /getUserAvatar in @sansenjian/qq-music-api 2.x is NOT registered on
    // the main router; the real endpoint is /user/getUserAvatar, and even
    // that just builds a static URL from a uin without validating the
    // cookie against QQ. Round-trip through /user/getUserPlaylists which
    // actually hits QQ Music with the cookie; if the upstream returns
    // code=0, the cookie is valid.
    //
    // IMPORTANT: /user/getUserPlaylists requires `uin` as a query param —
    // the library 400s with "缺少 uin 参数" otherwise. Parse it out of the
    // cookie (uin=<qq>; comes after the various *uin prefixed names, which
    // is why the regex anchors on a word boundary).
    const uinMatch = /(?:^|; )uin=o?0?(\d+)/.exec(this.cookie);
    const uin = uinMatch ? uinMatch[1] : "";
    if (!uin) return { loggedIn: false };
    try {
      const res = await this.api.get("/user/getUserPlaylists", {
        params: { uin, ...this.cookieParams },
      });
      if (res.data?.response?.code !== 0) return { loggedIn: false };
      return {
        loggedIn: true,
        nickname: `QQ ${uin}`,
        avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=100`,
      };
    } catch {
      return { loggedIn: false };
    }
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    if (!this.cookie) return [];
    const uinMatch = /(?:^|; )uin=o?0?(\d+)/.exec(this.cookie);
    const uin = uinMatch ? uinMatch[1] : "";
    if (!uin) return [];

    const account = {
      id: `qq:${uin}`,
      name: `QQ音乐: QQ ${uin}`,
      platform: "qq" as const,
      avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=100`,
    };

    const res = await this.api.get("/user/getUserPlaylists", {
      params: { uin, ...this.cookieParams },
    });

    const playlists = res.data?.response?.data?.playlists ?? [];
    return playlists
      .filter((p: any) => p?.isshow !== 0 && p?.dir_show !== 0)
      .map((p: any) => {
        const subtitle = String(p.subtitle ?? "");
        const songCount = parseInt((/(\d+)首/.exec(subtitle)?.[1] ?? "0"), 10) || 0;
        return {
          id: String(p.dissid ?? p.tid ?? p.dirid),
          name: p.title ?? p.dissname ?? "",
          coverUrl: p.picurl ?? p.cover_url ?? "",
          songCount,
          platform: "qq",
          account,
        } satisfies Playlist;
      });
  }
}
