import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AudioPlayer, PlayerState } from "../audio/player.js";
import {
  getConfiguredSpotifyLibrespotAuthMode,
  type BotConfig,
  type SpotifyLibrespotAuthMode,
} from "../data/config.js";
import type { Logger } from "../logger.js";
import type { Song } from "./provider.js";
import { SpotifyProvider, type SpotifyAccountRecord } from "./spotify.js";

const DEVICE_WAIT_TIMEOUT_MS = 12_000;
const DEVICE_WAIT_INTERVAL_MS = 250;
const EVENT_POLL_INTERVAL_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

export interface SpotifyLibrespotCachePaths {
  accountKey: string;
  baseDir: string;
  audioDir: string;
  systemDir: string;
}

export function getSpotifyLibrespotCachePaths(
  cacheBaseDir: string,
  account: Pick<SpotifyAccountRecord, "userId">,
): SpotifyLibrespotCachePaths {
  const accountKey = sanitizeName(account.userId);
  const baseDir = path.join(cacheBaseDir, "accounts", accountKey);
  return {
    accountKey,
    baseDir,
    audioDir: path.join(baseDir, "audio-cache"),
    systemDir: path.join(baseDir, "system-cache"),
  };
}

export function buildLibrespotArgs(params: {
  mode: SpotifyLibrespotAuthMode;
  deviceName: string;
  eventScriptPath: string;
  audioCacheDir: string;
  systemCacheDir: string;
  accessToken?: string;
}): string[] {
  const args = [
    "--name", params.deviceName,
    "--backend", "pipe",
    "--format", "S16",
    "--cache", params.audioCacheDir,
    "--system-cache", params.systemCacheDir,
    "--bitrate", "320",
    "--onevent", params.eventScriptPath,
    "--mixer", "softvol",
    "--volume-ctrl", "fixed",
    "--initial-volume", "100",
    "--disable-discovery",
  ];

  if (params.mode === "credentials-cache") {
    return args;
  }
  if (!params.accessToken) {
    throw new Error("Spotify access token is required for librespot access-token mode");
  }
  return [...args, "--access-token", params.accessToken];
}

export function shouldReuseSpotifyPcmStream(params: {
  sameProcess: boolean;
  playerState: PlayerState;
}): boolean {
  return params.sameProcess && params.playerState === "playing";
}

