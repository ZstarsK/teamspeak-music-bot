import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AudioPlayer, ExternallyControlledSourceCloseEvent } from "../audio/player.js";
import {
  getConfiguredSpotifyLibrespotAuthMode,
  type BotConfig,
  type SpotifyLibrespotAuthMode,
} from "../data/config.js";
import type { Logger } from "../logger.js";
import type { Song } from "./provider.js";
import { SpotifyProvider, type SpotifyAccountRecord } from "./spotify.js";
import {
  decideSpotifyEndOfTrack,
  decideSpotifySourceClose,
  getSpotifyLocalTrackEndRemainingMs,
  isGracefulSpotifySourceClose,
  SPOTIFY_EARLY_END_REWIND_MS,
  SPOTIFY_END_WAIT_MAX_MS,
  SPOTIFY_END_WAIT_POLL_MS,
  SPOTIFY_HARD_RECOVERY_MAX_ATTEMPTS,
  SPOTIFY_SOURCE_RECOVERY_DELAY_MS,
  SPOTIFY_SOURCE_RECOVERY_MAX_ATTEMPTS,
} from "./spotify-recovery-policy.js";
import { SpotifyPlaybackSession } from "./spotify-playback-session.js";
import { SpotifyStreamBridge } from "./spotify-stream-bridge.js";

const DEVICE_WAIT_TIMEOUT_MS = 12_000;
const DEVICE_WAIT_INTERVAL_MS = 250;
const EVENT_POLL_INTERVAL_MS = 350;
const PCM_TARGET_WAIT_TIMEOUT_MS = 5_000;
const PCM_TARGET_WAIT_INTERVAL_MS = 180;
const PCM_TARGET_STABLE_MS = 360;
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

