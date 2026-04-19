import { spawn, execSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { accessSync, chmodSync, constants } from "node:fs";
import { createOpusEncoder, PCM_FRAME_BYTES, type Encoder } from "./encoder.js";
import {
  DEFAULT_MAX_VOLUME,
  getConfiguredMaxVolume,
  getDefaultDuckingSettings,
  type DuckingSettings,
} from "../data/config.js";
import type { Logger } from "../logger.js";

// ffmpeg-static is a CJS module that exports the path to the bundled ffmpeg binary.
const require = createRequire(import.meta.url);
const ffmpegPath: string | null = require("ffmpeg-static");

/** Ensure the given binary has execute permission. */
function isExecutable(binPath: string): boolean {
  try {
    accessSync(binPath, constants.X_OK);
    return true;
  } catch {
    try {
      chmodSync(binPath, 0o755);
      accessSync(binPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}

/** Test if an ffmpeg binary actually works by running -version. */
function ffmpegWorks(bin: string): boolean {
  try {
    execSync(`"${bin}" -version`, { timeout: 5000, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolved once at module load.
 *
 * Priority: system FFmpeg → bundled ffmpeg-static.
 *
 * System-installed FFmpeg is always compatible with the running OS/container,
 * while the pre-compiled binary from ffmpeg-static can SIGSEGV in Docker
 * (passes `ffmpeg -version` but crashes during actual audio processing due to
 * incompatible glibc or missing shared libraries).
 */
const resolvedFfmpeg: string = (() => {
  // 1. Prefer system-installed FFmpeg (always compatible with the runtime)
  if (ffmpegWorks("ffmpeg")) {
    return "ffmpeg";
  }

  // 2. Fall back to bundled ffmpeg-static binary
  // On Windows, ffmpeg-static may return a path with backslashes; on Linux/macOS
  // it may return a Windows .exe path if node_modules was copied cross-platform.
  const isWinPath = ffmpegPath ? /\\/.test(ffmpegPath) || ffmpegPath.endsWith(".exe") : false;
  const onWindows = process.platform === "win32";

  if (ffmpegPath && (onWindows === isWinPath)) {
    if (isExecutable(ffmpegPath) && ffmpegWorks(ffmpegPath)) {
      return ffmpegPath;
    }
  }

  // Last resort: always use "ffmpeg" so spawn error is clear, never use a cross-platform path
  return "ffmpeg";
})();

/** Resolve ffmpeg binary: prefer system PATH, fall back to bundled ffmpeg-static. */
function getFfmpegCommand(): string {
  return resolvedFfmpeg;
}

export interface PlayerEvents {
  frame: (opusFrame: Buffer) => void;
  trackEnd: () => void;
  error: (err: Error) => void;
}

export type PlayerState = "idle" | "playing" | "paused";

const FRAME_DURATION_MS = 20;
const DEFAULT_VOLUME = 8;
const DUCKING_FADE_OUT_MS = 160;

export interface AudioPlayerOptions {
  maxVolume?: number;
}

export class AudioPlayer extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private encoder: Encoder;
  private state: PlayerState = "idle";
  private volume = DEFAULT_VOLUME;
  private pcmBuffer: Buffer = Buffer.alloc(0);
  private logger: Logger;
  private frameLoopRunning = false;
  private nextFrameTime = 0;
  private currentUrl = "";
  private seekOffset = 0;
  private framesPlayed = 0; // ground truth: number of 20ms frames sent
  private sessionId = 0;
  private static readonly BUFFER_HIGH_WATER = 960 * 1024; // ~5s of PCM at 48kHz stereo
  private static readonly BUFFER_LOW_WATER = 480 * 1024;  // ~2.5s
  private ffmpegPaused = false;
  private spawnFailed = false; // true if ffmpeg spawn errored (prevent trackEnd cascade)
  private consecutiveFailures = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 3;
  private duckingActive = false;
  private duckingFactor = 1;
  private lastFrameAt = 0;
  private duckingConfig: DuckingSettings = getDefaultDuckingSettings();
  private readonly maxVolume: number;
  private cleanupCurrentSource: (() => void | Promise<void>) | null = null;

  constructor(logger: Logger, options: AudioPlayerOptions = {}) {
    super();
    this.encoder = createOpusEncoder();
    this.logger = logger;
    this.maxVolume = getConfiguredMaxVolume({ maxVolume: options.maxVolume ?? DEFAULT_MAX_VOLUME });
    this.volume = Math.min(DEFAULT_VOLUME, this.maxVolume);
  }

  play(url: string, seekSeconds = 0): void {
    const args: string[] = [];

    // BiliBili CDN requires Referer header for audio playback
    if (url.includes("bilivideo") || url.includes("bilibili")) {
      args.push(
        "-headers",
        "Referer: https://www.bilibili.com\r\nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\r\n"
      );
    }

    args.push(
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
    );
    if (seekSeconds > 0) {
      args.push("-ss", String(seekSeconds));
    }
    args.push(
      "-i", url,
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-acodec", "pcm_s16le",
      "-",
    );

    this.playWithFfmpegArgs(args, {
      source: "url",
      display: url.slice(0, 80),
      currentUrl: url,
      seekSeconds,
    });
  }

  playPcmPipe(
    pipePath: string,
    options: {
      inputSampleRate?: number;
      seekSeconds?: number;
      cleanup?: () => void | Promise<void>;
    } = {},
  ): void {
    const seekSeconds = options.seekSeconds ?? 0;
    const args: string[] = [];
    if (seekSeconds > 0) {
      args.push("-ss", String(seekSeconds));
    }
    args.push(
      "-f", "s16le",
      "-ar", String(options.inputSampleRate ?? 44100),
      "-ac", "2",
      "-i", pipePath,
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-acodec", "pcm_s16le",
      "-",
    );

    this.playWithFfmpegArgs(args, {
      source: "pcm-pipe",
      display: pipePath,
      currentUrl: `pipe:${pipePath}`,
      seekSeconds,
      cleanup: options.cleanup,
    });
  }

  playPcmStream(
    input: NodeJS.ReadableStream,
    options: {
      inputSampleRate?: number;
      seekSeconds?: number;
      cleanup?: () => void | Promise<void>;
    } = {},
  ): void {
    const seekSeconds = options.seekSeconds ?? 0;
    const args: string[] = [];
    if (seekSeconds > 0) {
      args.push("-ss", String(seekSeconds));
    }
    args.push(
      "-f", "s16le",
      "-ar", String(options.inputSampleRate ?? 44100),
      "-ac", "2",
      "-i", "pipe:0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-acodec", "pcm_s16le",
      "-",
    );

    this.playWithFfmpegArgs(args, {
      source: "pcm-stream",
      display: "stdin",
      currentUrl: "pipe:stdin",
      seekSeconds,
      cleanup: options.cleanup,
      stdin: input,
    });
  }

  playEncodedStream(
    input: NodeJS.ReadableStream,
    options: {
      inputFormat?: string;
      seekSeconds?: number;
      cleanup?: () => void | Promise<void>;
    } = {},
  ): void {
    const seekSeconds = options.seekSeconds ?? 0;
    const args: string[] = [];
    if (seekSeconds > 0) {
      args.push("-ss", String(seekSeconds));
    }
    if (options.inputFormat) {
      args.push("-f", options.inputFormat);
    }
    args.push(
      "-i", "pipe:0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "-acodec", "pcm_s16le",
      "-",
    );

    this.playWithFfmpegArgs(args, {
      source: "encoded-stream",
      display: options.inputFormat ? `stdin:${options.inputFormat}` : "stdin:auto",
      currentUrl: "pipe:stdin",
      seekSeconds,
      cleanup: options.cleanup,
      stdin: input,
    });
  }

  private playWithFfmpegArgs(
    args: string[],
    options: {
      source: string;
      display: string;
      currentUrl: string;
      seekSeconds: number;
      cleanup?: () => void | Promise<void>;
      stdin?: NodeJS.ReadableStream;
    },
  ): void {
    this.stop();
    this.sessionId++;
    const playSessionId = this.sessionId;
    this.currentUrl = options.currentUrl;
    this.seekOffset = options.seekSeconds;
    this.framesPlayed = 0;
    this.lastFrameAt = 0;
    this.ffmpegPaused = false;
    this.spawnFailed = false;
    this.cleanupCurrentSource = options.cleanup ?? null;

    // Prevent rapid-fire spawn attempts when ffmpeg is broken
    if (this.consecutiveFailures >= AudioPlayer.MAX_CONSECUTIVE_FAILURES) {
      this.logger.error(
        { failures: this.consecutiveFailures, ffmpeg: getFfmpegCommand() },
        "Too many consecutive ffmpeg failures — ffmpeg binary may be missing or broken. Stopping playback."
      );
      this.state = "idle";
      this.emit("error", new Error("ffmpeg unavailable after repeated failures"));
      return;
    }

    this.logger.info(
      { source: options.source, input: options.display, seek: options.seekSeconds },
      "Starting playback",
    );

    const ffmpegBin = getFfmpegCommand();
    this.logger.info({ ffmpeg: ffmpegBin }, "Using ffmpeg binary");
    this.ffmpeg = spawn(ffmpegBin, args, { stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"] });

    // Prevent stream errors from crashing the process
    if (options.stdin && this.ffmpeg.stdin) {
      const ffmpegStdin = this.ffmpeg.stdin;
      (options.stdin as any).unpipe?.();
      options.stdin.on("error", (err) => {
        this.logger.warn({ err }, "PCM input stream error");
      });
      ffmpegStdin.on("error", (err) => {
        this.logger.warn({ err }, "FFmpeg stdin error");
      });
      options.stdin.pipe(ffmpegStdin);
    }
    this.ffmpeg.stdout!.on("error", (err) => {
      this.logger.warn({ err }, "FFmpeg stdout error");
    });
    this.ffmpeg.stderr!.on("error", (err) => {
      this.logger.warn({ err }, "FFmpeg stderr error");
    });

    let gotFirstData = false;
    const noDataTimeoutMs =
      options.source === "encoded-stream"
        ? 30_000
        : options.source === "pcm-stream" || options.source === "pcm-pipe"
          ? 20_000
          : 0;
    const noDataTimer = noDataTimeoutMs > 0
      ? setTimeout(() => {
        if (this.sessionId !== playSessionId || gotFirstData || this.state !== "playing") return;
        const err = new Error(`No PCM data received from ${options.source}`);
        this.logger.warn({ source: options.source, input: options.display }, "No PCM data received after playback start");
        this.spawnFailed = true;
        this.ffmpeg?.kill("SIGTERM");
        this.emit("error", err);
      }, noDataTimeoutMs)
      : null;
    this.ffmpeg.stdout!.on("data", (chunk: Buffer) => {
      if (!gotFirstData) {
        gotFirstData = true;
        if (noDataTimer) clearTimeout(noDataTimer);
        this.logger.info({ bytes: chunk.length }, "FFmpeg: first PCM data received");
      }
      this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      // Backpressure: pause FFmpeg stdout when buffer is too large
      if (this.pcmBuffer.length > AudioPlayer.BUFFER_HIGH_WATER && !this.ffmpegPaused && this.ffmpeg?.stdout) {
        this.ffmpeg.stdout.pause();
        this.ffmpegPaused = true;
      }
    });

    this.ffmpeg.on("close", (code, signal) => {
      if (noDataTimer) clearTimeout(noDataTimer);
      this.logger.info({ exitCode: code, signal, gotData: gotFirstData, framesPlayed: this.framesPlayed }, "FFmpeg process closed");
      if (this.sessionId === playSessionId) {
        this.ffmpeg = null; // Signal frame loop that no more data is coming
      }
    });

    this.ffmpeg.on("error", (err) => {
      this.logger.error({ err }, "FFmpeg error");
      if (this.sessionId === playSessionId) {
        this.spawnFailed = true;
        this.consecutiveFailures++;
        this.emit("error", err);
      }
    });

    // Log FFmpeg stderr at info level for debugging playback issues
    this.ffmpeg.stderr!.on("data", (data: Buffer) => {
      const msg = data.toString().trimEnd();
      // Log important FFmpeg messages at info level
      if (msg.includes("Error") || msg.includes("error") || msg.includes("HTTP") || msg.includes("Opening") || msg.includes("Stream")) {
        this.logger.info({ ffmpegStderr: msg }, "FFmpeg stderr");
      } else {
        this.logger.debug({ stderr: msg }, "FFmpeg stderr");
      }
    });

    this.state = "playing";
    this.startFrameLoop();
  }

  private startFrameLoop(): void {
    if (this.frameLoopRunning) return;
    this.frameLoopRunning = true;
    this.nextFrameTime = performance.now();
    this.scheduleNextFrame();
  }

  private scheduleNextFrame(): void {
    if (!this.frameLoopRunning) return;

    const loopSessionId = this.sessionId;

    this.nextFrameTime += FRAME_DURATION_MS;
    const now = performance.now();
    const delay = Math.max(0, this.nextFrameTime - now);

    setTimeout(() => {
      // Discard callback from a stale play session
      if (loopSessionId !== this.sessionId) return;
      if (!this.frameLoopRunning) return;

      if (this.state === "playing") {
        this.sendNextFrame();
      } else if (this.state === "paused") {
        this.nextFrameTime = performance.now();
      }

      if (!this.ffmpeg && this.pcmBuffer.length < PCM_FRAME_BYTES) {
        this.frameLoopRunning = false;
        if (this.state !== "idle") {
          this.state = "idle";
          // Don't emit trackEnd if ffmpeg spawn failed — prevents infinite retry cascade
          if (this.spawnFailed) {
            this.logger.warn("Suppressing trackEnd due to ffmpeg spawn failure");
          } else {
            this.consecutiveFailures = 0; // Reset on successful track completion
            this.emit("trackEnd");
          }
        }
        return;
      }

      this.scheduleNextFrame();
    }, delay);
  }

  private sendNextFrame(): void {
    if (this.pcmBuffer.length < PCM_FRAME_BYTES) return;

    const pcmFrame = this.pcmBuffer.subarray(0, PCM_FRAME_BYTES);
    this.pcmBuffer = this.pcmBuffer.subarray(PCM_FRAME_BYTES);

    // Backpressure: resume FFmpeg stdout when buffer drains below low-water mark
    if (this.ffmpegPaused && this.pcmBuffer.length < AudioPlayer.BUFFER_LOW_WATER && this.ffmpeg?.stdout) {
      this.ffmpeg.stdout.resume();
      this.ffmpegPaused = false;
    }

    try {
      const adjusted = this.applyVolume(pcmFrame);
      const opusFrame = this.encoder.encode(adjusted);
      this.emit("frame", opusFrame);
      this.framesPlayed++;
      this.lastFrameAt = Date.now();

      if (this.framesPlayed === 1) {
        this.logger.info({ opusBytes: opusFrame.length }, "First audio frame encoded and emitted");
      }
      // Log every ~10 seconds (500 frames * 20ms = 10s)
      if (this.framesPlayed % 500 === 0) {
        this.logger.debug({ framesPlayed: this.framesPlayed, elapsed: this.getElapsed() }, "Playback progress");
      }
    } catch (err) {
      this.logger.error({ err }, "Error encoding/sending audio frame");
      this.emit("error", err as Error);
    }
  }

  private applyVolume(pcm: Buffer): Buffer {
    const factor = this.getVolumeFactor();
    if (factor >= 0.999) return Buffer.from(pcm);
    const out = Buffer.alloc(pcm.length);
    for (let i = 0; i < pcm.length; i += 2) {
      let sample = pcm.readInt16LE(i);
      sample = Math.round(sample * factor);
      if (sample > 32767) sample = 32767;
      else if (sample < -32768) sample = -32768;
      out.writeInt16LE(sample, i);
    }
    return out;
  }

  private getVolumeFactor(): number {
    const targetDuckingFactor =
      this.duckingConfig.enabled && this.duckingActive
        ? this.duckingConfig.volumePercent / 100
        : 1;
    if (this.duckingFactor !== targetDuckingFactor) {
      const fadeMs =
        this.duckingConfig.enabled && this.duckingActive
          ? DUCKING_FADE_OUT_MS
          : Math.max(1, this.duckingConfig.recoveryMs);
      const maxStep = FRAME_DURATION_MS / fadeMs;
      if (this.duckingFactor < targetDuckingFactor) {
        this.duckingFactor = Math.min(targetDuckingFactor, this.duckingFactor + maxStep);
      } else {
        this.duckingFactor = Math.max(targetDuckingFactor, this.duckingFactor - maxStep);
      }
    }
    return (this.volume / 100) * this.duckingFactor;
  }

  /** Actual elapsed time in seconds (ground truth from frame count) */
  getElapsed(): number {
    return this.seekOffset + (this.framesPlayed * FRAME_DURATION_MS) / 1000;
  }

  seek(seconds: number): void {
    if (!this.currentUrl) return;
    // Reject NaN/Infinity/negative — the HTTP layer validates too, but a
    // bad value here would poison seekOffset and leave getElapsed()
    // returning NaN until the track ends.
    if (!Number.isFinite(seconds) || seconds < 0) {
      this.logger.warn({ seek: seconds }, "Ignoring invalid seek position");
      return;
    }
    this.logger.info({ seek: seconds }, "Seeking");
    this.play(this.currentUrl, seconds);
  }

  markSeek(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      this.logger.warn({ seek: seconds }, "Ignoring invalid seek position");
      return;
    }
    this.seekOffset = seconds;
    this.framesPlayed = 0;
    this.nextFrameTime = performance.now();
  }

  getSeekOffset(): number {
    return this.seekOffset;
  }

  pause(): void {
    if (this.state === "playing") {
      this.state = "paused";
      this.logger.debug("Playback paused");
    }
  }

  resume(): void {
    if (this.state === "paused") {
      this.state = "playing";
      this.nextFrameTime = performance.now();
      this.logger.debug("Playback resumed");
    }
  }

  stop(options: { skipCleanup?: boolean } = {}): void {
    this.sessionId++;
    this.frameLoopRunning = false;
    if (this.ffmpeg) {
      this.ffmpeg.kill("SIGTERM");
      this.ffmpeg = null;
    }
    const cleanup = options.skipCleanup ? null : this.cleanupCurrentSource;
    this.cleanupCurrentSource = null;
    if (cleanup) {
      Promise.resolve()
        .then(() => cleanup())
        .catch((err) => this.logger.warn({ err }, "Playback source cleanup failed"));
    }
    this.pcmBuffer = Buffer.alloc(0);
    this.ffmpegPaused = false;
    this.spawnFailed = false;
    this.state = "idle";
    this.currentUrl = "";
    this.seekOffset = 0;
    this.framesPlayed = 0;
    this.lastFrameAt = 0;
    this.duckingFactor = 1;
  }

  /** Reset the consecutive failure counter (e.g. after user action) */
  resetFailures(): void {
    this.consecutiveFailures = 0;
  }

  setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(this.maxVolume, vol));
  }

  setDuckingActive(active: boolean): void {
    this.duckingActive = active;
  }

  setDuckingConfig(config: DuckingSettings): void {
    this.duckingConfig = { ...config };
    if (!config.enabled) {
      this.duckingActive = false;
    }
  }

  getVolume(): number {
    return this.volume;
  }

  getState(): PlayerState {
    return this.state;
  }

  getLastFrameAt(): number {
    return this.lastFrameAt;
  }
}
