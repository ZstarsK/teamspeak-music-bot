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

export function parseLyrics(lrc: string, tlyric?: string): LyricLine[] {
  if (!lrc) return [];

  const parseLine = (
    line: string
  ): { time: number; text: string } | null => {
    const match = line.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.+)$/);
    if (!match) return null;
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    const ms = parseInt(match[3].padEnd(3, "0"), 10);
    const text = match[4].trim();

    if (/^(作词|作曲|编曲|制作|混音|母带)\s*[:：]/.test(text)) return null;

    return { time: minutes * 60 + seconds + ms / 1000, text };
  };

  const lines: LyricLine[] = [];
  const translationMap = new Map<number, string>();

  if (tlyric) {
    for (const line of tlyric.split("\n")) {
      const parsed = parseLine(line);
      if (parsed) {
        translationMap.set(Math.round(parsed.time * 100), parsed.text);
      }
    }
  }

  for (const line of lrc.split("\n")) {
    const parsed = parseLine(line);
    if (parsed) {
      const timeKey = Math.round(parsed.time * 100);
      lines.push({
        time: parsed.time,
        text: parsed.text,
        translation: translationMap.get(timeKey),
      });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

// NetEase quality levels: standard(128k) higher(192k) exhigh(320k) lossless(flac) hires(hi-res) jyeffect jymaster
export const NETEASE_QUALITY_LEVELS = [
  { value: "standard", label: "标准 (128kbps)", bitrate: 128 },
  { value: "higher", label: "较高 (192kbps)", bitrate: 192 },
  { value: "exhigh", label: "极高 (320kbps)", bitrate: 320 },
  { value: "lossless", label: "无损 (FLAC)", bitrate: 900 },
  { value: "hires", label: "Hi-Res", bitrate: 1500 },
  { value: "jymaster", label: "超清母带", bitrate: 4000 },
] as const;

export interface NeteaseAccountRecord {
  id: string;
  uid: string;
  cookie: string;
  nickname?: string;
  avatarUrl?: string;
}

export class NeteaseProvider implements MusicProvider {
  readonly platform = "netease" as const;
  private api: AxiosInstance;
  private fallbackCookie = "";
  private quality = "exhigh";
  private accounts = new Map<string, NeteaseAccountRecord>();
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

  private makeAccountId(uid: string): string {
    return `netease:${uid}`;
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
    if (resolvedAccountId) {
      return this.accounts.get(resolvedAccountId)?.cookie ?? "";
    }
    return this.fallbackCookie;
  }

  private getCookieParams(accountId?: string): Record<string, string> {
    const cookie = this.getCookieForAccount(accountId);
    return cookie ? { cookie } : {};
  }

  private buildAccount(accountId: string): MusicAccount {
    const account = this.accounts.get(accountId);
    const uid = account?.uid ?? accountId.replace(/^netease:/, "");
    return {
      id: accountId,
      name: account?.nickname ? `网易云: ${account.nickname}` : `网易云: ${uid}`,
      platform: "netease",
      ...(account?.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
    };
  }

  private mapSong(s: any, accountId?: string): Song {
    return {
      id: String(s.id),
      name: s.name,
      artist: (s.ar ?? s.artists ?? []).map((a: any) => a.name).join(" / "),
      album: s.al?.name ?? s.album?.name ?? "",
      duration: Math.round((s.dt ?? s.duration ?? 0) / 1000),
      coverUrl: s.al?.picUrl ?? s.album?.picUrl ?? "",
      platform: "netease",
      ...(accountId ? { accountId } : {}),
    };
  }

  private async resolveAccountFromCookie(cookie: string): Promise<NeteaseAccountRecord | null> {
    if (!cookie) return null;
    const res = await this.api.get("/login/status", {
      params: { cookie },
    });
    const profile = res.data?.data?.profile;
    const uid = profile?.userId;
    if (!uid) return null;
    return {
      id: this.makeAccountId(String(uid)),
      uid: String(uid),
      cookie,
      nickname: profile?.nickname,
      avatarUrl: profile?.avatarUrl,
    };
  }

  private async validateAccount(accountId?: string): Promise<boolean> {
    const cookie = this.getCookieForAccount(accountId);
    if (!cookie) return false;
    try {
      const account = await this.resolveAccountFromCookie(cookie);
      return account !== null;
    } catch {
      return false;
    }
  }

  private async ensurePrimaryAccountLoaded(): Promise<string | null> {
    const resolved = this.getResolvedAccountId();
    if (resolved) return resolved;
    if (!this.fallbackCookie) return null;
    const account = await this.upsertAccountFromCookie(this.fallbackCookie, true);
    return account?.id ?? null;
  }

  async upsertAccountFromCookie(cookie: string, makePrimary = true): Promise<NeteaseAccountRecord | null> {
    this.fallbackCookie = cookie;
    try {
      const account = await this.resolveAccountFromCookie(cookie);
      if (!account) return null;
      this.accounts.set(account.id, account);
      if (makePrimary || !this.primaryAccountId) {
        this.primaryAccountId = account.id;
      }
      this.fallbackCookie = "";
      return account;
    } catch {
      return null;
    }
  }

  loadAccounts(accounts: NeteaseAccountRecord[], primaryId?: string | null): void {
    this.accounts.clear();
    for (const account of accounts) {
      if (account.id && account.uid && account.cookie) {
        this.accounts.set(account.id, account);
      }
    }
    if (primaryId && this.accounts.has(primaryId)) {
      this.primaryAccountId = primaryId;
    } else {
      this.primaryAccountId = this.accounts.keys().next().value ?? null;
    }
    this.fallbackCookie = "";
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
    if (this.accounts.size === 0) {
      this.fallbackCookie = "";
    }
    return true;
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const [songRes, playlistRes] = await Promise.all([
      this.api.get("/cloudsearch", {
        params: { keywords: query, type: 1, limit, ...this.getCookieParams() },
      }),
      this.api.get("/cloudsearch", {
        params: {
          keywords: query,
          type: 1000,
          limit: 5,
          ...this.getCookieParams(),
        },
      }),
    ]);

    const songs: Song[] = (songRes.data?.result?.songs ?? []).map((s: any) =>
      this.mapSong(s)
    );

    const playlists: Playlist[] = (
      playlistRes.data?.result?.playlists ?? []
    ).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));

    return { songs, playlists, albums: [] };
  }

  async getSongUrl(songId: string, quality?: string, song?: Song): Promise<string | null> {
    const level = quality ?? this.quality;
    const res = await this.api.get("/song/url/v1", {
      params: { id: songId, level, ...this.getCookieParams(song?.accountId) },
    });
    return res.data?.data?.[0]?.url ?? null;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const res = await this.api.get("/song/detail", {
      params: { ids: songId, ...this.getCookieParams() },
    });
    const s = res.data?.songs?.[0];
    return s ? this.mapSong(s) : null;
  }

  async getPlaylistDetail(playlistId: string): Promise<PlaylistDetail | null> {
    return this.getPlaylistDetailForAccount(playlistId);
  }

  async getPlaylistDetailForAccount(playlistId: string, accountId?: string): Promise<PlaylistDetail | null> {
    const res = await this.api.get("/playlist/detail", {
      params: { id: playlistId, ...this.getCookieParams(accountId) },
    });
    const p = res.data?.playlist;
    if (!p) return null;

    return {
      id: String(p.id),
      name: p.name ?? "",
      description: p.description ?? "",
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
      ...(accountId ? { account: this.buildAccount(accountId) } : {}),
    };
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    return this.getPlaylistSongsForAccount(playlistId);
  }

  async getPlaylistSongsForAccount(playlistId: string, accountId?: string): Promise<Song[]> {
    const res = await this.api.get("/playlist/track/all", {
      params: { id: playlistId, ...this.getCookieParams(accountId) },
    });
    return (res.data?.songs ?? []).map((s: any) => this.mapSong(s, accountId));
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    const res = await this.api.get("/personalized", {
      params: { limit: 10, ...this.getCookieParams() },
    });
    return (res.data?.result ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.picUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
    }));
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const res = await this.api.get("/album", {
      params: { id: albumId, ...this.getCookieParams() },
    });
    return (res.data?.songs ?? []).map((s: any) => this.mapSong(s));
  }

  async getLyrics(songId: string): Promise<LyricLine[]> {
    const res = await this.api.get("/lyric", {
      params: { id: songId, ...this.getCookieParams() },
    });
    return parseLyrics(
      res.data?.lrc?.lyric ?? "",
      res.data?.tlyric?.lyric
    );
  }

  async getQrCode(): Promise<QrCodeResult> {
    const keyRes = await this.api.get("/login/qr/key", {
      params: { timestamp: Date.now() },
    });
    const key = keyRes.data?.data?.unikey ?? "";
    const createRes = await this.api.get("/login/qr/create", {
      params: { key, qrimg: true },
    });
    return {
      qrUrl: createRes.data?.data?.qrurl ?? "",
      qrImg: createRes.data?.data?.qrimg ?? "",
      key,
    };
  }

  async checkQrCodeStatus(
    key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    const res = await this.api.get("/login/qr/check", {
      params: { key, timestamp: Date.now() },
    });
    const code = res.data?.code;
    switch (code) {
      case 801:
        return "waiting";
      case 802:
        return "scanned";
      case 803:
        if (res.data?.cookie) {
          this.fallbackCookie = res.data.cookie;
        }
        return "confirmed";
      default:
        return "expired";
    }
  }

  async sendSmsCode(phone: string): Promise<boolean> {
    const res = await this.api.get("/captcha/sent", {
      params: { phone },
    });
    return res.data?.code === 200;
  }

  async loginWithSms(phone: string, code: string): Promise<boolean> {
    const res = await this.api.get("/captcha/verify", {
      params: { phone, captcha: code },
    });
    if (res.data?.cookie) {
      this.fallbackCookie = res.data.cookie;
    }
    return res.data?.code === 200;
  }

  setCookie(cookie: string): void {
    this.fallbackCookie = cookie;
  }

  getCookie(): string {
    return this.getCookieForAccount();
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const resolvedAccountId = await this.ensurePrimaryAccountLoaded();
    const cookie = this.getCookieForAccount(resolvedAccountId ?? undefined);
    if (!cookie) return { loggedIn: false };
    try {
      const account = await this.resolveAccountFromCookie(cookie);
      if (account) {
        this.accounts.set(account.id, account);
        if (!this.primaryAccountId || resolvedAccountId === null) {
          this.primaryAccountId = account.id;
        }
        return {
          loggedIn: true,
          nickname: account.nickname,
          avatarUrl: account.avatarUrl,
        };
      }
    } catch {
      // ignore
    }
    return { loggedIn: false };
  }

  async getPersonalFm(): Promise<Song[]> {
    const accountId = await this.ensurePrimaryAccountLoaded();
    const res = await this.api.get("/personal_fm", {
      params: { ...this.getCookieParams(accountId ?? undefined) },
    });
    return (res.data?.data ?? []).map((s: any) => this.mapSong(s, accountId ?? undefined));
  }

  async getDailyRecommendSongs(): Promise<Song[]> {
    const accountId = await this.ensurePrimaryAccountLoaded();
    const res = await this.api.get("/recommend/songs", {
      params: { ...this.getCookieParams(accountId ?? undefined) },
    });
    return (res.data?.data?.dailySongs ?? []).map((s: any) => this.mapSong(s, accountId ?? undefined));
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    await this.ensurePrimaryAccountLoaded();
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
    const resolved = await this.resolveAccountFromCookie(cookie);
    if (!resolved) return [];
    this.accounts.set(resolved.id, resolved);
    if (!this.primaryAccountId) {
      this.primaryAccountId = resolved.id;
    }

    const res = await this.api.get("/user/playlist", {
      params: { uid: resolved.uid, ...this.getCookieParams(accountId) },
    });
    const account = this.buildAccount(resolved.id);
    return (res.data?.playlist ?? []).map((p: any) => ({
      id: String(p.id),
      name: p.name,
      coverUrl: p.coverImgUrl ?? "",
      songCount: p.trackCount ?? 0,
      platform: "netease",
      account,
    }));
  }
}