function directoryHasFiles(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export class SpotifyPlaybackEngine {
  private librespot: ChildProcess | null = null;
  private watcher: ReturnType<typeof setInterval> | null = null;
  private eventOffset = 0;
  private activeAccountId: string | null = null;
  private activeDeviceId: string | null = null;
  private activeTrackUri: string | null = null;
  private lastEndAt = 0;
  private readonly runtimeDir: string;
  private readonly eventFilePath: string;
  private readonly eventScriptPath: string;
  private readonly runtimeAudioCacheDir: string;
  private readonly runtimeSystemCacheDir: string;
  private readonly deviceName: string;
  private readonly logger: Logger;
  private lastExitDetail: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private playbackStarted = false;

  constructor(
    private provider: SpotifyProvider,
    private config: BotConfig,
    logger: Logger,
    botId: string,
    cacheBaseDir: string,
  ) {
    const safeBotId = sanitizeName(botId);
    this.runtimeDir = path.join(cacheBaseDir, safeBotId);
    this.eventFilePath = path.join(this.runtimeDir, "events.jsonl");
    this.eventScriptPath = path.join(this.runtimeDir, "spotify-event.cjs");
    this.runtimeAudioCacheDir = path.join(this.runtimeDir, "audio-cache");
    this.runtimeSystemCacheDir = path.join(this.runtimeDir, "system-cache");
    this.deviceName = `${this.config.spotifyDeviceName || "TSMusicBot Spotify"} ${safeBotId.slice(0, 8)}`;
    this.logger = logger.child({ component: "spotify-playback" });
  }

  async play(song: Song, player: AudioPlayer, onEnd: () => void | Promise<void>): Promise<void> {
    const account = await this.provider.getPlaybackAccount(song.accountId);
    const trackUri = this.provider.getTrackUri(song.id);
    const sameProcess = await this.ensureProcess(account, onEnd);
    const deviceId = await this.waitForDevice(account.id);
    this.activeAccountId = account.id;
    this.activeDeviceId = deviceId;
    this.activeTrackUri = trackUri;
    const reusePcmStream = shouldReuseSpotifyPcmStream({
      sameProcess,
      playerState: player.getState(),
    });
    if (!reusePcmStream) {
      const pcmStream = this.librespot?.stdout;
      if (!pcmStream) {
        throw new Error("librespot PCM stdout is not available");
      }
      player.playPcmStream(pcmStream, {
        inputSampleRate: 44100,
        cleanup: () => {
          if (!this.playbackStarted) return;
          this.pause().catch((err) => {
            this.logger.warn({ err }, "Failed to pause Spotify playback during cleanup");
          });
        },
      });
    } else {
      this.logger.info({ deviceId, trackUri }, "Reusing existing Spotify PCM stream");
    }
    try {
      await this.provider.startPlayback({
        accountId: account.id,
        deviceId,
        trackUri,
      });
      this.playbackStarted = true;
    } catch (err) {
      this.playbackStarted = false;
      player.stop();
      throw err;
    }
    this.logger.info({ trackUri, deviceId }, "Spotify playback started");
  }

  async pause(): Promise<void> {
    if (!this.activeAccountId) return;
    await this.provider.pausePlayback(this.activeAccountId, this.activeDeviceId);
  }

  async resume(): Promise<void> {
    if (!this.activeAccountId) return;
    await this.provider.resumePlayback(this.activeAccountId, this.activeDeviceId);
  }

  async seek(seconds: number): Promise<void> {
    if (!this.activeAccountId) return;
    await this.provider.seekPlayback(Math.max(0, seconds * 1000), this.activeAccountId, this.activeDeviceId);
  }

  shutdown(): void {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
    if (this.librespot) {
      this.librespot.kill("SIGTERM");
      this.librespot = null;
    }
    this.activeAccountId = null;
    this.activeDeviceId = null;
    this.activeTrackUri = null;
    this.playbackStarted = false;
  }

  private ensureRuntimeFiles(): void {
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.runtimeAudioCacheDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.runtimeSystemCacheDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      this.eventScriptPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const file = process.env.SPOTIFY_EVENT_FILE;",
        "if (!file) process.exit(0);",
        "const keys = ['PLAYER_EVENT','TRACK_ID','URI','NAME','DURATION_MS','POSITION_MS','ARTISTS'];",
        "const event = {};",
        "for (const key of keys) if (process.env[key]) event[key] = process.env[key];",
        "event.time = Date.now();",
        "fs.appendFileSync(file, JSON.stringify(event) + '\\n');",
        "",
      ].join("\n"),
      { encoding: "utf-8", mode: 0o700 },
    );
    if (fs.existsSync(this.eventFilePath)) {
      fs.truncateSync(this.eventFilePath, 0);
    } else {
      fs.writeFileSync(this.eventFilePath, "", { encoding: "utf-8", mode: 0o600 });
    }
    this.eventOffset = 0;
  }

  private async ensureProcess(
    account: SpotifyAccountRecord,
    onEnd: () => void | Promise<void>,
  ): Promise<boolean> {
    if (this.librespot && !this.librespot.killed && this.activeAccountId === account.id) {
      this.startEventWatcher(onEnd);
      return true;
    }
    this.shutdown();
    this.ensureRuntimeFiles();
    this.lastExitDetail = null;

    const mode = getConfiguredSpotifyLibrespotAuthMode(this.config);
    const cachePaths = mode === "credentials-cache"
      ? getSpotifyLibrespotCachePaths(path.dirname(this.runtimeDir), account)
      : {
          accountKey: sanitizeName(account.userId),
          baseDir: this.runtimeDir,
          audioDir: this.runtimeAudioCacheDir,
          systemDir: this.runtimeSystemCacheDir,
        };

    if (mode === "credentials-cache") {
      fs.mkdirSync(cachePaths.audioDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(cachePaths.systemDir, { recursive: true, mode: 0o700 });
      if (!directoryHasFiles(cachePaths.systemDir) && !directoryHasFiles(cachePaths.audioDir)) {
        throw new Error(
          `Spotify credentials cache not found for ${account.displayName || account.userId}. ` +
          `Expected cache under ${cachePaths.baseDir}. ` +
          "Run librespot OAuth login once to seed the local cache.",
        );
      }
    }

    const args = buildLibrespotArgs({
      mode,
      deviceName: this.deviceName,
      eventScriptPath: this.eventScriptPath,
      audioCacheDir: cachePaths.audioDir,
      systemCacheDir: cachePaths.systemDir,
      ...(mode === "access-token" ? { accessToken: account.accessToken } : {}),
    });

    const bin = this.config.spotifyLibrespotPath || "librespot";
    this.logger.info(
      {
        bin,
        deviceName: this.deviceName,
        authMode: mode,
        cacheDir: cachePaths.audioDir,
        systemCacheDir: cachePaths.systemDir,
      },
      "Starting librespot sidecar",
    );
    this.librespot = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SPOTIFY_EVENT_FILE: this.eventFilePath,
      },
    });
    this.activeAccountId = account.id;
    this.activeDeviceId = null;
    this.playbackStarted = false;

    this.librespot.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (message) this.logger.info({ librespot: message }, "librespot stderr");
    });

    this.librespot.on("error", (err) => {
      this.logger.error({ err, bin }, "librespot failed to start");
    });

    this.librespot.on("close", (code, signal) => {
      this.logger.warn({ code, signal }, "librespot sidecar closed");
      this.librespot = null;
      this.activeDeviceId = null;
      this.lastExitDetail = { code, signal };
    });

    this.startEventWatcher(onEnd);
    return false;
  }

  private startEventWatcher(onEnd: () => void | Promise<void>): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      this.readEvents(onEnd);
    }, EVENT_POLL_INTERVAL_MS);
  }

  private readEvents(onEnd: () => void | Promise<void>): void {
    try {
      if (!fs.existsSync(this.eventFilePath)) return;
      const stat = fs.statSync(this.eventFilePath);
      if (stat.size <= this.eventOffset) return;
      const fd = fs.openSync(this.eventFilePath, "r");
      try {
        const buffer = Buffer.alloc(stat.size - this.eventOffset);
        fs.readSync(fd, buffer, 0, buffer.length, this.eventOffset);
        this.eventOffset = stat.size;
        for (const line of buffer.toString("utf-8").split("\n")) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { PLAYER_EVENT?: string; TRACK_ID?: string };
          if (event.PLAYER_EVENT === "end_of_track") {
            this.handleTrackEnd(onEnd);
          } else if (event.PLAYER_EVENT === "unavailable") {
            this.logger.warn({ event }, "Spotify track unavailable");
            this.handleTrackEnd(onEnd);
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to read librespot events");
    }
  }

  private handleTrackEnd(onEnd: () => void | Promise<void>): void {
    const now = Date.now();
    if (now - this.lastEndAt < 1000) return;
    this.lastEndAt = now;
    Promise.resolve()
      .then(() => onEnd())
      .catch((err) => this.logger.error({ err }, "Spotify end-of-track handler failed"));
  }

  private async waitForDevice(accountId: string): Promise<string> {
    if (this.activeDeviceId) return this.activeDeviceId;
    const deadline = Date.now() + DEVICE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.librespot && this.lastExitDetail) {
        const { code, signal } = this.lastExitDetail;
        throw new Error(
          `librespot exited before Spotify device appeared (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
      }
      const deviceId = await this.provider.findDeviceIdByName(this.deviceName, accountId);
      if (deviceId) {
        this.activeDeviceId = deviceId;
        return deviceId;
      }
      await sleep(DEVICE_WAIT_INTERVAL_MS);
    }
    throw new Error(`Spotify device "${this.deviceName}" did not appear`);
  }
}
