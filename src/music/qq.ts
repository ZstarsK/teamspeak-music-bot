import axios, { type AxiosInstance } from "axios";
import type {
  MusicProvider,
  Song,
  Playlist,
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

  async search(query: string, limit = 20): Promise<SearchResult> {
    const res = await this.api.get("/getSearchByKey", {
      params: { key: query, pageSize: limit, ...this.cookieParams },
    });

    const songs: Song[] = (res.data?.response?.data?.song?.list ?? []).map(
      (s: any) => ({
        id: String(s.songmid ?? s.songid),
        name: s.songname ?? "",
        artist: (s.singer ?? []).map((a: any) => a.name).join(" / "),
        album: s.albumname ?? "",
        duration: s.interval ?? 0,
        coverUrl: s.albummid
          ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg`
          : "",
        platform: "qq",
      })
    );

    return { songs, playlists: [], albums: [] };
  }

  async getSongUrl(songId: string, _quality?: string): Promise<string | null> {
    const res = await this.api.get("/getMusicPlay", {
      params: { songmid: songId, ...this.cookieParams },
    });
    const playUrl = res.data?.data?.playUrl?.[songId];
    return playUrl?.url || null;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    // getSongInfo requires cookie; use search as fallback
    try {
      const res = await this.api.get("/getSongInfo", {
        params: { songmid: songId, ...this.cookieParams },
      });
      const s = res.data?.response?.data;
      if (s && s.track_info) {
        const t = s.track_info;
        return {
          id: String(t.mid ?? t.id),
          name: t.name ?? "",
          artist: (t.singer ?? []).map((a: any) => a.name).join(" / "),
          album: t.album?.name ?? "",
          duration: t.interval ?? 0,
          coverUrl: t.album?.mid
            ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${t.album.mid}.jpg`
            : "",
          platform: "qq",
        };
      }
    } catch {
      // fallback: search by songmid (less reliable)
    }
    return null;
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    const res = await this.api.get("/getSongListDetail", {
      params: { disstid: playlistId, ...this.cookieParams },
    });
    const cdlist = res.data?.response?.cdlist ?? [];
    if (cdlist.length === 0) return [];
    return (cdlist[0].songlist ?? []).map((s: any) => ({
      id: String(s.songmid ?? s.songid),
      name: s.songname ?? s.name ?? "",
      artist: (s.singer ?? []).map((a: any) => a.name).join(" / "),
      album: s.albumname ?? "",
      duration: s.interval ?? 0,
      coverUrl: s.albummid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg`
        : "",
      platform: "qq",
    }));
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
    return (res.data?.response?.data?.list ?? []).map((s: any) => ({
      id: String(s.songmid ?? s.songid),
      name: s.songname ?? "",
      artist: (s.singer ?? []).map((a: any) => a.name).join(" / "),
      album: s.albumname ?? "",
      duration: s.interval ?? 0,
      coverUrl: s.albummid
        ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg`
        : "",
      platform: "qq",
    }));
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
    const res = await this.api.get("/getQQLoginQr");
    const qrsig = res.data?.qrsig ?? "";
    const ptqrtoken = res.data?.ptqrtoken ?? "";
    // @sansenjian/qq-music-api's checkQQLoginQr requires BOTH qrsig and
    // ptqrtoken, so encode both into the opaque key the caller polls with.
    return {
      qrUrl: "",
      qrImg: res.data?.img ?? "",
      key: qrsig && ptqrtoken ? `${qrsig}|${ptqrtoken}` : "",
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const [qrsig, ptqrtoken] = key.split("|");
    if (!qrsig || !ptqrtoken) return "expired";
    try {
      // /checkQQLoginQr is POST, and the success body is
      // { isOk, refresh, message, session: { cookie, ... } }
      const res = await this.api.post("/checkQQLoginQr", null, {
        params: { qrsig, ptqrtoken },
      });
      if (res.data?.isOk) {
        const cookie = res.data?.session?.cookie;
        if (cookie) {
          this.cookie = cookie;
        }
        return "confirmed";
      }
      if (res.data?.refresh) return "expired";
      // The upstream lib does not distinguish "scanned" from "waiting"
      return "waiting";
    } catch {
      return "expired";
    }
  }

  setCookie(cookie: string): void {
    this.cookie = cookie;
  }

  getCookie(): string {
    return this.cookie;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    if (!this.cookie) return { loggedIn: false };

    // @sansenjian/qq-music-api does not expose a dedicated "am I logged in"
    // endpoint. /user/getUserAvatar only builds a static avatar URL from a
    // uin and never talks to QQ, so it cannot be used to validate a cookie.
    // Instead, parse the uin from the cookie and round-trip it through
    // /user/getUserPlaylists, which actually hits QQ Music's servers using
    // the provided cookie. A successful response (code=0) means the cookie
    // is still valid.
    const uinMatch = this.cookie.match(/(?:^|;\s*)uin=([^;]+)/);
    const uin = uinMatch?.[1];
    if (!uin) return { loggedIn: false };

    try {
      const res = await this.api.get("/user/getUserPlaylists", {
        params: { uin, limit: 1, ...this.cookieParams },
      });
      if (res.data?.response?.code !== 0) {
        return { loggedIn: false };
      }
      return {
        loggedIn: true,
        nickname: `QQ ${uin}`,
        avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=140`,
      };
    } catch {
      return { loggedIn: false };
    }
  }
}