function isAbortError(err: unknown): boolean {
  const candidate = err as { code?: string; name?: string } | null | undefined;
  return candidate?.code === "ERR_CANCELED" || candidate?.name === "CanceledError" || candidate?.name === "AbortError";
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

interface SpotifySidecarLaunch {
  bin: string;
  args: string[];
  mode: SpotifyLibrespotAuthMode;
  outputMode: "pcm" | "encoded";
  cachePaths: SpotifyLibrespotCachePaths;
}

class SpotifySidecar {
  constructor(
    private readonly config: BotConfig,
    private readonly runtimeDir: string,
    private readonly runtimeAudioCacheDir: string,
    private readonly runtimeSystemCacheDir: string,
  ) {}

  prepareLaunch(params: {
    account: SpotifyAccountRecord;
    deviceName: string;
    eventScriptPath: string;
    forcePcm?: boolean;
  }): SpotifySidecarLaunch {
    const mode = getConfiguredSpotifyLibrespotAuthMode(this.config);
    const cachePaths = mode === "credentials-cache"
      ? getSpotifyLibrespotCachePaths(path.dirname(this.runtimeDir), params.account)
      : {
          accountKey: sanitizeName(params.account.userId),
          baseDir: this.runtimeDir,
          audioDir: this.runtimeAudioCacheDir,
          systemDir: this.runtimeSystemCacheDir,
        };

    if (mode === "credentials-cache") {
      fs.mkdirSync(cachePaths.audioDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(cachePaths.systemDir, { recursive: true, mode: 0o700 });
      if (!directoryHasFiles(cachePaths.systemDir) && !directoryHasFiles(cachePaths.audioDir)) {
        throw new Error(
          `Spotify credentials cache not found for ${params.account.displayName || params.account.userId}. ` +
          `Expected cache under ${cachePaths.baseDir}. ` +
          "Run librespot OAuth login once to seed the local cache.",
        );
      }
    }

    const bin = this.config.spotifyLibrespotPath || "librespot";
    const usePassthrough = !params.forcePcm && detectLibrespotPassthroughSupport(bin);
    const outputMode = usePassthrough ? "encoded" : "pcm";
    const args = buildLibrespotArgs({
      mode,
      deviceName: params.deviceName,
      eventScriptPath: params.eventScriptPath,
      audioCacheDir: cachePaths.audioDir,
      systemCacheDir: cachePaths.systemDir,
      usePassthrough,
      ...(mode === "access-token" ? { accessToken: params.account.accessToken } : {}),
    });

    return { bin, args, mode, outputMode, cachePaths };
  }

  spawn(launch: SpotifySidecarLaunch, eventFilePath: string): ChildProcess {
    return spawn(launch.bin, launch.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        SPOTIFY_EVENT_FILE: eventFilePath,
      },
    });
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
  private readonly baseDeviceName: string;
  private readonly logger: Logger;
  private lastExitDetail: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private playbackStarted = false;
  private activePlaybackStartedAt = 0;
  private processLaunchId = 0;
  private currentDeviceName: string;
  private activeTrackId: string | null = null;
  private currentOutputMode: "pcm" | "encoded" = "pcm";
  private transitionInFlight = false;
  private transitionDepth = 0;
  private sidecar: SpotifySidecar;
  private streamBridge: SpotifyStreamBridge;
  private session = new SpotifyPlaybackSession();
  private recentEvents: SpotifyLibrespotEvent[] = [];
  private playbackCommandId = 0;
  private controlAbortController: AbortController | null = null;
  private activeTrackDuration = 0;
  private activeSong: Song | null = null;
  private activeOnEnd: (() => void | Promise<void>) | null = null;
  private pendingTrackEndTimer: ReturnType<typeof setTimeout> | null = null;

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
    this.sidecar = new SpotifySidecar(
      this.config,
      this.runtimeDir,
      this.runtimeAudioCacheDir,
      this.runtimeSystemCacheDir,
    );
    this.streamBridge = new SpotifyStreamBridge(this.logger);
  }

  async play(song: Song, player: AudioPlayer, onEnd: () => void | Promise<void>): Promise<void> {
    const account = await this.provider.getPlaybackAccount(song.accountId);
    const trackUri = this.provider.getTrackUri(song.id);
    this.cancelPendingTrackEnd();
    const command = this.session.beginPlay({
      trackUri,
      trackId: song.id,
      durationSeconds: song.duration,
      song,
    });
    const commandId = command.id;
    this.playbackCommandId = commandId;
    const playerState = player.getState();
    let sameProcess = Boolean(this.librespot && !this.librespot.killed && this.activeAccountId === account.id);
    await this.ensureProcess(account);
    if (this.isStaleCommand(commandId, "Spotify play superseded after sidecar start", { trackUri })) {
      return;
    }
    const deviceId = await this.waitForDeviceWithPassthroughFallback(account, commandId);
    if (!deviceId || this.isStaleCommand(commandId, "Spotify play superseded after device wait", { trackUri })) {
      return;
    }
    this.session.setActiveTrack({
      trackUri,
      trackId: song.id,
      durationSeconds: song.duration,
      song,
    });
    this.session.setState("starting");
    let reusingStream = shouldReuseSpotifyStreamForTrackSwitch({
      sameProcess,
      playerState,
      outputMode: this.currentOutputMode,
    }) && this.streamBridge.isStreamAttachedTo(player);

    const pcmReusingStream = reusingStream && this.currentOutputMode === "pcm";
    const encodedStream = this.currentOutputMode === "encoded";
    if (encodedStream) {
      if (sameProcess) {
        this.prepareEncodedBoundary(player);
      }
      this.activeAccountId = account.id;
      this.activeDeviceId = deviceId;
      this.activeTrackUri = trackUri;
      this.activeTrackId = song.id;
      this.activeTrackDuration = song.duration;
      this.activeSong = song;
      this.activeOnEnd = onEnd;
      this.attachPlayerToStream(player, song, onEnd, commandId);
      reusingStream = false;
    } else if (!reusingStream) {
      this.activeAccountId = account.id;
      this.activeDeviceId = deviceId;
      this.activeTrackUri = trackUri;
      this.activeTrackId = song.id;
      this.activeTrackDuration = song.duration;
      this.activeSong = song;
      this.activeOnEnd = onEnd;
      this.attachPlayerToStream(player, song, onEnd, commandId);
    } else if (pcmReusingStream) {
      this.logger.info(
        { deviceId: this.activeDeviceId, fromTrackUri: this.activeTrackUri, toTrackUri: trackUri, playerState },
        "Reusing existing Spotify PCM stream",
      );
      this.activeAccountId = account.id;
      this.activeDeviceId = deviceId;
      this.activeTrackUri = trackUri;
      this.activeTrackId = song.id;
      this.activeTrackDuration = song.duration;
      this.activeSong = song;
      this.activeOnEnd = onEnd;
    }
    let startedCurrent = false;
    try {
      if (pcmReusingStream) {
        await this.withTransition(async () => {
          this.session.setState("switching");
          const boundaryPrepared = await this.preparePcmBoundary(player, 0, commandId, trackUri, song.id);
          if (
            !boundaryPrepared ||
            this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify play superseded after PCM boundary preparation")
          ) {
            return;
          }
          const transitionStartedAt = Date.now();
          const transitionDeadline = transitionStartedAt + PCM_TARGET_WAIT_TIMEOUT_MS;
          const signal = this.createControlSignal();
          const started = await this.runControlRequest(
            signal,
            () => this.provider.startPlayback({
              accountId: account.id,
              deviceId,
              trackUri,
              signal,
            }),
            "Spotify startPlayback aborted for superseded PCM switch",
            { trackUri },
          );
          if (
            !started ||
            this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify play superseded after startPlayback")
          ) {
            return;
          }
          this.playbackStarted = true;
          this.activePlaybackStartedAt = Date.now();
          const confirmed = await this.waitForTargetPlayback(account.id, deviceId, song.id, undefined, transitionDeadline);
          if (this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify play superseded after target confirmation")) {
            return;
          }
          if (!confirmed) {
            throw new Error(`Spotify target playback was not confirmed for ${trackUri}`);
          }
          const librespotReady = await this.waitForLibrespotAudioReady(song.id, undefined, transitionStartedAt, transitionDeadline);
          if (this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify play superseded after librespot confirmation")) {
            return;
          }
          if (!librespotReady) {
            throw new Error(`librespot did not confirm audio for ${trackUri}`);
          }
          const gateReady = await this.waitForPcmGateInput(transitionDeadline);
          if (this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify play superseded after PCM gate wait")) {
            return;
          }
          if (!gateReady) {
            throw new Error(`Spotify PCM gate did not receive post-switch input for ${trackUri}`);
          }
          this.restartPcmPlayerForTransition(player, song, onEnd, commandId);
          await this.releasePcmBoundary(player, 0);
          startedCurrent = true;
          this.session.setState("playing");
        });
      } else if (encodedStream) {
        await this.withTransition(async () => {
          this.session.setState("switching");
          const signal = this.createControlSignal();
          const started = await this.runControlRequest(
            signal,
            () => this.provider.startPlayback({
              accountId: account.id,
              deviceId,
              trackUri,
              signal,
            }),
            "Spotify startPlayback aborted for superseded encoded switch",
            { trackUri },
          );
          if (
            !started ||
            this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify play superseded after encoded startPlayback")
          ) {
            return;
          }
          this.playbackStarted = true;
          this.activePlaybackStartedAt = Date.now();
          startedCurrent = true;
          this.session.setState("playing");
        });
      } else {
        const signal = this.createControlSignal();
        const started = await this.runControlRequest(
          signal,
          () => this.provider.startPlayback({
            accountId: account.id,
            deviceId,
            trackUri,
            signal,
          }),
          "Spotify startPlayback aborted for superseded play",
          { trackUri },
        );
        if (
          !started ||
          this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify play superseded after startPlayback")
        ) {
          return;
        }
        this.playbackStarted = true;
        this.activePlaybackStartedAt = Date.now();
        startedCurrent = true;
        this.session.setState("playing");
      }
    } catch (err) {
      if (this.isStalePlaybackContext(commandId, trackUri, song.id, "Ignoring stale Spotify play failure", { err })) {
        return;
      }
      this.session.setState("failed");
      const shouldPauseSpotify = this.playbackStarted;
      this.playbackStarted = false;
      this.activePlaybackStartedAt = 0;
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
    if (!startedCurrent) {
      return;
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
    const player = this.streamBridge.getAttachedPlayer();
    const targetSeconds = Math.max(0, seconds);
    const commandId = this.playbackCommandId;
    const trackUri = this.activeTrackUri;
    const trackId = this.activeTrackId;
    if (!player) {
      const signal = this.createControlSignal();
      const seeked = await this.runControlRequest(
        signal,
        () => this.provider.seekPlayback(targetSeconds * 1000, this.activeAccountId!, this.activeDeviceId, signal),
        "Spotify seek aborted for superseded command without attached player",
        { trackUri, targetSeconds },
      );
      if (
        !seeked ||
        this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify seek superseded without attached player")
      ) {
        return;
      }
      return;
    }
    if (this.currentOutputMode === "pcm") {
      await this.withTransition(async () => {
        this.session.setState("seeking");
        const boundaryPrepared = await this.preparePcmBoundary(player, targetSeconds, commandId, trackUri, trackId);
        if (
          !boundaryPrepared ||
          this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify seek superseded after PCM boundary preparation")
        ) {
          return;
        }
        const transitionStartedAt = Date.now();
        const transitionDeadline = transitionStartedAt + PCM_TARGET_WAIT_TIMEOUT_MS;
        const signal = this.createControlSignal();
        const seeked = await this.runControlRequest(
          signal,
          () => this.provider.seekPlayback(targetSeconds * 1000, this.activeAccountId!, this.activeDeviceId, signal),
          "Spotify seek aborted for superseded PCM seek",
          { trackUri, targetSeconds },
        );
        if (
          !seeked ||
          this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify seek superseded after seekPlayback")
        ) {
          return;
        }
        const confirmed = await this.waitForTargetPlayback(
          this.activeAccountId!,
          this.activeDeviceId,
          this.activeTrackId ?? undefined,
          targetSeconds * 1000,
          transitionDeadline,
        );
        if (this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify seek superseded after target confirmation")) {
          return;
        }
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
          if (this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify seek superseded after librespot confirmation")) {
            return;
          }
          if (!librespotReady) {
            throw new Error(`librespot did not confirm seek audio for ${targetSeconds}s`);
          }
        }
        const gateReady = await this.waitForPcmGateInput(transitionDeadline);
        if (this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify seek superseded after PCM gate wait")) {
          return;
        }
        if (!gateReady) {
          throw new Error(`Spotify PCM gate did not receive post-seek input for ${targetSeconds}s`);
        }
        if (this.activeSong && this.activeOnEnd) {
          this.restartPcmPlayerForTransition(player, this.activeSong, this.activeOnEnd, this.playbackCommandId);
        }
        await this.releasePcmBoundary(player, targetSeconds);
        this.session.setState("playing");
      });
      return;
    }
    await this.withTransition(async () => {
      this.session.setState("seeking");
      const signal = this.createControlSignal();
      const seeked = await this.runControlRequest(
        signal,
        () => this.provider.seekPlayback(targetSeconds * 1000, this.activeAccountId!, this.activeDeviceId, signal),
        "Spotify seek aborted for superseded encoded seek",
        { trackUri, targetSeconds },
      );
      if (
        !seeked ||
        this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify seek superseded after encoded seekPlayback")
      ) {
        return;
      }
    });
    if (this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify seek superseded before local seek marker")) {
      return;
    }
    player.markSeek(targetSeconds);
    this.session.setState("playing");
  }

  shutdown(): void {
    if (this.watcher) {
      clearInterval(this.watcher);
      this.watcher = null;
    }
    this.streamBridge.destroy();
    if (this.librespot) {
      this.librespot.kill("SIGTERM");
      this.librespot = null;
    }
    this.activeAccountId = null;
    this.activeDeviceId = null;
    this.activeTrackUri = null;
    this.activeTrackId = null;
    this.activeTrackDuration = 0;
    this.activeSong = null;
    this.activeOnEnd = null;
    this.playbackStarted = false;
    this.activePlaybackStartedAt = 0;
    this.streamBridge.clearAttachment();
    this.currentOutputMode = "pcm";
    this.transitionInFlight = false;
    this.transitionDepth = 0;
    this.abortControlRequest();
    this.cancelPendingTrackEnd();
    this.session.clearActive();
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
    options: { forcePcm?: boolean } = {},
  ): Promise<void> {
    if (this.librespot && !this.librespot.killed && this.activeAccountId === account.id) {
      this.startEventWatcher();
      return;
    }
    this.shutdown();
    this.ensureRuntimeFiles();
    this.lastExitDetail = null;
    this.processLaunchId += 1;
    this.currentDeviceName = this.buildDeviceName(this.processLaunchId);

    const launch = this.sidecar.prepareLaunch({
      account,
      deviceName: this.currentDeviceName,
      eventScriptPath: this.eventScriptPath,
      ...options,
    });
    this.currentOutputMode = launch.outputMode;
    if (options.forcePcm) {
      this.logger.warn({ bin: launch.bin }, "librespot passthrough disabled for this start, using PCM pipe output");
    } else if (launch.outputMode !== "encoded") {
      this.logger.warn({ bin: launch.bin }, "librespot passthrough is unavailable, falling back to PCM pipe output");
    }

    this.logger.info(
      {
        bin: launch.bin,
        deviceName: this.currentDeviceName,
        authMode: launch.mode,
        outputMode: this.currentOutputMode,
        cacheDir: launch.cachePaths.audioDir,
        systemCacheDir: launch.cachePaths.systemDir,
      },
      "Starting librespot sidecar",
    );
    const child = this.sidecar.spawn(launch, this.eventFilePath);
    this.librespot = child;
    this.activeAccountId = account.id;
    this.activeDeviceId = null;
    this.activeTrackUri = null;
    this.activeTrackId = null;
    this.activeTrackDuration = 0;
    this.activeSong = null;
    this.activeOnEnd = null;
    this.playbackStarted = false;
    this.activePlaybackStartedAt = 0;
    this.streamBridge.clearAttachment();
    this.streamBridge.setSource(child.stdout ?? null, this.currentOutputMode);

    child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trimEnd();
      if (message) this.logger.info({ librespot: message }, "librespot stderr");
    });
    child.stdout?.on("error", (err) => {
      this.logger.warn({ err }, "librespot stdout error");
    });

    child.on("error", (err) => {
      this.logger.error({ err, bin: launch.bin }, "librespot failed to start");
    });

    child.on("close", (code, signal) => {
      this.logger.warn({ code, signal }, "librespot sidecar closed");
      if (this.librespot === child) {
        this.streamBridge.destroy();
        this.librespot = null;
        this.activeDeviceId = null;
        this.activeTrackDuration = 0;
        this.activeSong = null;
        this.activeOnEnd = null;
        this.activePlaybackStartedAt = 0;
        this.streamBridge.clearAttachment();
        this.cancelPendingTrackEnd();
      }
      this.lastExitDetail = { code, signal };
    });

    this.startEventWatcher();
  }

  private startEventWatcher(): void {
    if (this.watcher) return;
    this.watcher = setInterval(() => {
      this.readEvents();
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

  private readEvents(): void {
    for (const event of this.readNewEvents()) {
      if (event.PLAYER_EVENT === "end_of_track") {
        if (this.transitionInFlight) {
          this.logger.debug({ event }, "Ignoring Spotify end_of_track event during transition");
          continue;
        }
        if (this.isEventForActiveTrack(event)) {
          const onEnd = this.activeOnEnd;
          if (!onEnd) {
            this.logger.debug({ event, activeTrackUri: this.activeTrackUri }, "Ignoring Spotify end_of_track without active end handler");
            continue;
          }
          this.handleTrackEnd(onEnd, { waitForLocalPlayback: true, event });
        } else {
          this.logger.debug({ event, activeTrackUri: this.activeTrackUri }, "Ignoring stale Spotify end_of_track event");
        }
      } else if (event.PLAYER_EVENT === "unavailable") {
        if (this.transitionInFlight) {
          this.logger.debug({ event }, "Ignoring Spotify unavailable event during transition");
          continue;
        }
        if (this.isEventForActiveTrack(event)) {
          const onEnd = this.activeOnEnd;
          if (!onEnd) {
            this.logger.debug({ event, activeTrackUri: this.activeTrackUri }, "Ignoring Spotify unavailable without active end handler");
            continue;
          }
          this.logger.warn({ event }, "Spotify track unavailable");
          this.handleTrackEnd(onEnd);
        } else {
          this.logger.debug({ event, activeTrackUri: this.activeTrackUri }, "Ignoring stale Spotify unavailable event");
        }
      }
    }
  }

  private handleTrackEnd(
    onEnd: () => void | Promise<void>,
    options: { waitForLocalPlayback?: boolean; event?: SpotifyLibrespotEvent } = {},
  ): void {
    if (options.waitForLocalPlayback && this.deferTrackEndUntilLocalPlayback(onEnd, options.event)) {
      return;
    }
    this.completeTrackEnd(onEnd);
  }

  private completeTrackEnd(onEnd: () => void | Promise<void>): void {
    this.cancelPendingTrackEnd();
    const now = Date.now();
    if (now - this.lastEndAt < 1000) return;
    this.session.setState("ending");
    this.lastEndAt = now;
    this.playbackStarted = false;
    this.activePlaybackStartedAt = 0;
    this.activeTrackUri = null;
    this.activeTrackId = null;
    this.activeTrackDuration = 0;
    this.activeSong = null;
    this.activeOnEnd = null;
    this.session.clearActive();
    Promise.resolve()
      .then(() => onEnd())
      .catch((err) => this.logger.error({ err }, "Spotify end-of-track handler failed"));
  }

  private deferTrackEndUntilLocalPlayback(
    onEnd: () => void | Promise<void>,
    event?: SpotifyLibrespotEvent,
  ): boolean {
    const player = this.streamBridge.getAttachedPlayer();
    const duration = this.activeTrackDuration;
    if (!player || !Number.isFinite(duration) || duration <= 0) {
      return false;
    }

    const commandId = this.playbackCommandId;
    const trackUri = this.activeTrackUri;
    const trackId = this.activeTrackId;
    const startedAt = Date.now();
    const decision = decideSpotifyEndOfTrack({
      durationSeconds: duration,
      elapsedSeconds: player.getElapsed(),
      playerState: player.getState(),
    });
    const remainingMs = decision.remainingMs;
    if (decision.action === "complete") {
      return false;
    }
    if (decision.action === "ignore") {
      this.logger.warn(
        {
          event,
          trackUri,
          trackId,
          elapsed: player.getElapsed(),
          duration,
          remainingMs,
        },
        "Ignoring early Spotify end_of_track while local source is still playing",
      );
      return true;
    }
    if (this.pendingTrackEndTimer) {
      this.logger.debug(
        { trackUri, trackId, elapsed: player.getElapsed(), duration },
        "Spotify end_of_track already waiting for local playback",
      );
      return true;
    }

    this.logger.info(
      {
        event,
        trackUri,
        trackId,
        elapsed: player.getElapsed(),
        duration,
        remainingMs,
      },
      "Delaying Spotify end_of_track until local playback catches up",
    );

    const check = () => {
      this.pendingTrackEndTimer = null;
      if (
        commandId !== this.playbackCommandId ||
        this.activeTrackUri !== trackUri ||
        this.activeTrackId !== trackId
      ) {
        this.logger.debug(
          { trackUri, trackId, activeTrackUri: this.activeTrackUri, activeTrackId: this.activeTrackId },
          "Dropping stale delayed Spotify end_of_track",
        );
        return;
      }

      const elapsed = player.getElapsed();
      const remaining = this.getLocalTrackEndRemainingMs(player, duration);
      const waitedMs = Date.now() - startedAt;
      const playerState = player.getState();
      if (playerState === "paused") {
        this.pendingTrackEndTimer = setTimeout(check, SPOTIFY_END_WAIT_POLL_MS);
        return;
      }
      if (remaining <= 0 || playerState === "idle" || waitedMs >= SPOTIFY_END_WAIT_MAX_MS) {
        this.logger.info(
          {
            trackUri,
            trackId,
            elapsed,
            duration,
            remainingMs: remaining,
            waitedMs,
            playerState,
          },
          "Completing delayed Spotify end_of_track",
        );
        this.completeTrackEnd(onEnd);
        return;
      }

      this.pendingTrackEndTimer = setTimeout(check, Math.min(SPOTIFY_END_WAIT_POLL_MS, remaining));
    };

    this.pendingTrackEndTimer = setTimeout(check, Math.min(SPOTIFY_END_WAIT_POLL_MS, remainingMs));
    return true;
  }

  private async restartCurrentTrackFromLocalPosition(
    song: Song,
    player: AudioPlayer,
    onEnd: () => void | Promise<void>,
    event: SpotifyLibrespotEvent | undefined,
    remainingMs: number,
    attempt: number,
    options: { forceProcessRestart?: boolean } = {},
  ): Promise<void> {
    const positionMs = Math.max(0, Math.round(player.getElapsed() * 1000) - SPOTIFY_EARLY_END_REWIND_MS);
    const positionSeconds = positionMs / 1000;
    let trackUri = this.activeTrackUri ?? this.provider.getTrackUri(song.id);
    const recoveryCommand = this.session.beginRecovery({
      trackUri,
      trackId: song.id,
      durationSeconds: song.duration,
      song,
    });
    const commandId = recoveryCommand.id;
    this.playbackCommandId = commandId;
    let accountId = this.activeAccountId;
    let deviceId = this.activeDeviceId;
    this.cancelPendingTrackEnd();

    this.logger.warn(
      {
        event,
        trackUri,
        trackId: this.activeTrackId,
        elapsed: player.getElapsed(),
        duration: this.activeTrackDuration,
        remainingMs,
        positionMs,
        attempt,
        forceProcessRestart: options.forceProcessRestart === true,
      },
      "Recovering Spotify playback by restarting current track",
    );

    if (options.forceProcessRestart) {
      const account = await this.provider.getPlaybackAccount(song.accountId);
      const preservedSoftRecoveryAttempts = this.session.getSoftRecoveryAttempts();
      const preservedHardRecoveryAttempts = this.session.getHardRecoveryAttempts();
      player.stop({ skipCleanup: true });
      this.shutdown();
      try {
        await this.ensureProcess(account);
      } finally {
        this.session.restoreRecoveryCounters(trackUri, preservedSoftRecoveryAttempts, preservedHardRecoveryAttempts);
      }
      try {
        deviceId = await this.waitForDeviceWithPassthroughFallback(account, commandId);
      } finally {
        this.session.restoreRecoveryCounters(trackUri, preservedSoftRecoveryAttempts, preservedHardRecoveryAttempts);
      }
      if (!deviceId || this.isStaleCommand(commandId, "Spotify recovery superseded after device wait", { trackUri })) {
        return;
      }
      accountId = account.id;
      trackUri = this.provider.getTrackUri(song.id);
      this.activeAccountId = account.id;
      this.activeDeviceId = deviceId;
      this.activeTrackUri = trackUri;
      this.activeTrackId = song.id;
      this.activeTrackDuration = song.duration;
      this.activeSong = song;
      this.activeOnEnd = onEnd;
      this.session.setActiveTrack({
        trackUri,
        trackId: song.id,
        durationSeconds: song.duration,
        song,
      });
    }

    if (!accountId || !deviceId || !trackUri) {
      throw new Error("Cannot recover Spotify playback without an active device");
    }

    await this.withTransition(async () => {
      this.session.setState("recovering");
      if (this.currentOutputMode === "encoded") {
        this.prepareEncodedBoundary(player);
        this.attachPlayerToStream(player, song, onEnd, commandId);
        player.markSeek(positionSeconds);
        const signal = this.createControlSignal();
        const started = await this.runControlRequest(
          signal,
          () => this.provider.startPlayback({
            accountId,
            deviceId,
            trackUri,
            positionMs,
            signal,
          }),
          "Spotify recovery startPlayback aborted for superseded encoded recovery",
          { trackUri },
        );
        if (
          !started ||
          this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify recovery superseded after encoded startPlayback")
        ) {
          return;
        }
        this.playbackStarted = true;
        this.activePlaybackStartedAt = Date.now();
        this.session.setState("playing");
        return;
      }

      const boundaryPrepared = await this.preparePcmBoundary(player, positionSeconds, commandId, trackUri, song.id);
      if (!boundaryPrepared) {
        return;
      }
      const transitionStartedAt = Date.now();
      const transitionDeadline = transitionStartedAt + PCM_TARGET_WAIT_TIMEOUT_MS;
      const signal = this.createControlSignal();
      const started = await this.runControlRequest(
        signal,
        () => this.provider.startPlayback({
          accountId,
          deviceId,
          trackUri,
          positionMs,
          signal,
        }),
        "Spotify recovery startPlayback aborted for superseded PCM recovery",
        { trackUri },
      );
      if (
        !started ||
        this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify recovery superseded after startPlayback")
      ) {
        return;
      }
      this.playbackStarted = true;
      this.activePlaybackStartedAt = Date.now();
      const confirmed = await this.waitForTargetPlayback(
        accountId,
        deviceId,
        song.id,
        positionMs,
        transitionDeadline,
      );
      if (this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify recovery superseded after target confirmation")) {
        return;
      }
      if (!confirmed) {
        throw new Error(`Spotify target playback was not confirmed while recovering ${trackUri}`);
      }
      const librespotReady = await this.waitForLibrespotAudioReady(song.id, positionMs, transitionStartedAt, transitionDeadline);
      if (this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify recovery superseded after librespot confirmation")) {
        return;
      }
      if (!librespotReady) {
        throw new Error(`librespot did not confirm audio while recovering ${trackUri}`);
      }
      const gateReady = await this.waitForPcmGateInput(transitionDeadline);
      if (this.isStalePlaybackContext(commandId, trackUri, song.id, "Spotify recovery superseded after PCM gate wait")) {
        return;
      }
      if (!gateReady) {
        throw new Error(`Spotify PCM gate did not receive recovery input for ${trackUri}`);
      }
      this.restartPcmPlayerForTransition(player, song, onEnd, commandId);
      await this.releasePcmBoundary(player, positionSeconds);
      this.session.setState("playing");
    });
  }

  private getLocalTrackEndRemainingMs(player: AudioPlayer, duration: number): number {
    return getSpotifyLocalTrackEndRemainingMs({
      durationSeconds: duration,
      elapsedSeconds: player.getElapsed(),
    });
  }

  private cancelPendingTrackEnd(): void {
    if (!this.pendingTrackEndTimer) return;
    clearTimeout(this.pendingTrackEndTimer);
    this.pendingTrackEndTimer = null;
  }

  private attachPlayerToStream(
    player: AudioPlayer,
    song: Song,
    onEnd: () => void | Promise<void>,
    commandId: number,
  ): void {
    const cleanup = this.createPlaybackCleanup();
    const onSourceClosed = this.createSourceCloseHandler(song, player, onEnd, commandId);
    this.streamBridge.attachPlayer(player, { cleanup, onSourceClosed });
  }

  private createPlaybackCleanup(): () => void {
    const cleanupCommandId = this.playbackCommandId;
    const cleanupTrackUri = this.activeTrackUri;
    return () => {
      this.streamBridge.clearAttachment();
      if (this.currentOutputMode === "pcm") {
        this.streamBridge.destroy();
      } else {
        this.streamBridge.beginEncodedGateDiscard("playback-cleanup");
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

  private createSourceCloseHandler(
    song: Song,
    player: AudioPlayer,
    onEnd: () => void | Promise<void>,
    commandId: number,
  ): (event: ExternallyControlledSourceCloseEvent) => void {
    return (event) => {
      this.handleSourceClose(song, player, onEnd, commandId, event).catch((recoveryErr) => {
        this.logger.error({ err: recoveryErr, songId: song.id }, "Spotify source recovery failed");
      });
    };
  }

  private async handleSourceClose(
    song: Song,
    player: AudioPlayer,
    onEnd: () => void | Promise<void>,
    commandId: number,
    sourceClose: ExternallyControlledSourceCloseEvent,
  ): Promise<void> {
    const trackUri = this.provider.getTrackUri(song.id);
    if (
      commandId !== this.playbackCommandId ||
      this.activeTrackUri !== trackUri ||
      this.activeTrackId !== song.id ||
      this.transitionInFlight
    ) {
      this.logger.debug(
        { sourceClose, trackUri, activeTrackUri: this.activeTrackUri, commandId, activeCommandId: this.playbackCommandId },
        "Ignoring stale Spotify source close",
      );
      return;
    }

    this.session.resetRecoveryIfTrackChanged(trackUri);
    const remainingMs = this.getLocalTrackEndRemainingMs(player, this.activeTrackDuration || song.duration);
    const gracefulSourceEnd = isGracefulSpotifySourceClose(sourceClose);
    const decision = decideSpotifySourceClose({
      remainingMs,
      gracefulSourceEnd,
      softAttempts: this.session.getSoftRecoveryAttempts(),
      maxSoftAttempts: SPOTIFY_SOURCE_RECOVERY_MAX_ATTEMPTS,
      hardAttempts: this.session.getHardRecoveryAttempts(),
      maxHardAttempts: SPOTIFY_HARD_RECOVERY_MAX_ATTEMPTS,
    });

    if (decision.action === "advance-near-end") {
      this.logger.warn(
        {
          sourceClose,
          trackUri,
          elapsed: player.getElapsed(),
          duration: this.activeTrackDuration || song.duration,
          remainingMs,
          gracefulSourceEnd,
        },
        "Spotify source stopped near local track end, advancing queue",
      );
      this.handleTrackEnd(onEnd, { waitForLocalPlayback: true });
      return;
    }

    if (decision.action === "advance-failed") {
      this.logger.warn(
        {
          sourceClose,
          trackUri,
          softAttempts: this.session.getSoftRecoveryAttempts(),
          hardAttempts: this.session.getHardRecoveryAttempts(),
          elapsed: player.getElapsed(),
          duration: this.activeTrackDuration || song.duration,
          remainingMs,
        },
        "Spotify source recovery and sidecar restart limits reached, advancing queue",
      );
      this.completeTrackEnd(onEnd);
      return;
    }

    if (decision.action === "hard-recover") {
      const hardAttempt = this.session.reserveHardRecovery(
        SPOTIFY_SOURCE_RECOVERY_MAX_ATTEMPTS,
        SPOTIFY_HARD_RECOVERY_MAX_ATTEMPTS,
      );
      if (hardAttempt === null) {
        this.completeTrackEnd(onEnd);
        return;
      }
      this.logger.warn(
        {
          sourceClose,
          trackUri,
          softAttempts: this.session.getSoftRecoveryAttempts(),
          hardAttempts: this.session.getHardRecoveryAttempts(),
          elapsed: player.getElapsed(),
          duration: this.activeTrackDuration || song.duration,
          remainingMs,
          hardAttempt,
        },
        "Spotify source recovery limit reached before local playback ended, restarting sidecar for current track",
      );
      await sleep(SPOTIFY_SOURCE_RECOVERY_DELAY_MS);
      if (
        commandId !== this.playbackCommandId ||
        this.activeTrackUri !== trackUri ||
        this.activeTrackId !== song.id
      ) {
        this.logger.debug(
          { trackUri, commandId, activeCommandId: this.playbackCommandId },
          "Skipping stale Spotify source recovery after limit",
        );
        return;
      }
      await this.restartCurrentTrackFromLocalPosition(
        song,
        player,
        onEnd,
        undefined,
        remainingMs,
        hardAttempt,
        { forceProcessRestart: true },
      );
      return;
    }

    const attempt = this.session.reserveSoftRecovery();
    this.logger.warn(
      { sourceClose, trackUri, attempt, maxAttempts: SPOTIFY_SOURCE_RECOVERY_MAX_ATTEMPTS },
      "Recovering Spotify source by restarting current track",
    );
    await sleep(SPOTIFY_SOURCE_RECOVERY_DELAY_MS);

    if (
      commandId !== this.playbackCommandId ||
      this.activeTrackUri !== trackUri ||
      this.activeTrackId !== song.id
    ) {
      this.logger.debug({ trackUri, commandId, activeCommandId: this.playbackCommandId }, "Skipping stale Spotify source recovery");
      return;
    }

    await this.restartCurrentTrackFromLocalPosition(song, player, onEnd, undefined, remainingMs, attempt);
  }

  private prepareEncodedBoundary(player: AudioPlayer): void {
    this.streamBridge.prepareEncodedBoundary(player, this.activeTrackUri);
  }

  private beginEncodedGateDiscard(reason: string): boolean {
    return this.streamBridge.beginEncodedGateDiscard(reason);
  }

  private destroyEncodedGate(): void {
    this.streamBridge.destroy();
  }

  private restartPcmPlayerForTransition(
    player: AudioPlayer,
    song: Song,
    onEnd: () => void | Promise<void>,
    commandId: number,
  ): void {
    this.streamBridge.restartPcmPlayerForTransition(player, {
      cleanup: this.createPlaybackCleanup(),
      onSourceClosed: this.createSourceCloseHandler(song, player, onEnd, commandId),
    });
  }

  private beginPcmGateDiscard(reason: string): boolean {
    return this.streamBridge.beginPcmGateDiscard(reason);
  }

  private destroyPcmGate(): void {
    this.streamBridge.destroy();
  }

  private async preparePcmBoundary(
    player: AudioPlayer,
    nextElapsedSeconds: number,
    commandId: number,
    trackUri: string | null,
    trackId: string | null,
  ): Promise<boolean> {
    const paused = await this.pauseForTransition(commandId, trackUri, trackId);
    if (!paused) return false;
    await this.streamBridge.preparePcmBoundary(player, nextElapsedSeconds);
    return true;
  }

  private async releasePcmBoundary(player: AudioPlayer, nextElapsedSeconds: number): Promise<void> {
    await this.streamBridge.releasePcmBoundary(player, nextElapsedSeconds);
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
    return this.streamBridge.waitForPcmGateInput(deadlineAt);
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

  private async pauseForTransition(commandId: number, trackUri: string | null, trackId: string | null): Promise<boolean> {
    if (!this.activeAccountId || !this.playbackStarted) return true;
    try {
      const accountId = this.activeAccountId;
      const deviceId = this.activeDeviceId;
      const signal = this.createControlSignal();
      const paused = await this.runControlRequest(
        signal,
        () => this.provider.pausePlayback(accountId, deviceId, signal),
        "Spotify pause aborted for superseded transition",
        { trackUri },
      );
      if (!paused) return false;
    } catch (err) {
      this.logger.warn({ err }, "Failed to pause Spotify playback before transition");
    }
    return !this.isStalePlaybackContext(commandId, trackUri, trackId, "Spotify transition pause result ignored for stale command");
  }

  private async withTransition<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionDepth += 1;
    this.transitionInFlight = true;
    try {
      return await fn();
    } finally {
      this.transitionDepth = Math.max(0, this.transitionDepth - 1);
      this.transitionInFlight = this.transitionDepth > 0;
    }
  }

  private isStaleCommand(commandId: number, message: string, extra: Record<string, unknown> = {}): boolean {
    if (commandId === this.playbackCommandId) return false;
    this.logger.debug({ ...extra, commandId, activeCommandId: this.playbackCommandId }, message);
    return true;
  }

  private isStalePlaybackContext(
    commandId: number,
    trackUri: string | null,
    trackId: string | null,
    message: string,
    extra: Record<string, unknown> = {},
  ): boolean {
    if (
      commandId === this.playbackCommandId &&
      this.activeTrackUri === trackUri &&
      this.activeTrackId === trackId
    ) {
      return false;
    }
    this.logger.debug(
      {
        ...extra,
        commandId,
        activeCommandId: this.playbackCommandId,
        trackUri,
        activeTrackUri: this.activeTrackUri,
        trackId,
        activeTrackId: this.activeTrackId,
      },
      message,
    );
    return true;
  }

  private createControlSignal(): AbortSignal {
    this.abortControlRequest();
    this.controlAbortController = new AbortController();
    return this.controlAbortController.signal;
  }

  private abortControlRequest(): void {
    this.controlAbortController?.abort();
    this.controlAbortController = null;
  }

  private async runControlRequest(
    signal: AbortSignal,
    request: () => Promise<void>,
    abortedMessage: string,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    try {
      await request();
      return !signal.aborted;
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        this.logger.debug({ ...extra, err }, abortedMessage);
        return false;
      }
      throw err;
    }
  }

  private isEventForActiveTrack(event: { TRACK_ID?: string; URI?: string; time?: number }): boolean {
    if (!this.activeTrackUri && !this.activeTrackId) {
      return false;
    }
    if (
      this.activePlaybackStartedAt > 0 &&
      typeof event.time === "number" &&
      event.time < this.activePlaybackStartedAt
    ) {
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
    commandId: number,
  ): Promise<string | null> {
    try {
      const deviceId = await this.waitForDevice(account.id, this.currentDeviceName);
      if (this.isStaleCommand(commandId, "Spotify device wait result ignored for stale command", { deviceId })) {
        return null;
      }
      return deviceId;
    } catch (err) {
      if (this.isStaleCommand(commandId, "Spotify passthrough fallback skipped for stale command")) {
        return null;
      }
      if (this.currentOutputMode !== "encoded") {
        throw err;
      }
      this.logger.warn(
        { err, deviceName: this.currentDeviceName },
        "librespot passthrough sidecar did not become ready, falling back to PCM pipe output",
      );
      this.shutdown();
      await this.ensureProcess(account, { forcePcm: true });
      if (this.isStaleCommand(commandId, "Spotify PCM fallback device wait skipped for stale command")) {
        return null;
      }
      const deviceId = await this.waitForDevice(account.id, this.currentDeviceName);
      if (this.isStaleCommand(commandId, "Spotify PCM fallback device wait result ignored for stale command", { deviceId })) {
        return null;
      }
      return deviceId;
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
