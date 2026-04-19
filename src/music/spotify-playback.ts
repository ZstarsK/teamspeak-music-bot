import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { OggSyncGate } from "../audio/ogg-sync-gate.js";
import { PcmGate } from "../audio/pcm-gate.js";
import type { AudioPlayer } from "../audio/player.js";
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
const PCM_SWITCH_QUIET_WINDOW_MS = 120;
const PCM_SWITCH_TIMEOUT_MS = 1_500;
const PCM_TARGET_WAIT_TIMEOUT_MS = 5_000;
const PCM_TARGET_WAIT_INTERVAL_MS = 180;
const PCM_TARGET_STABLE_MS = 360;
const PCM_POST_TARGET_DISCARD_MS = 520;
const PCM_GATE_READY_INPUT_BYTES = 44100 * 4 / 10; // 100ms of s16le stereo at librespot's 44.1kHz output
const LIBRESPOT_EVENT_POLL_INTERVAL_MS = 80;
const LIBRESPOT_EVENT_RETENTION = 200;
const LIBRESPOT_BITRATE = "160";

export interface SpotifyLibrespotEvent {
  PLAYER_EVENT?: string;
  TRACK_ID?: string;
  OLD_TRACK_ID?: string;
  URI?: string;
  NAME?: string;
  DURATION_MS?: string;
  POSITION_MS?: string;
  ARTISTS?: string;
  SINK_STATUS?: string;
  time?: number;
}

const LIBRESPOT_TRACK_READY_EVENTS = new Set([
  "playing",
  "started",
  "changed",
  "seeked",
  "position_correction",
]);

