import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  MusicProvider,
  Song,
  SongWithUrl,
  Playlist,
  Album,
  SearchResult,
  LyricLine,
  QrCodeResult,
  AuthStatus,
} from "./provider.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Resolve the yt-dlp binary path. Checks the project bin/ dir first, then PATH. */
function findYtDlp(): string {
  const candidates = [
    join(__dirname, "..", "..", "bin", "yt-dlp.exe"),
    join(__dirname, "..", "..", "bin", "yt-dlp"),
    "yt-dlp",
    "yt-dlp.exe",
  ];
  for (const c of candidates) {
    if (!c.includes(join("bin", "yt-dlp")) || existsSync(c)) return c;
    // For PATH entries (no directory prefix), fall through to let execFile try
  }
  return "yt-dlp";
}

async function runYtDlp(args: string[], timeoutMs = 30_000): Promise<string> {
  const binary = findYtDlp();
  const env = { ...process.env };
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    // yt-dlp respects these env vars natively
  }
  const { stdout } = await execFileAsync(binary, args, {
    timeout: timeoutMs,
    env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

interface YtDlpEntry {
  id: string;
  title: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  webpage_url?: string;
  url?: string;
  entries?: YtDlpEntry[];
  _type?: string;
}

function entryToSong(entry: YtDlpEntry): Song {
  return {
    id: entry.id ?? "",
    name: entry.title ?? "Unknown",
    artist: entry.uploader ?? entry.channel ?? "YouTube",
    album: "YouTube",
    duration: Math.round(entry.duration ?? 0),
    coverUrl: entry.thumbnail ?? "",
    platform: "youtube",
  };
}

export class YouTubeProvider implements MusicProvider {
  readonly platform = "youtube" as const;
  private quality = "bestaudio";

  async search(query: string, limit = 5): Promise<SearchResult> {
    try {
      const raw = await runYtDlp([
        `ytsearch${limit}:${query}`,
        "--dump-json",
        "--flat-playlist",
        "--no-warnings",
        "--quiet",
      ]);
      const lines = raw.trim().split("\n").filter(Boolean);
      const songs: Song[] = lines.map((line) => {
        const entry = JSON.parse(line) as YtDlpEntry;
        return entryToSong(entry);
      });
      return { songs, playlists: [], albums: [] };
    } catch {
      return { songs: [], playlists: [], albums: [] };
    }
  }

  async getSongUrl(songId: string): Promise<string | null> {
    try {
      const url = `https://www.youtube.com/watch?v=${songId}`;
      const raw = await runYtDlp([
        url,
        "--get-url",
        "-f",
        "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio",
        "--no-warnings",
        "--quiet",
      ], 45_000);
      const audioUrl = raw.trim().split("\n")[0];
      return audioUrl || null;
    } catch {
      return null;
    }
  }

  setQuality(quality: string): void {
    this.quality = quality;
  }

  getQuality(): string {
    return this.quality;
  }

  async getSongDetail(songId: string): Promise<Song | null> {
    try {
      const url = `https://www.youtube.com/watch?v=${songId}`;
      const raw = await runYtDlp([url, "--dump-json", "--no-warnings", "--quiet"]);
      const entry = JSON.parse(raw.trim()) as YtDlpEntry;
      return entryToSong(entry);
    } catch {
      return null;
    }
  }

  async getPlaylistSongs(playlistId: string): Promise<Song[]> {
    try {
      const url = playlistId.startsWith("http")
        ? playlistId
        : `https://www.youtube.com/playlist?list=${playlistId}`;
      const raw = await runYtDlp([
        url,
        "--dump-json",
        "--flat-playlist",
        "--no-warnings",
        "--quiet",
      ], 60_000);
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines.map((line) => entryToSong(JSON.parse(line) as YtDlpEntry));
    } catch {
      return [];
    }
  }

  async getRecommendPlaylists(): Promise<Playlist[]> {
    return [];
  }

  async getAlbumSongs(_albumId: string): Promise<Song[]> {
    return [];
  }

  async getLyrics(_songId: string): Promise<LyricLine[]> {
    return [];
  }

  async getQrCode(): Promise<QrCodeResult> {
    return { qrUrl: "", key: "" };
  }

  async checkQrCodeStatus(
    _key: string
  ): Promise<"waiting" | "scanned" | "confirmed" | "expired"> {
    return "expired";
  }

  setCookie(_cookie: string): void {}
  getCookie(): string { return ""; }

  async getAuthStatus(): Promise<AuthStatus> {
    return { loggedIn: true, nickname: "YouTube (yt-dlp)" };
  }
}
