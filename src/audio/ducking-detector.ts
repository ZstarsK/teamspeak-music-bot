import { createOpusEncoder, type Encoder } from "./encoder.js";
import {
  DUCKING_THRESHOLD_DB_MAX,
  DUCKING_THRESHOLD_DB_MIN,
  type DuckingSettings,
} from "../data/config.js";
import type { Logger } from "../logger.js";
import type { TS3VoiceData } from "../ts-protocol/client.js";

const SAMPLE_INTERVAL_MS = 60;
const REQUIRED_CONSECUTIVE_FRAMES = 2;
const MIN_DBFS = -120;

export interface DuckingDetectorOptions {
  logger: Logger;
  encoder?: Encoder;
  now?: () => number;
  sampleIntervalMs?: number;
  requiredConsecutiveFrames?: number;
}

interface ClientVoiceState {
  lastSampleAt: number;
  consecutiveLoudFrames: number;
  encoder: Encoder;
}

/**
 * Detects whether incoming voice packets are loud enough to trigger ducking
 */
export class DuckingDetector {
  private sharedEncoder?: Encoder;
  private logger: Logger;
  private now: () => number;
  private sampleIntervalMs: number;
  private requiredConsecutiveFrames: number;
  private clientStates = new Map<number, ClientVoiceState>();

  constructor(options: DuckingDetectorOptions) {
    this.sharedEncoder = options.encoder;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.requiredConsecutiveFrames =
      options.requiredConsecutiveFrames ?? REQUIRED_CONSECUTIVE_FRAMES;
  }

  /**
   * Returns true when a sampled packet is loud for enough consecutive frames
   */
  shouldTrigger(packet: TS3VoiceData, settings: DuckingSettings): boolean {
    const state = this.getClientState(packet.clientId);
    const now = this.now();
    if (now - state.lastSampleAt < this.sampleIntervalMs) {
      return false;
    }
    state.lastSampleAt = now;

    let pcm: Buffer;
    try {
      pcm = state.encoder.decode(Buffer.from(packet.data));
    } catch (err) {
      this.logger.debug({ err, clientId: packet.clientId }, "Ignoring undecodable voice packet for ducking");
      return false;
    }

    const levelDb = calculatePcmRmsDb(pcm);
    if (levelDb >= clampThresholdDb(settings.thresholdDb)) {
      state.consecutiveLoudFrames++;
      return state.consecutiveLoudFrames >= this.requiredConsecutiveFrames;
    }

    state.consecutiveLoudFrames = 0;
    return false;
  }

  /**
   * Clears per-client voice history after disconnect or explicit reset
   */
  reset(): void {
    this.clientStates.clear();
  }

  private getClientState(clientId: number): ClientVoiceState {
    let state = this.clientStates.get(clientId);
    if (!state) {
      state = {
        lastSampleAt: -Infinity,
        consecutiveLoudFrames: 0,
        encoder: this.sharedEncoder ?? createOpusEncoder(),
      };
      this.clientStates.set(clientId, state);
    }
    return state;
  }
}

export function clampThresholdDb(value: number): number {
  if (!Number.isFinite(value)) return -42;
  return Math.max(
    DUCKING_THRESHOLD_DB_MIN,
    Math.min(DUCKING_THRESHOLD_DB_MAX, Math.round(value)),
  );
}

export function calculatePcmRmsDb(pcm: Buffer): number {
  if (pcm.length < 2) return MIN_DBFS;
  let squareSum = 0;
  let samples = 0;

    // Calculate RMS over all 16-bit little-endian PCM samples in the frame
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const normalized = pcm.readInt16LE(i) / 32768;
    squareSum += normalized * normalized;
    samples++;
  }

  if (samples === 0 || squareSum === 0) return MIN_DBFS;
  return 20 * Math.log10(Math.sqrt(squareSum / samples));
}
