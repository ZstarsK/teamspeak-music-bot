import type { AudioPlayer, ExternallyControlledSourceCloseEvent } from "../audio/player.js";
import { OggSyncGate } from "../audio/ogg-sync-gate.js";
import { PcmGate } from "../audio/pcm-gate.js";
import type { Logger } from "../logger.js";

export const PCM_GATE_READY_INPUT_BYTES = 44100 * 4 / 10; // 100ms of s16le stereo at librespot's 44.1kHz output
export const PCM_SWITCH_QUIET_WINDOW_MS = 120;
export const PCM_SWITCH_TIMEOUT_MS = 1_500;
export const PCM_POST_TARGET_DISCARD_MS = 520;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SpotifyOutputMode = "pcm" | "encoded";

export class SpotifyStreamBridge {
  private source: NodeJS.ReadableStream | null = null;
  private outputMode: SpotifyOutputMode = "pcm";
  private pcmGate: PcmGate | null = null;
  private encodedGate: OggSyncGate | null = null;
  private attachedPlayer: AudioPlayer | null = null;
  private streamAttached = false;

  constructor(private readonly logger: Logger) {}

  setSource(source: NodeJS.ReadableStream | null, outputMode: SpotifyOutputMode): void {
    this.destroy();
    this.source = source;
    this.outputMode = outputMode;
  }

  getOutputMode(): SpotifyOutputMode {
    return this.outputMode;
  }

  getAttachedPlayer(): AudioPlayer | null {
    return this.attachedPlayer;
  }

  isStreamAttachedTo(player: AudioPlayer): boolean {
    return this.streamAttached && this.attachedPlayer === player;
  }

  clearAttachment(): void {
    this.attachedPlayer = null;
    this.streamAttached = false;
  }

  destroy(): void {
    this.destroyPcmGate();
    this.destroyEncodedGate();
    this.clearAttachment();
  }

  attachPlayer(
    player: AudioPlayer,
    options: {
      cleanup: () => void;
      onSourceClosed?: (event: ExternallyControlledSourceCloseEvent) => void | Promise<void>;
    },
  ): void {
    if (this.outputMode === "encoded") {
      this.destroyPcmGate();
      const gate = this.createFreshEncodedGate("spotify-encoded-start");
      this.logger.info({ gateStats: gate.getStats() }, "Spotify encoded gate waiting for next Ogg stream");
      player.playEncodedStream(gate, {
        inputFormat: "ogg",
        cleanup: options.cleanup,
        suppressTrackEnd: true,
        onSourceClosed: options.onSourceClosed,
      });
    } else {
      this.destroyEncodedGate();
      const gate = this.ensurePcmGate();
      player.playPcmStream(gate, {
        inputSampleRate: 44100,
        cleanup: options.cleanup,
        suppressTrackEnd: true,
        onSourceClosed: options.onSourceClosed,
      });
    }
    this.attachedPlayer = player;
    this.streamAttached = true;
  }

  prepareEncodedBoundary(player: AudioPlayer, activeTrackUri: string | null): void {
    const gateStats = this.encodedGate?.getStats() ?? null;
    player.stop({ skipCleanup: true });
    this.destroyEncodedGate();
    this.clearAttachment();
    this.logger.info(
      { gateStats, activeTrackUri },
      "Prepared encoded Ogg boundary for Spotify transition",
    );
  }

  beginEncodedGateDiscard(reason: string): boolean {
    if (!this.encodedGate) return false;
    this.encodedGate.beginDiscard(reason);
    this.logger.info({ reason, gateStats: this.encodedGate.getStats() }, "Spotify encoded gate discarding input");
    return true;
  }

  beginPcmGateDiscard(reason: string): boolean {
    if (!this.pcmGate) return false;
    this.pcmGate.beginDiscard(reason);
    this.logger.info({ reason, gateStats: this.pcmGate.getStats() }, "Spotify PCM gate discarding input");
    return true;
  }

  restartPcmPlayerForTransition(
    player: AudioPlayer,
    options: {
      cleanup: () => void;
      onSourceClosed?: (event: ExternallyControlledSourceCloseEvent) => void | Promise<void>;
    },
  ): void {
    if (!this.pcmGate) return;
    this.pcmGate.beginDiscard("spotify-ffmpeg-reattach");
    player.stop({ skipCleanup: true });
    this.clearAttachment();
    this.attachPlayer(player, options);
    this.logger.info({ gateStats: this.pcmGate.getStats() }, "Restarted FFmpeg for Spotify PCM transition");
  }

  async preparePcmBoundary(player: AudioPlayer, nextElapsedSeconds: number): Promise<void> {
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

  async releasePcmBoundary(player: AudioPlayer, nextElapsedSeconds: number): Promise<void> {
    await this.discardPcmFor(player, PCM_POST_TARGET_DISCARD_MS);
    this.pcmGate?.endDiscard({ resetAlignment: true });
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

  async waitForPcmGateInput(deadlineAt: number): Promise<boolean> {
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

  private async discardPcmFor(player: AudioPlayer, durationMs: number): Promise<void> {
    const deadline = Date.now() + durationMs;
    while (Date.now() < deadline) {
      player.flushBufferedAudio();
      await sleep(40);
    }
  }

  private createFreshEncodedGate(reason: string): OggSyncGate {
    this.destroyEncodedGate();
    if (!this.source) {
      throw new Error("librespot stdout is not available");
    }
    this.destroyPcmGate();
    const gate = new OggSyncGate();
    gate.on("error", (err) => {
      this.logger.warn({ err }, "Spotify encoded gate error");
    });
    gate.syncToNextLogicalStream(reason);
    this.source.pipe(gate);
    this.encodedGate = gate;
    this.logger.info({ reason, gateStats: gate.getStats() }, "Attached fresh Spotify encoded Ogg gate");
    return gate;
  }

  private ensurePcmGate(): PcmGate {
    if (this.pcmGate) return this.pcmGate;
    if (!this.source) {
      throw new Error("librespot stdout is not available");
    }
    this.destroyEncodedGate();
    const gate = new PcmGate();
    gate.on("error", (err) => {
      this.logger.warn({ err }, "Spotify PCM gate error");
    });
    this.source.pipe(gate);
    this.pcmGate = gate;
    this.logger.info({ gateStats: gate.getStats() }, "Attached Spotify PCM gate");
    return gate;
  }

  private destroyEncodedGate(): void {
    if (!this.encodedGate) return;
    try {
      this.source?.unpipe(this.encodedGate);
    } catch (err) {
      this.logger.debug({ err }, "Failed to unpipe Spotify encoded gate");
    }
    this.encodedGate.destroy();
    this.encodedGate = null;
  }

  private destroyPcmGate(): void {
    if (!this.pcmGate) return;
    try {
      this.source?.unpipe(this.pcmGate);
    } catch (err) {
      this.logger.debug({ err }, "Failed to unpipe Spotify PCM gate");
    }
    this.pcmGate.destroy();
    this.pcmGate = null;
  }
}
