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

interface QQMusicApiSearchModule {
  default?: {
    getSearchByKey?: (params: any) => Promise<any>;
    getSmartbox?: (params: any) => Promise<any>;
  };
  getSearchByKey?: (params: any) => Promise<any>;
  getSmartbox?: (params: any) => Promise<any>;
}

let qqMusicApiSearchModulePromise: Promise<QQMusicApiSearchModule> | null = null;

function loadQQMusicApiSearchModule(): Promise<QQMusicApiSearchModule> {
  qqMusicApiSearchModulePromise ??= import("@sansenjian/qq-music-api/dist/module/index.js") as Promise<QQMusicApiSearchModule>;
  return qqMusicApiSearchModulePromise;
}

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

  private async validateAccount(accountId?: string): Promise<boolean> {
    const cookie = this.getCookieForAccount(accountId);
    if (!cookie) return false;
    const uinMatch = /(?:^|; )uin=o?0?(\d+)/.exec(cookie);
    const uin = uinMatch ? uinMatch[1] : "";
    if (!uin) return false;
    try {
      const res = await this.api.get("/user/getUserPlaylists", {
        params: { uin, ...this.getCookieParams(accountId) },
      });
      return res.data?.response?.code === 0;
    } catch {
      return false;
    }
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

  private mapSmartboxSong(s: any): Song {
    return {
      id: String(s.mid ?? s.songmid ?? s.id ?? ""),
      name: s.name ?? s.songname ?? "",
      artist: s.singer ?? s.singername ?? "",
      album: s.albumname ?? "",
      duration: Number(s.interval ?? 0) || 0,
      coverUrl: s.pic ?? "",
      platform: "qq",
    };
  }

  protected async loadEmbeddedSearchModule(): Promise<QQMusicApiSearchModule> {
    return loadQQMusicApiSearchModule();
  }

  private extractSearchSongs(payload: any): Song[] {
    const list = payload?.response?.data?.song?.list
      ?? payload?.data?.song?.list
      ?? payload?.data?.list
      ?? [];
    return list
      .map((s: any) => this.mapSong(s))
      .filter((s: Song) => s.id);
  }

  private extractSmartboxSongs(payload: any): Song[] {
    const list = payload?.response?.data?.song?.itemlist
      ?? payload?.response?.data?.result?.songList
      ?? payload?.data?.song?.itemlist
      ?? payload?.data?.result?.songList
      ?? [];
    return list
      .map((s: any) => this.mapSmartboxSong(s))
      .filter((s: Song) => s.id);
  }

  private async searchViaEmbeddedModule(query: string, limit: number): Promise<Song[]> {
    const mod = await this.loadEmbeddedSearchModule();
    const getSearchByKey = mod.getSearchByKey ?? mod.default?.getSearchByKey;
    const getSmartbox = mod.getSmartbox ?? mod.default?.getSmartbox;

    if (typeof getSearchByKey === "function") {
      try {
        const res = await getSearchByKey({
          method: "get",
          params: {
            w: query,
            n: limit,
            p: 1,
            catZhida: 1,
            remoteplace: "txt.yqq.song",
          },
          option: {},
        });
        const songs = this.extractSearchSongs(res?.body ?? res);
        if (songs.length > 0) return songs;
      } catch {
        // fall through to smartbox fallback
      }
    }

    if (typeof getSmartbox === "function") {
      const res = await getSmartbox({
        method: "get",
        params: { key: query },
        option: {},
      });
      return this.extractSmartboxSongs(res?.body ?? res).slice(0, limit);
    }

    return [];
  }

  private async searchViaApiServer(query: string, limit: number): Promise<Song[]> {
    const res = await this.api.get("/getSearchByKey", {
      params: {
        key: query,
        page: 1,
        limit,
        catZhida: 1,
        remoteplace: "song",
      },
    });

    const songs = this.extractSearchSongs(res.data);
    if (songs.length > 0) return songs;

    const smartboxRes = await this.api.get("/getSmartbox", {
      params: { key: query },
    });
    return this.extractSmartboxSongs(smartboxRes.data).slice(0, limit);
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const keyword = query.trim();
    if (!keyword) return { songs: [], playlists: [], albums: [] };

    try {
      const songs = await this.searchViaEmbeddedModule(keyword, limit);
      return { songs, playlists: [], albums: [] };
    } catch {
      try {
        const songs = await this.searchViaApiServer(keyword, limit);
        return { songs, playlists: [], albums: [] };
      } catch {
        return { songs: [], playlists: [], albums: [] };
      }
    }
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

  async getAccountsWithStatus(): Promise<Array<MusicAccount & { primary: boolean; valid: boolean }>> {
    const accounts = this.getAccounts();
    const validity = await Promise.all(
      accounts.map(async (account) => ({
        id: account.id,
        valid: await this.validateAccount(account.id),
      }))
    );
    const validityMap = new Map(validity.map((entry) => [entry.id, entry.valid]));
    return accounts.map((account) => ({
      ...account,
      valid: validityMap.get(account.id) ?? false,
    }));
  }

  removeAccount(accountId: string): boolean {
    if (!this.accounts.has(accountId)) return false;
    this.accounts.delete(accountId);
    if (this.primaryAccountId === accountId) {
      this.primaryAccountId = this.accounts.keys().next().value ?? null;
    }
    return true;
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const resolvedAccountId = this.getResolvedAccountId();
    const cookie = this.getCookieForAccount(resolvedAccountId ?? undefined);
    if (!cookie) return { loggedIn: false };
    const uinMatch = /(?:^|; )uin=o?0?(\d+)/.exec(cookie);
    const uin = uinMatch ? uinMatch[1] : "";
    if (!uin) return { loggedIn: false };
    if (!(await this.validateAccount(resolvedAccountId ?? undefined))) {
      return { loggedIn: false };
    }
    return {
      loggedIn: true,
      nickname: `QQ ${uin}`,
      avatarUrl: `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=100`,
    };
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
