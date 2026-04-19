import axios, { type AxiosInstance } from "axios";
import type { BotConfig } from "../data/config.js";
import type {
  AuthStatus,
  LyricLine,
  MusicAccount,
  MusicProvider,
  Album,
  Playlist,
  PlaylistDetail,
  QrCodeResult,
  SearchResult,
  Song,
} from "./provider.js";
import type { StoredSpotifyAccount } from "./auth.js";
import type { Logger } from "../logger.js";

const SPOTIFY_AUTH_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SCOPE = [
  "streaming",
  "user-read-private",
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-modify-playback-state",
  "user-read-playback-state",
].join(" ");

export interface SpotifyAccountRecord extends StoredSpotifyAccount {}

type SpotifyAccountChangeHandler = (
  account: SpotifyAccountRecord,
  makePrimary?: boolean,
) => void;

function spotifyImage(images: Array<{ url?: string }> | undefined): string {
  return images?.find((image) => typeof image?.url === "string" && image.url)?.url ?? "";
}

function spotifyId(input: string, expectedType?: "track" | "album" | "playlist"): string {
  const trimmed = input.trim();
  const uriMatch = trimmed.match(/^spotify:([^:]+):([^:?/]+)$/);
  if (uriMatch && (!expectedType || uriMatch[1] === expectedType)) return uriMatch[2];

  const urlMatch = trimmed.match(/open\.spotify\.com\/([^/?#]+)\/([^/?#]+)/);
  if (urlMatch && (!expectedType || urlMatch[1] === expectedType)) return urlMatch[2];

  return trimmed.replace(/[?#].*$/, "");
}

function spotifyUri(type: "track" | "album" | "playlist", idOrUri: string): string {
  const id = spotifyId(idOrUri, type);
  return `spotify:${type}:${id}`;
}

function present<T>(value: T | null | undefined): value is T {
  return value != null;
}

export class SpotifyProvider implements MusicProvider {
  readonly platform = "spotify" as const;
  private api: AxiosInstance;
  private accounts = new Map<string, SpotifyAccountRecord>();
  private primaryAccountId: string | null = null;
  private accountChangeHandler: SpotifyAccountChangeHandler | null = null;
  private logger: Logger;

  constructor(private config: BotConfig, logger: Logger) {
    this.logger = logger.child({ component: "spotify-provider" });
    this.api = axios.create({
      baseURL: "https://api.spotify.com/v1",
      timeout: 12000,
    });
  }

  setAccountChangeHandler(handler: SpotifyAccountChangeHandler): void {
    this.accountChangeHandler = handler;
  }

  loadAccounts(accounts: SpotifyAccountRecord[], primaryId?: string | null): void {
    this.accounts.clear();
    for (const account of accounts) {
      if (account.id && account.userId && account.accessToken && account.refreshToken) {
        this.accounts.set(account.id, account);
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

  hasAccount(): boolean {
    return this.getResolvedAccountId() !== null;
  }

  getAccounts(): Array<MusicAccount & { primary: boolean }> {
    const primaryId = this.getResolvedAccountId();
    return Array.from(this.accounts.values())
      .sort((a, b) => (a.id === primaryId ? -1 : b.id === primaryId ? 1 : a.displayName.localeCompare(b.displayName)))
      .map((account) => ({
        id: account.id,
        name: `Spotify: ${account.displayName || account.userId}`,
        platform: "spotify",
        ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
        primary: account.id === primaryId,
      }));
  }

  async getAccountsWithStatus(): Promise<Array<MusicAccount & { primary: boolean; valid: boolean }>> {
    const accounts = this.getAccounts();
    const statuses = await Promise.all(
      accounts.map(async (account) => ({
        id: account.id,
        valid: await this.validateAccount(account.id),
      }))
    );
    const statusMap = new Map(statuses.map((status) => [status.id, status.valid]));
    return accounts.map((account) => ({
      ...account,
      valid: statusMap.get(account.id) ?? false,
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

  createAuthorizationUrl(redirectUri: string, state: string): string {
    if (!this.config.spotifyClientId) {
      throw new Error("spotifyClientId is not configured");
    }
    const params = new URLSearchParams({
      client_id: this.config.spotifyClientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SPOTIFY_SCOPE,
      state,
      show_dialog: "true",
    });
    return `${SPOTIFY_AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string, makePrimary = true): Promise<SpotifyAccountRecord> {
    const token = await this.requestToken(new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }));
    const account = await this.accountFromToken(token);
    this.accounts.set(account.id, account);
    if (makePrimary || !this.primaryAccountId) {
      this.primaryAccountId = account.id;
    }
    this.accountChangeHandler?.(account, makePrimary);
    return account;
  }

  private async accountFromToken(token: any): Promise<SpotifyAccountRecord> {
    const profileRes = await this.api.get("/me", {
      headers: { Authorization: `${token.token_type ?? "Bearer"} ${token.access_token}` },
    });
    const profile = profileRes.data ?? {};
    const userId = String(profile.id ?? "");
    if (!userId) throw new Error("Spotify profile did not include an id");
    return {
      id: `spotify:${userId}`,
      userId,
      displayName: profile.display_name || userId,
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      tokenType: token.token_type ?? "Bearer",
      scope: token.scope ?? SPOTIFY_SCOPE,
      expiresAt: Date.now() + Math.max(1, Number(token.expires_in ?? 3600)) * 1000,
      avatarUrl: spotifyImage(profile.images),
      updatedAt: new Date().toISOString(),
    };
  }

  private async requestToken(params: URLSearchParams): Promise<any> {
    if (!this.config.spotifyClientId || !this.config.spotifyClientSecret) {
      throw new Error("Spotify OAuth client is not configured");
    }
    const auth = Buffer.from(`${this.config.spotifyClientId}:${this.config.spotifyClientSecret}`).toString("base64");
    const res = await axios.post(SPOTIFY_TOKEN_URL, params.toString(), {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 12000,
    });
    return res.data;
  }

  private getResolvedAccountId(accountId?: string): string | null {
    if (accountId && this.accounts.has(accountId)) return accountId;
    if (this.primaryAccountId && this.accounts.has(this.primaryAccountId)) {
      return this.primaryAccountId;
    }
    return this.accounts.keys().next().value ?? null;
  }

  private getAccount(accountId?: string): SpotifyAccountRecord | null {
    const resolved = this.getResolvedAccountId(accountId);
    return resolved ? this.accounts.get(resolved) ?? null : null;
  }

  async getAccessToken(accountId?: string): Promise<string> {
    const account = this.getAccount(accountId);
    if (!account) throw new Error("Spotify account is not logged in");
    const fresh = await this.ensureFreshAccount(account.id);
    return fresh.accessToken;
  }

  async getPlaybackAccount(accountId?: string): Promise<SpotifyAccountRecord> {
    const account = this.getAccount(accountId);
    if (!account) throw new Error("Spotify account is not logged in");
    return this.ensureFreshAccount(account.id);
  }

  private async ensureFreshAccount(accountId: string): Promise<SpotifyAccountRecord> {
    const account = this.accounts.get(accountId);
    if (!account) throw new Error("Spotify account is not logged in");
    if (account.expiresAt > Date.now() + 60_000) return account;
    const token = await this.requestToken(new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
    }));
    const next: SpotifyAccountRecord = {
      ...account,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? account.refreshToken,
      tokenType: token.token_type ?? account.tokenType,
      scope: token.scope ?? account.scope,
      expiresAt: Date.now() + Math.max(1, Number(token.expires_in ?? 3600)) * 1000,
      updatedAt: new Date().toISOString(),
    };
    this.accounts.set(next.id, next);
    this.accountChangeHandler?.(next, false);
    return next;
  }

  private async request<T>(path: string, accountId?: string, config: Record<string, any> = {}): Promise<T> {
    const account = await this.getPlaybackAccount(accountId);
    try {
      const res = await this.api.request({
        url: path,
        ...config,
        headers: {
          ...(config.headers ?? {}),
          Authorization: `${account.tokenType} ${account.accessToken}`,
        },
      });
      return res.data as T;
    } catch (err: any) {
      if (err?.response?.status !== 401) throw err;
      const fresh = await this.ensureFreshAccount(account.id);
      const res = await this.api.request({
        url: path,
        ...config,
        headers: {
          ...(config.headers ?? {}),
          Authorization: `${fresh.tokenType} ${fresh.accessToken}`,
        },
      });
      return res.data as T;
    }
  }

  private async validateAccount(accountId?: string): Promise<boolean> {
    try {
      await this.request("/me", accountId);
      return true;
    } catch (err) {
      this.logger.warn({ err, accountId }, "Spotify account validation failed");
      return false;
    }
  }

  private accountForPlaylist(accountId?: string): MusicAccount | undefined {
    const account = this.getAccount(accountId);
    if (!account) return undefined;
    return {
      id: account.id,
      name: `Spotify: ${account.displayName || account.userId}`,
      platform: "spotify",
      ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
    };
  }

  private mapSong(track: any, accountId?: string): Song | null {
    if (!track || track.type !== "track" || !track.id) return null;
    return {
      id: String(track.id),
      name: track.name ?? "",
      artist: Array.isArray(track.artists)
        ? track.artists.map((artist: any) => artist?.name).filter(Boolean).join(" / ")
        : "",
      album: track.album?.name ?? "",
      duration: Math.round(Number(track.duration_ms ?? 0) / 1000),
      coverUrl: spotifyImage(track.album?.images),
      platform: "spotify",
      ...(accountId ? { accountId } : {}),
    };
  }

  private mapPlaylist(playlist: any, accountId?: string): Playlist | null {
    if (!playlist || !playlist.id) return null;
    return {
      id: String(playlist.id),
      name: playlist.name ?? "",
      coverUrl: spotifyImage(playlist.images),
      songCount: Number(playlist.tracks?.total ?? 0),
      platform: "spotify",
      ...(accountId ? { account: this.accountForPlaylist(accountId) } : {}),
    };
  }

  private mapAlbum(album: any): Album | null {
    if (!album || !album.id) return null;
    return {
      id: String(album.id),
      name: album.name ?? "",
      artist: Array.isArray(album.artists)
        ? album.artists.map((artist: any) => artist?.name).filter(Boolean).join(" / ")
        : "",
      coverUrl: spotifyImage(album.images),
      songCount: Number(album.total_tracks ?? 0),
      platform: "spotify",
    };
  }

  async search(query: string, limit = 20): Promise<SearchResult> {
    const parsedLimit = Math.max(1, Math.min(10, Math.round(limit)));
    const data = await this.request<any>("/search", undefined, {
      method: "GET",
      params: {
        q: query,
        type: "track,playlist,album",
        limit: parsedLimit,
      },
    });
    return {
      songs: (data.tracks?.items ?? [])
        .map((track: any) => this.mapSong(track, this.getPrimaryAccountId() ?? undefined))
        .filter(present),
      playlists: (data.playlists?.items ?? [])
        .map((playlist: any) => this.mapPlaylist(playlist, this.getPrimaryAccountId() ?? undefined))
        .filter(present),
      albums: (data.albums?.items ?? [])
        .map((album: any) => this.mapAlbum(album))
        .filter(present),
    };
  }

  async getSongUrl(_songId: string): Promise<string | null> {
    return null;
  }

  getTrackUri(songId: string): string {
    return spotifyUri("track", songId);
  }

  setQuality(_quality: string): void {
    // Spotify quality is selected by librespot bitrate; keep provider API compatibility.
  }

  getQuality(): string {
    return "320";
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    const id = spotifyId(songId, "track");
    const track = await this.request<any>(`/tracks/${encodeURIComponent(id)}`);
    return this.mapSong(track, this.getPrimaryAccountId() ?? undefined);
  }

  async getPlaylistDetail(playlistId: string, accountId?: string): Promise<PlaylistDetail | null> {
    const id = spotifyId(playlistId, "playlist");
    const resolvedAccountId = accountId ?? this.getPrimaryAccountId() ?? undefined;
    const playlist = await this.request<any>(`/playlists/${encodeURIComponent(id)}`, resolvedAccountId, {
      method: "GET",
      params: { fields: "id,name,description,images,tracks(total)" },
    });
    const mapped = this.mapPlaylist(playlist, resolvedAccountId);
    return mapped
      ? { ...mapped, description: playlist.description ?? "" }
      : null;
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    return this.getPlaylistSongsForAccount(playlistId, this.getPrimaryAccountId() ?? undefined);
  }

  async getPlaylistSongsForAccount(playlistId: string, accountId?: string): Promise<Song[]> {
    const id = spotifyId(playlistId, "playlist");
    const items = await this.loopPaged<any>(`/playlists/${encodeURIComponent(id)}/tracks`, accountId, {
      fields: "items(track(id,type,name,artists(name),album(name,images),duration_ms)),next",
      limit: 50,
    });
    return items
      .map((item: any) => this.mapSong(item.track, accountId ?? this.getPrimaryAccountId() ?? undefined))
      .filter(present);
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getAlbumSongs(albumId: string): Promise<Song[]> {
    const id = spotifyId(albumId, "album");
    const album = await this.request<any>(`/albums/${encodeURIComponent(id)}`);
    const coverUrl = spotifyImage(album.images);
    return (album.tracks?.items ?? [])
      .map((track: any) => ({
        ...track,
        album: { name: album.name, images: [{ url: coverUrl }] },
      }))
      .map((track: any) => this.mapSong(track, this.getPrimaryAccountId() ?? undefined))
      .filter(present);
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getQrCode(): Promise<QrCodeResult> {
    throw new Error("Spotify uses OAuth login");
  }

  async checkQrCodeStatus(): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(_cookie: string): void {
    // Spotify uses OAuth tokens, not cookies.
  }

  getCookie(): string {
    return "";
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const account = this.getAccount();
    if (!account) return { loggedIn: false };
    const valid = await this.validateAccount(account.id);
    return {
      loggedIn: valid,
      nickname: account.displayName,
      avatarUrl: account.avatarUrl,
    };
  }

  async getUserPlaylists(): Promise<Playlist[]> {
    const accounts = this.getAccounts();
    const results = await Promise.allSettled(
      accounts.map((account) => this.getUserPlaylistsForAccount(account.id))
    );
    return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  }

  async getUserPlaylistsForAccount(accountId: string): Promise<Playlist[]> {
    const items = await this.loopPaged<any>("/me/playlists", accountId, { limit: 50 });
    return items
      .map((playlist: any) => this.mapPlaylist(playlist, accountId))
      .filter(present);
  }

  async startPlayback(params: {
    accountId?: string;
    deviceId: string;
    trackUri: string;
    positionMs?: number;
  }): Promise<void> {
    await this.request<void>("/me/player/play", params.accountId, {
      method: "PUT",
      params: { device_id: params.deviceId },
      data: {
        uris: [params.trackUri],
        position_ms: Math.max(0, Math.round(params.positionMs ?? 0)),
      },
    });
  }

  async pausePlayback(accountId?: string, deviceId?: string | null): Promise<void> {
    await this.request<void>("/me/player/pause", accountId, {
      method: "PUT",
      ...(deviceId ? { params: { device_id: deviceId } } : {}),
    });
  }

  async resumePlayback(accountId?: string, deviceId?: string | null): Promise<void> {
    await this.request<void>("/me/player/play", accountId, {
      method: "PUT",
      ...(deviceId ? { params: { device_id: deviceId } } : {}),
    });
  }

  async seekPlayback(positionMs: number, accountId?: string, deviceId?: string | null): Promise<void> {
    await this.request<void>("/me/player/seek", accountId, {
      method: "PUT",
      params: {
        position_ms: Math.max(0, Math.round(positionMs)),
        ...(deviceId ? { device_id: deviceId } : {}),
      },
    });
  }

  async getCurrentPlayback(accountId?: string): Promise<{
    deviceId: string;
    trackId: string;
    progressMs: number;
    isPlaying: boolean;
  } | null> {
    const data = await this.request<any>("/me/player", accountId, {
      method: "GET",
      validateStatus: (status: number) => status === 200 || status === 204,
    });
    if (!data || !data.item) return null;
    return {
      deviceId: String(data.device?.id ?? ""),
      trackId: String(data.item?.id ?? ""),
      progressMs: Number(data.progress_ms ?? 0) || 0,
      isPlaying: Boolean(data.is_playing),
    };
  }

  async findDeviceIdByName(deviceName: string, accountId?: string): Promise<string | null> {
    const data = await this.request<any>("/me/player/devices", accountId);
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const exact = devices.find((device: any) => device?.name === deviceName);
    return exact?.id ?? null;
  }

  private async loopPaged<T>(
    path: string,
    accountId: string | undefined,
    params: Record<string, any>,
  ): Promise<T[]> {
    const items: T[] = [];
    let nextPath: string | null = path;
    let nextParams: Record<string, any> | undefined = params;
    while (nextPath) {
      const data: any = await this.request<any>(nextPath, accountId, {
        method: "GET",
        params: nextParams,
      });
      items.push(...(data.items ?? []));
      nextPath = data.next ? data.next.replace("https://api.spotify.com/v1", "") : null;
      nextParams = undefined;
    }
    return items;
  }
}
