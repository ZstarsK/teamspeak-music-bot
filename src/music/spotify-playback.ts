import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AudioPlayer } from "../audio/player.js";
import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { Song } from "./provider.js";
import { SpotifyProvider } from "./spotify.js";

const DEVICE_WAIT_TIMEOUT_MS = 12_000;
const DEVICE_WAIT_INTERVAL_MS = 750;
const EVENT_POLL_INTERVAL_MS = 350;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeName(input: string): string {
  return input.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
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
  private readonly cacheDir: string;
  private readonly deviceName: string;
  private readonly logger: Logger;

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
    this.cacheDir = path.join(this.runtimeDir, "cache");
    this.deviceName = `${this.config.spotifyDeviceName || "TSMusicBot Spotify"} ${safeBotId.slice(0, 8)}`;
    this.logger = logger.child({ component: "spotify-playback" });
  }

  async play(song: Song, player: AudioPlayer, onEnd: () => void | Promise<void>): Promise<void> {
    const account = await this.provider.getPlaybackAccount(song.accountId);
    const trackUri = this.provider.getTrackUri(song.id);
    await this.ensureProcess(account.id, account.accessToken, onEnd);
    const pcmStream = this.librespot?.stdout;
    if (!pcmStream) {
      throw new Error("librespot PCM stdout is not available");
    }
    player.playPcmStream(pcmStream, {
      inputSampleRate: 44100,
      cleanup: () => {
        this.pause().catch((err) => {
          this.logger.warn({ err }, "Failed to pause Spotify playback during cleanup");
        });
      },
    });
    const deviceId = await this.waitForDevice(account.id);
    this.activeAccountId = account.id;
    this.activeDeviceId = deviceId;
    this.activeTrackUri = trackUri;
    await this.provider.startPlayback({
      accountId: account.id,
      deviceId,
      trackUri,
    });
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
  }

  private ensureRuntimeFiles(): void {
    fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
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
    accountId: string,
    accessToken: string,
    onEnd: () => void | Promise<void>,
  ): Promise<void> {
    if (this.librespot && !this.librespot.killed && this.activeAccountId === accountId) {
      this.startEventWatcher(onEnd);
      return;
    }
    this.shutdown();
    this.ensureRuntimeFiles();

    const args = [
      "--name", this.deviceName,
      "--backend", "pipe",
      "--format", "S16",
      "--cache", this.cacheDir,
      "--bitrate", "320",
      "--access-token", accessToken,
      "--onevent", this.eventScriptPath,
      "--mixer", "softvol",
      "--volume-ctrl", "fixed",
      "--initial-volume", "100",
      "--quiet",
    ];

    const bin = this.config.spotifyLibrespotPath || "librespot";
    this.logger.info({ bin, deviceName: this.deviceName }, "Starting librespot sidecar");
    this.librespot = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SPOTIFY_EVENT_FILE: this.eventFilePath,
      },
    });
    this.activeAccountId = accountId;
    this.activeDeviceId = null;

    this.librespot.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (message) this.logger.debug({ librespot: message }, "librespot stderr");
    });

    this.librespot.on("error", (err) => {
      this.logger.error({ err, bin }, "librespot failed to start");
    });

    this.librespot.on("close", (code, signal) => {
      this.logger.warn({ code, signal }, "librespot sidecar closed");
      this.librespot = null;
      this.activeDeviceId = null;
    });

    this.startEventWatcher(onEnd);
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
