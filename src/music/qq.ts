import axios, { type AxiosInstance } from "axios";
import type {
  MusicAccount,
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
  private quality = "exhigh";
  private accounts = new Map<string, string>();
  private primaryAccountId: string | null = null;

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

  private extractUin(cookie: string): string | null {
    const match = /(?:^|; )uin=o?0?(\d+)/.exec(cookie);
    return match ? match[1] : null;
  }

  private makeAccountId(uin: string): string {
    return `qq:${uin}`;
  }

  private getResolvedAccountId(accountId?: string): string | null {
    if (accountId && this.accounts.has(accountId)) return accountId;
    if (this.primaryAccountId && this.accounts.has(this.primaryAccountId)) {
      return this.primaryAccountId;
    }
    return this.accounts.keys().next().value ?? null;
  }

  private getCookieForAccount(accountId?: string): string {
    const resolvedAccountId = this.getResolvedAccountId(accountId);
    return resolvedAccountId ? (this.accounts.get(resolvedAccountId) ?? "") : "";
  }

  private getCookieParams(accountId?: string): Record<string, string> {
    const cookie = this.getCookieForAccount(accountId);
    return cookie ? { cookie } : {};
  }

  private buildAccount(accountId: string): MusicAccount {
    const uin = accountId.replace(/^qq:/, "");
    return {
      id: accountId,
      name: `QQ音乐: QQ ${uin}`,
      platform: "qq",
      avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=100`,
    };
  }

  private mapSong(s: any, accountId?: string): Song {
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
      ...(accountId ? { accountId } : {}),
    };
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const res = await this.api.get("/getSearchByKey", {
      params: { key: query, pageSize: limit, limit, ...this.getCookieParams() },
    });

    const songs: Song[] = (res.data?.response?.data?.song?.list
      ?? res.data?.data?.song?.list
      ?? res.data?.data?.list
      ?? [])
      .map((s: any) => this.mapSong(s))
      .filter((s: Song) => s.id);

    return { songs, playlists: [], albums: [] };
  }

  async getSongUrl(songId: string, _quality?: string, song?: Song): Promise<string | null> {
    const res = await this.api.get("/getMusicPlay", {
      params: {
        songmid: songId,
        ...(song?.mediaId ? { mediaId: song.mediaId } : {}),
        ...this.getCookieParams(song?.accountId),
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
        params: { songmid: songId, ...this.getCookieParams() },
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
    return this.getPlaylistDetailForAccount(playlistId);
  }

  async getPlaylistDetailForAccount(playlistId: string, accountId?: string): Promise<PlaylistDetail | null> {
    const res = await this.api.get("/getSongListDetail", {
      params: { disstid: playlistId, ...this.getCookieParams(accountId) },
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
      ...(accountId ? { account: this.buildAccount(accountId) } : {}),
    };
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    return this.getPlaylistSongsForAccount(playlistId);
  }

  async getPlaylistSongsForAccount(playlistId: string, accountId?: string): Promise<Song[]> {
    const res = await this.api.get("/getSongListDetail", {
      params: { disstid: playlistId, ...this.getCookieParams(accountId) },
    });
    const cdlist = res.data?.response?.cdlist ?? [];
    if (cdlist.length === 0) return [];
    return (cdlist[0].songlist ?? [])
      .map((s: any) => this.mapSong(s, accountId))
      .filter((s: Song) => s.id);
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    const res = await this.api.get("/getSongLists", {
      params: { categoryId: 10000000, pageSize: 10, ...this.getCookieParams() },
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
      params: { albummid: albumId, ...this.getCookieParams() },
    });
    return (res.data?.response?.data?.list ?? [])
      .map((s: any) => this.mapSong(s))
      .filter((s: Song) => s.id);
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    const res = await this.api.get("/getLyric", {
      params: { songmid: songId, ...this.getCookieParams() },
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
      if (cookie) this.setCookie(cookie);
      return "confirmed";
    }
    if (body?.refresh === true) return "expired";
    if (typeof body?.message === "string" && body.message.includes("未扫描"))
      return "waiting";
    return "waiting";
  }

  setCookie(cookie: string): void {
    const uin = this.extractUin(cookie);
    if (!uin) return;
    const accountId = this.makeAccountId(uin);
    this.accounts.set(accountId, cookie);
    this.primaryAccountId = accountId;
  }

  getCookie(): string {
    return this.getCookieForAccount();
  }

  loadAccounts(accounts: Array<{ id: string; cookie: string }>, primaryId?: string | null): void {
    this.accounts.clear();
    for (const account of accounts) {
      if (account.id && account.cookie) {
        this.accounts.set(account.id, account.cookie);
      }
    }
    if (primaryId && this.accounts.has(primaryId)) {
      this.primaryAccountId = primaryId;
    } else {
      this.primaryAccountId = this.accounts.keys().next().value ?? null;
    }
  }

  setPrimaryAccount(accountId: string): boolean {
    if (!this.accounts.has(accountId)) return false;
    this.primaryAccountId = accountId;
    return true;
  }

  getPrimaryAccountId(): string | null {
    return this.getResolvedAccountId();
  }

  getAccounts(): Array<MusicAccount & { primary: boolean }> {
    const primaryId = this.getResolvedAccountId();
    return Array.from(this.accounts.keys())
      .sort((a, b) => (a === primaryId ? -1 : b === primaryId ? 1 : a.localeCompare(b)))
      .map((accountId) => ({
        ...this.buildAccount(accountId),
        primary: accountId === primaryId,
      }));
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const cookie = this.getCookieForAccount();
    if (!cookie) return { loggedIn: false };
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
    const uinMatch = /(?:^|; )uin=o?0?(\d+)/.exec(cookie);
    const uin = uinMatch ? uinMatch[1] : "";
    if (!uin) return { loggedIn: false };
    try {
      const res = await this.api.get("/user/getUserPlaylists", {
        params: { uin, ...this.getCookieParams(this.getResolvedAccountId()) },
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
    const accounts = this.getAccounts();
    if (accounts.length === 0) return [];
    const results = await Promise.allSettled(
      accounts.map((account) => this.getUserPlaylistsForAccount(account.id))
    );
    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  async getUserPlaylistsForAccount(accountId: string): Promise<Playlist[]> {
    const cookie = this.getCookieForAccount(accountId);
    if (!cookie) return [];
    const uinMatch = /(?:^|; )uin=o?0?(\d+)/.exec(cookie);
    const uin = uinMatch ? uinMatch[1] : "";
    if (!uin) return [];

    const account = this.buildAccount(accountId);
    const res = await this.api.get("/user/getUserPlaylists", {
      params: { uin, ...this.getCookieParams(accountId) },
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