export function isLibrespotAudioReadyEvent(
  event: SpotifyLibrespotEvent,
  params: { trackId: string; targetProgressMs?: number },
): boolean {
  const eventName = event.PLAYER_EVENT;
  if (!eventName || !LIBRESPOT_TRACK_READY_EVENTS.has(eventName)) {
    return false;
  }
  const trackMatches = event.TRACK_ID === params.trackId || event.URI === `spotify:track:${params.trackId}`;
  if (!trackMatches) {
    return false;
  }
  if (params.targetProgressMs === undefined) {
    return true;
  }
  if (event.POSITION_MS === undefined) {
    return false;
  }
  const positionMs = Number(event.POSITION_MS);
  return Number.isFinite(positionMs) && Math.abs(positionMs - params.targetProgressMs) < 8_000;
}

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
  usePassthrough?: boolean;
  accessToken?: string;
}): string[] {
  const args = [
    "--name", params.deviceName,
    "--backend", "pipe",
    ...(params.usePassthrough ? ["--passthrough"] : ["--format", "S16"]),
    "--cache", params.audioCacheDir,
    "--system-cache", params.systemCacheDir,
    "--bitrate", LIBRESPOT_BITRATE,
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

export function shouldReuseSpotifyStreamForTrackSwitch(params: {
  sameProcess: boolean;
  playerState: "idle" | "playing" | "paused";
  outputMode: "pcm" | "encoded";
}): boolean {
  return params.sameProcess && params.playerState !== "idle";
}

function directoryHasFiles(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

const librespotPassthroughSupportCache = new Map<string, boolean>();

function detectLibrespotPassthroughSupport(bin: string): boolean {
  const cached = librespotPassthroughSupportCache.get(bin);
  if (cached !== undefined) return cached;
  let supported = false;
  try {
    const result = spawnSync(bin, ["--help"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
    supported = output.includes("passthrough");
  } catch {
    supported = false;
  }
  librespotPassthroughSupportCache.set(bin, supported);
  return supported;
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
  private readonly baseDeviceName: string;
  private readonly logger: Logger;
  private lastExitDetail: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private playbackStarted = false;
  private processLaunchId = 0;
  private currentDeviceName: string;
  private attachedPlayer: AudioPlayer | null = null;
  private streamAttached = false;
  private activeTrackId: string | null = null;
  private currentOutputMode: "pcm" | "encoded" = "pcm";
  private transitionInFlight = false;
  private pcmGate: PcmGate | null = null;
  private encodedGate: OggSyncGate | null = null;
  private recentEvents: SpotifyLibrespotEvent[] = [];
  private playbackCommandId = 0;

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
    this.baseDeviceName = `${this.config.spotifyDeviceName || "TSMusicBot Spotify"} ${safeBotId.slice(0, 8)}`;
    this.currentDeviceName = this.baseDeviceName;
    this.logger = logger.child({ component: "spotify-playback" });
  }

  async play(song: Song, player: AudioPlayer, onEnd: () => void | Promise<void>): Promise<void> {
    const account = await this.provider.getPlaybackAccount(song.accountId);
    const trackUri = this.provider.getTrackUri(song.id);
    this.playbackCommandId += 1;
    const playerState = player.getState();
    let sameProcess = Boolean(this.librespot && !this.librespot.killed && this.activeAccountId === account.id);
    await this.ensureProcess(account, onEnd);
    let deviceId = await this.waitForDeviceWithPassthroughFallback(account, onEnd);
    let reusingStream = shouldReuseSpotifyStreamForTrackSwitch({
      sameProcess,
      playerState,
      outputMode: this.currentOutputMode,
    }) && this.streamAttached && this.attachedPlayer === player;

    const pcmReusingStream = reusingStream && this.currentOutputMode === "pcm";
    const encodedStream = this.currentOutputMode === "encoded";
    if (encodedStream) {
      if (sameProcess) {
        this.prepareEncodedBoundary(player);
      }
      this.attachPlayerToStream(player);
      reusingStream = false;
    } else if (!reusingStream) {
      this.attachPlayerToStream(player);
    } else if (pcmReusingStream) {
      this.logger.info(
        { deviceId: this.activeDeviceId, fromTrackUri: this.activeTrackUri, toTrackUri: trackUri, playerState },
        "Reusing existing Spotify PCM stream",
      );
    }
    this.activeAccountId = account.id;
    this.activeDeviceId = deviceId;
    this.activeTrackUri = trackUri;
    this.activeTrackId = song.id;
    try {
      if (pcmReusingStream) {
        await this.withTransition(async () => {
          await this.preparePcmBoundary(player, 0);
          const transitionStartedAt = Date.now();
          const transitionDeadline = transitionStartedAt + PCM_TARGET_WAIT_TIMEOUT_MS;
          await this.provider.startPlayback({
            accountId: account.id,
            deviceId,
            trackUri,
          });
          this.playbackStarted = true;
          const confirmed = await this.waitForTargetPlayback(account.id, deviceId, song.id, undefined, transitionDeadline);
          if (!confirmed) {
            throw new Error(`Spotify target playback was not confirmed for ${trackUri}`);
          }
          const librespotReady = await this.waitForLibrespotAudioReady(song.id, undefined, transitionStartedAt, transitionDeadline);
          if (!librespotReady) {
            throw new Error(`librespot did not confirm audio for ${trackUri}`);
          }
          const gateReady = await this.waitForPcmGateInput(transitionDeadline);
          if (!gateReady) {
            throw new Error(`Spotify PCM gate did not receive post-switch input for ${trackUri}`);
          }
          this.restartPcmPlayerForTransition(player);
          await this.releasePcmBoundary(player, 0);
        });
      } else if (encodedStream) {
        await this.withTransition(async () => {
          await this.provider.startPlayback({
            accountId: account.id,
            deviceId,
            trackUri,
          });
          this.playbackStarted = true;
        });
      } else {
        await this.provider.startPlayback({
          accountId: account.id,
          deviceId,
          trackUri,
        });
        this.playbackStarted = true;
      }
    } catch (err) {
      const shouldPauseSpotify = this.playbackStarted;
      this.playbackStarted = false;
      this.beginPcmGateDiscard("spotify-playback-failed");
      this.beginEncodedGateDiscard("spotify-playback-failed");
      if (shouldPauseSpotify) {
        try {
          await this.pause();
        } catch (pauseErr) {
          this.logger.warn({ err: pauseErr }, "Failed to pause Spotify playback after transition failure");
        }
      }
      player.setDiscardingAudio(false);
      player.stop({ skipCleanup: true });
      this.destroyPcmGate();
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
    const player = this.attachedPlayer;
    const targetSeconds = Math.max(0, seconds);
    if (!player) {
      await this.provider.seekPlayback(targetSeconds * 1000, this.activeAccountId, this.activeDeviceId);
      return;
    }
    if (this.currentOutputMode === "pcm") {
      await this.withTransition(async () => {
        await this.preparePcmBoundary(player, targetSeconds);
        const transitionStartedAt = Date.now();
        const transitionDeadline = transitionStartedAt + PCM_TARGET_WAIT_TIMEOUT_MS;
        await this.provider.seekPlayback(targetSeconds * 1000, this.activeAccountId!, this.activeDeviceId);
        const confirmed = await this.waitForTargetPlayback(
          this.activeAccountId!,
          this.activeDeviceId,
          this.activeTrackId ?? undefined,
          targetSeconds * 1000,
          transitionDeadline,
        );
        if (!confirmed) {
          throw new Error(`Spotify target seek was not confirmed for ${targetSeconds}s`);
        }
        if (this.activeTrackId) {
          const librespotReady = await this.waitForLibrespotAudioReady(
            this.activeTrackId,
            targetSeconds * 1000,
            transitionStartedAt,
            transitionDeadline,
          );
          if (!librespotReady) {
            throw new Error(`librespot did not confirm seek audio for ${targetSeconds}s`);
          }
        }
        const gateReady = await this.waitForPcmGateInput(transitionDeadline);
        if (!gateReady) {
          throw new Error(`Spotify PCM gate did not receive post-seek input for ${targetSeconds}s`);
        }
        this.restartPcmPlayerForTransition(player);
        await this.releasePcmBoundary(player, targetSeconds);
      });
      return;
    }
    await this.withTransition(async () => {
      await this.provider.seekPlayback(targetSeconds * 1000, this.activeAccountId!, this.activeDeviceId);
    });
    player.markSeek(targetSeconds);
  }

  shutdown(): void {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
    this.destroyPcmGate();
    this.destroyEncodedGate();
    if (this.librespot) {
      this.librespot.kill("SIGTERM");
      this.librespot = null;
    }
    this.activeAccountId = null;
    this.activeDeviceId = null;
    this.activeTrackUri = null;
    this.activeTrackId = null;
    this.playbackStarted = false;
    this.attachedPlayer = null;
    this.streamAttached = false;
    this.currentOutputMode = "pcm";
    this.transitionInFlight = false;
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
        "const keys = ['PLAYER_EVENT','TRACK_ID','OLD_TRACK_ID','URI','NAME','DURATION_MS','POSITION_MS','ARTISTS','SINK_STATUS'];",
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
    this.recentEvents = [];
  }

  private async ensureProcess(
    account: SpotifyAccountRecord,
    onEnd: () => void | Promise<void>,
    options: { forcePcm?: boolean } = {},
  ): Promise<void> {
    if (this.librespot && !this.librespot.killed && this.activeAccountId === account.id) {
      this.startEventWatcher(onEnd);
      return;
    }
    this.shutdown();
    this.ensureRuntimeFiles();
    this.lastExitDetail = null;
    this.processLaunchId += 1;
    this.currentDeviceName = this.buildDeviceName(this.processLaunchId);

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

    const bin = this.config.spotifyLibrespotPath || "librespot";
    const usePassthrough = !options.forcePcm && detectLibrespotPassthroughSupport(bin);
    this.currentOutputMode = usePassthrough ? "encoded" : "pcm";
    if (options.forcePcm) {
      this.logger.warn({ bin }, "librespot passthrough disabled for this start, using PCM pipe output");
    } else if (!usePassthrough) {
      this.logger.warn({ bin }, "librespot passthrough is unavailable, falling back to PCM pipe output");
    }

    const args = buildLibrespotArgs({
      mode,
      deviceName: this.currentDeviceName,
      eventScriptPath: this.eventScriptPath,
      audioCacheDir: cachePaths.audioDir,
      systemCacheDir: cachePaths.systemDir,
      usePassthrough,
      ...(mode === "access-token" ? { accessToken: account.accessToken } : {}),
    });

    this.logger.info(
      {
        bin,
        deviceName: this.currentDeviceName,
        authMode: mode,
        outputMode: this.currentOutputMode,
        cacheDir: cachePaths.audioDir,
        systemCacheDir: cachePaths.systemDir,
      },
      "Starting librespot sidecar",
    );
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SPOTIFY_EVENT_FILE: this.eventFilePath,
      },
    });
    this.librespot = child;
    this.activeAccountId = account.id;
    this.activeDeviceId = null;
    this.activeTrackUri = null;
    this.activeTrackId = null;
    this.playbackStarted = false;
    this.attachedPlayer = null;
    this.streamAttached = false;
    this.destroyPcmGate();
    this.destroyEncodedGate();

    child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (message) this.logger.info({ librespot: message }, "librespot stderr");
    });

    child.on("error", (err) => {
      this.logger.error({ err, bin }, "librespot failed to start");
    });

    child.on("close", (code, signal) => {
      this.logger.warn({ code, signal }, "librespot sidecar closed");
      if (this.librespot === child) {
        this.destroyPcmGate();
        this.destroyEncodedGate();
        this.librespot = null;
        this.activeDeviceId = null;
        this.attachedPlayer = null;
        this.streamAttached = false;
      }
      this.lastExitDetail = { code, signal };
    });

    this.startEventWatcher(onEnd);
  }

  private startEventWatcher(onEnd: () => void | Promise<void>): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      this.readEvents(onEnd);
    }, EVENT_POLL_INTERVAL_MS);
  }

  private readNewEvents(): SpotifyLibrespotEvent[] {
    try {
      if (!fs.existsSync(this.eventFilePath)) return [];
      const stat = fs.statSync(this.eventFilePath);
      if (stat.size <= this.eventOffset) return [];
      const fd = fs.openSync(this.eventFilePath, "r");
      try {
        const buffer = Buffer.alloc(stat.size - this.eventOffset);
        fs.readSync(fd, buffer, 0, buffer.length, this.eventOffset);
        this.eventOffset = stat.size;
        const events: SpotifyLibrespotEvent[] = [];
        for (const line of buffer.toString("utf-8").split("\n")) {
          if (!line.trim()) continue;
          events.push(JSON.parse(line) as SpotifyLibrespotEvent);
        }
        if (events.length > 0) {
          this.recentEvents.push(...events);
          if (this.recentEvents.length > LIBRESPOT_EVENT_RETENTION) {
            this.recentEvents.splice(0, this.recentEvents.length - LIBRESPOT_EVENT_RETENTION);
          }
        }
        return events;
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      this.logger.warn({ err }, "Failed to read librespot events");
      return [];
    }
  }

  private readEvents(onEnd: () => void | Promise<void>): void {
    for (const event of this.readNewEvents()) {
      if (event.PLAYER_EVENT === "end_of_track") {
        if (this.transitionInFlight) {
          this.logger.debug({ event }, "Ignoring Spotify end_of_track event during transition");
          continue;
        }
        if (this.isEventForActiveTrack(event)) {
          this.handleTrackEnd(onEnd);
        } else {
          this.logger.debug({ event, activeTrackUri: this.activeTrackUri }, "Ignoring stale Spotify end_of_track event");
        }
      } else if (event.PLAYER_EVENT === "unavailable") {
        if (this.transitionInFlight) {
          this.logger.debug({ event }, "Ignoring Spotify unavailable event during transition");
          continue;
        }
        if (this.isEventForActiveTrack(event)) {
          this.logger.warn({ event }, "Spotify track unavailable");
          this.handleTrackEnd(onEnd);
        } else {
          this.logger.debug({ event, activeTrackUri: this.activeTrackUri }, "Ignoring stale Spotify unavailable event");
        }
      }
    }
  }

  private handleTrackEnd(onEnd: () => void | Promise<void>): void {
    const now = Date.now();
    if (now - this.lastEndAt < 1000) return;
    this.lastEndAt = now;
    this.playbackStarted = false;
    this.activeTrackUri = null;
    this.activeTrackId = null;
    Promise.resolve()
      .then(() => onEnd())
      .catch((err) => this.logger.error({ err }, "Spotify end-of-track handler failed"));
  }

  private attachPlayerToStream(player: AudioPlayer): void {
    const cleanup = this.createPlaybackCleanup();
    if (this.currentOutputMode === "encoded") {
      this.destroyPcmGate();
      this.startEncodedPlayer(player, cleanup);
      return;
    } else {
      this.destroyEncodedGate();
      this.startPcmPlayer(player, cleanup);
      return;
    }
  }

  private createPlaybackCleanup(): () => void {
    const cleanupCommandId = this.playbackCommandId;
    const cleanupTrackUri = this.activeTrackUri;
    return () => {
      this.attachedPlayer = null;
      this.streamAttached = false;
      if (this.currentOutputMode === "pcm") {
        this.destroyPcmGate();
      } else {
        this.beginEncodedGateDiscard("playback-cleanup");
      }
      if (!this.playbackStarted) return;
      Promise.resolve()
        .then(() => sleep(120))
        .then(() => {
          if (
            this.playbackCommandId !== cleanupCommandId ||
            this.transitionInFlight ||
            this.activeTrackUri !== cleanupTrackUri
          ) {
            this.logger.debug(
              { cleanupTrackUri, activeTrackUri: this.activeTrackUri },
              "Skipping stale Spotify pause during playback cleanup",
            );
            return undefined;
          }
          return this.pause();
        })
        .catch((err) => {
          this.logger.warn({ err }, "Failed to pause Spotify playback during cleanup");
        });
    };
  }

  private ensureEncodedGate(): OggSyncGate {
    if (this.encodedGate) {
      return this.encodedGate;
    }
    const stream = this.librespot?.stdout;
    if (!stream) {
      throw new Error("librespot stdout is not available");
    }
    this.destroyPcmGate();
    const gate = new OggSyncGate();
    gate.on("error", (err) => {
      this.logger.warn({ err }, "Spotify encoded gate error");
    });
    stream.once("error", (err) => {
      this.logger.warn({ err }, "librespot stdout error");
    });
    stream.pipe(gate);
    this.encodedGate = gate;
    this.logger.info({ gateStats: gate.getStats() }, "Attached Spotify encoded Ogg gate");
    return gate;
  }

  private startEncodedPlayer(player: AudioPlayer, cleanup = this.createPlaybackCleanup()): void {
    const gate = this.ensureEncodedGate();
    gate.syncToNextLogicalStream("spotify-encoded-start");
    this.logger.info({ gateStats: gate.getStats() }, "Spotify encoded gate waiting for next Ogg stream");
    player.playEncodedStream(gate, {
      inputFormat: "ogg",
      cleanup,
      suppressTrackEnd: true,
    });
    this.attachedPlayer = player;
    this.streamAttached = true;
  }

  private prepareEncodedBoundary(player: AudioPlayer): void {
    const gate = this.ensureEncodedGate();
    gate.syncToNextLogicalStream("spotify-encoded-transition");
    player.stop({ skipCleanup: true });
    this.attachedPlayer = null;
    this.streamAttached = false;
    this.logger.info(
      { gateStats: gate.getStats(), activeTrackUri: this.activeTrackUri },
      "Prepared encoded Ogg boundary for Spotify transition",
    );
  }

  private beginEncodedGateDiscard(reason: string): boolean {
    if (!this.encodedGate) {
      return false;
    }
    this.encodedGate.beginDiscard(reason);
    this.logger.info({ reason, gateStats: this.encodedGate.getStats() }, "Spotify encoded gate discarding input");
    return true;
  }

  private destroyEncodedGate(): void {
    if (!this.encodedGate) {
      return;
    }
    try {
      this.librespot?.stdout?.unpipe(this.encodedGate);
    } catch (err) {
      this.logger.debug({ err }, "Failed to unpipe Spotify encoded gate");
    }
    this.encodedGate.destroy();
    this.encodedGate = null;
  }

  private ensurePcmGate(): PcmGate {
    if (this.pcmGate) {
      return this.pcmGate;
    }
    const stream = this.librespot?.stdout;
    if (!stream) {
      throw new Error("librespot stdout is not available");
    }
    this.destroyEncodedGate();
    const gate = new PcmGate();
    gate.on("error", (err) => {
      this.logger.warn({ err }, "Spotify PCM gate error");
    });
    stream.once("error", (err) => {
      this.logger.warn({ err }, "librespot stdout error");
    });
    stream.pipe(gate);
    this.pcmGate = gate;
    this.logger.info({ gateStats: gate.getStats() }, "Attached Spotify PCM gate");
    return gate;
  }

  private startPcmPlayer(player: AudioPlayer, cleanup = this.createPlaybackCleanup()): void {
    const gate = this.ensurePcmGate();
    player.playPcmStream(gate, {
      inputSampleRate: 44100,
      cleanup,
      suppressTrackEnd: true,
    });
    this.attachedPlayer = player;
    this.streamAttached = true;
  }

  private restartPcmPlayerForTransition(player: AudioPlayer): void {
    if (!this.pcmGate) {
      return;
    }
    this.pcmGate.beginDiscard("spotify-ffmpeg-reattach");
    player.stop({ skipCleanup: true });
    this.attachedPlayer = null;
    this.streamAttached = false;
    this.startPcmPlayer(player);
    this.logger.info({ gateStats: this.pcmGate.getStats() }, "Restarted FFmpeg for Spotify PCM transition");
  }

  private beginPcmGateDiscard(reason: string): boolean {
    if (!this.pcmGate) {
      return false;
    }
    this.pcmGate.beginDiscard(reason);
    this.logger.info({ reason, gateStats: this.pcmGate.getStats() }, "Spotify PCM gate discarding input");
    return true;
  }

  private destroyPcmGate(): void {
    if (!this.pcmGate) {
      return;
    }
    try {
      this.librespot?.stdout?.unpipe(this.pcmGate);
    } catch (err) {
      this.logger.debug({ err }, "Failed to unpipe Spotify PCM gate");
    }
    this.pcmGate.destroy();
    this.pcmGate = null;
  }

  private async preparePcmBoundary(player: AudioPlayer, nextElapsedSeconds: number): Promise<void> {
    if (player.getState() === "idle") {
      player.markSeek(nextElapsedSeconds);
      return;
    }
    player.pause();
    if (this.beginPcmGateDiscard("spotify-transition")) {
      player.setDiscardingAudio(false);
    } else {
      player.setDiscardingAudio(true);
    }
    await this.pauseForTransition();
    const deadline = Date.now() + PCM_SWITCH_TIMEOUT_MS;
    let zeroSince = 0;
    while (Date.now() < deadline) {
      player.flushBufferedAudio();
      const buffered = player.getBufferedAudioBytes();
      if (buffered === 0) {
        if (zeroSince === 0) zeroSince = Date.now();
        if (Date.now() - zeroSince >= PCM_SWITCH_QUIET_WINDOW_MS) break;
      } else {
        zeroSince = 0;
      }
      await sleep(40);
    }
    player.flushBufferedAudio();
    player.markSeek(nextElapsedSeconds);
    this.logger.info(
      {
        bufferedBytes: player.getBufferedAudioBytes(),
        nextElapsedSeconds,
        gateStats: this.pcmGate?.getStats(),
      },
      "Prepared PCM boundary for Spotify transition",
    );
  }

  private async releasePcmBoundary(player: AudioPlayer, nextElapsedSeconds: number): Promise<void> {
    await this.discardPcmFor(player, PCM_POST_TARGET_DISCARD_MS);
    if (this.pcmGate) {
      this.pcmGate.endDiscard({ resetAlignment: true });
    }
    player.flushBufferedAudio();
    player.markSeek(nextElapsedSeconds);
    player.setDiscardingAudio(false);
    player.resume();
    this.logger.info(
      {
        bufferedBytes: player.getBufferedAudioBytes(),
        nextElapsedSeconds,
        gateStats: this.pcmGate?.getStats(),
      },
      "Released PCM boundary after Spotify transition",
    );
  }

  private async discardPcmFor(player: AudioPlayer, durationMs: number): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      player.flushBufferedAudio();
      await sleep(40);
    }
  }

  private async waitForLibrespotAudioReady(
    trackId: string,
    targetProgressMs: number | undefined,
    transitionStartedAt: number,
    deadlineAt: number,
  ): Promise<boolean> {
    while (Date.now() < deadlineAt) {
      this.readNewEvents();
      const match = this.recentEvents.find((event) => {
        const eventTime = event.time ?? 0;
        return eventTime >= transitionStartedAt
          && isLibrespotAudioReadyEvent(event, { trackId, targetProgressMs });
      });
      if (match) {
        this.logger.info(
          {
            event: match.PLAYER_EVENT,
            trackId: match.TRACK_ID,
            positionMs: match.POSITION_MS,
          },
          "librespot target audio event confirmed",
        );
        return true;
      }
      await sleep(LIBRESPOT_EVENT_POLL_INTERVAL_MS);
    }
    this.logger.warn({ trackId, targetProgressMs }, "Timed out waiting for librespot target audio event");
    return false;
  }

  private async waitForPcmGateInput(deadlineAt: number): Promise<boolean> {
    const startBytes = this.pcmGate?.getStats().inputBytes ?? 0;
    while (Date.now() < deadlineAt) {
      const inputBytes = this.pcmGate?.getStats().inputBytes ?? startBytes;
      if (inputBytes - startBytes >= PCM_GATE_READY_INPUT_BYTES) {
        this.logger.info(
          { inputDeltaBytes: inputBytes - startBytes, gateStats: this.pcmGate?.getStats() },
          "Spotify PCM gate received post-switch input",
        );
        return true;
      }
      await sleep(40);
    }
    this.logger.warn({ gateStats: this.pcmGate?.getStats() }, "Timed out waiting for Spotify PCM gate input");
    return false;
  }

  private async waitForTargetPlayback(
    accountId: string,
    deviceId: string | null,
    trackId?: string,
    targetProgressMs?: number,
    deadlineAt = Date.now() + PCM_TARGET_WAIT_TIMEOUT_MS,
  ): Promise<boolean> {
    let matchedSince = 0;
    while (Date.now() < deadlineAt) {
      try {
        const state = await this.provider.getCurrentPlayback(accountId);
        const deviceMatches = !deviceId || !state?.deviceId || state.deviceId === deviceId;
        const trackMatches = !trackId || state?.trackId === trackId;
        const playingMatches = state?.isPlaying === true;
        const progressMatches = targetProgressMs === undefined
          || Math.abs((state?.progressMs ?? 0) - targetProgressMs) < 8_000;
        if (state && deviceMatches && trackMatches && playingMatches && progressMatches) {
          if (matchedSince === 0) matchedSince = Date.now();
          if (Date.now() - matchedSince >= PCM_TARGET_STABLE_MS) {
            this.logger.info(
              {
                deviceId: state.deviceId,
                trackId: state.trackId,
                progressMs: state.progressMs,
                isPlaying: state.isPlaying,
              },
              "Spotify target playback confirmed",
            );
            return true;
          }
        } else {
          matchedSince = 0;
        }
      } catch (err) {
        this.logger.debug({ err, trackId, targetProgressMs }, "Spotify target playback check failed");
      }
      await sleep(PCM_TARGET_WAIT_INTERVAL_MS);
    }
    this.logger.warn({ deviceId, trackId, targetProgressMs }, "Timed out waiting for Spotify target playback confirmation");
    return false;
  }

  private async pauseForTransition(): Promise<void> {
    if (!this.activeAccountId || !this.playbackStarted) return;
    try {
      await this.provider.pausePlayback(this.activeAccountId, this.activeDeviceId);
    } catch (err) {
      this.logger.warn({ err }, "Failed to pause Spotify playback before transition");
    }
  }

  private async withTransition<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionInFlight = true;
    try {
      return await fn();
    } finally {
      this.transitionInFlight = false;
    }
  }

  private isEventForActiveTrack(event: { TRACK_ID?: string; URI?: string }): boolean {
    if (!this.activeTrackUri && !this.activeTrackId) {
      return false;
    }
    if (event.URI) {
      return event.URI === this.activeTrackUri;
    }
    if (event.TRACK_ID) {
      return event.TRACK_ID === this.activeTrackId;
    }
    return false;
  }

  private buildDeviceName(launchId: number): string {
    return `${this.baseDeviceName}-${launchId}`.slice(0, 80);
  }

  private async waitForDeviceWithPassthroughFallback(
    account: SpotifyAccountRecord,
    onEnd: () => void | Promise<void>,
  ): Promise<string> {
    try {
      return await this.waitForDevice(account.id, this.currentDeviceName);
    } catch (err) {
      if (this.currentOutputMode !== "encoded") {
        throw err;
      }
      this.logger.warn(
        { err, deviceName: this.currentDeviceName },
        "librespot passthrough sidecar did not become ready, falling back to PCM pipe output",
      );
      this.shutdown();
      await this.ensureProcess(account, onEnd, { forcePcm: true });
      return await this.waitForDevice(account.id, this.currentDeviceName);
    }
  }

  private async waitForDevice(accountId: string, deviceName: string): Promise<string> {
    if (this.activeDeviceId) return this.activeDeviceId;
    const deadline = Date.now() + DEVICE_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!this.librespot && this.lastExitDetail) {
        const { code, signal } = this.lastExitDetail;
        throw new Error(
          `librespot exited before Spotify device appeared (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        );
      }
      const deviceId = await this.provider.findDeviceIdByName(deviceName, accountId);
      if (deviceId) {
        this.activeDeviceId = deviceId;
        return deviceId;
      }
      await sleep(DEVICE_WAIT_INTERVAL_MS);
    }
    throw new Error(`Spotify device "${deviceName}" did not appear`);
  }
}
