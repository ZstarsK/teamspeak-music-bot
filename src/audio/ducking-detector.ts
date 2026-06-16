import { createOpusEncoder, type Encoder } from "./encoder.js";
import {
  DUCKING_THRESHOLD_DB_MAX,
  DUCKING_THRESHOLD_DB_MIN,
  type DuckingSettings,
} from "../data/config.js";
import type { Logger } from "../logger.js";
import type { TS3VoiceData } from "../ts-protocol/client.js";
import { CODEC_OPUS_MUSIC, CODEC_OPUS_VOICE } from "../ts-protocol/voice.js";

const SAMPLE_INTERVAL_MS = 60;
const REQUIRED_CONSECUTIVE_FRAMES = 3;
const LOUD_STREAK_TIMEOUT_MS = 350;
const MIN_DBFS = -120;

export interface DuckingDetectorOptions {
  logger: Logger;
  encoder?: Encoder;
  now?: () => number;
  sampleIntervalMs?: number;
  requiredConsecutiveFrames?: number;
  loudStreakTimeoutMs?: number;
}

interface ClientVoiceState {
  lastSampleAt: number;
  consecutiveLoudFrames: number;
  encoder: Encoder;
}

export type DuckingDetectionReason =
  | "throttled"
  | "unsupported-codec"
  | "decode-error"
  | "below-threshold"
  | "over-threshold"
  | "triggered";

export interface DuckingDetectionResult {
  clientId: number;
  codec: number;
  packetBytes: number;
  sampled: boolean;
  sampledAt: number | null;
  levelDb: number | null;
  thresholdDb: number;
  overThreshold: boolean;
  consecutiveLoudFrames: number;
  requiredConsecutiveFrames: number;
  triggered: boolean;
  decodeError: boolean;
  reason: DuckingDetectionReason;
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
  private loudStreakTimeoutMs: number;
  private clientStates = new Map<number, ClientVoiceState>();

  constructor(options: DuckingDetectorOptions) {
    this.sharedEncoder = options.encoder;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ?? SAMPLE_INTERVAL_MS;
    this.requiredConsecutiveFrames =
      options.requiredConsecutiveFrames ?? REQUIRED_CONSECUTIVE_FRAMES;
    this.loudStreakTimeoutMs = options.loudStreakTimeoutMs ?? LOUD_STREAK_TIMEOUT_MS;
  }

  /**
   * Returns true when a sampled packet is loud for enough consecutive frames
   */
  shouldTrigger(packet: TS3VoiceData, settings: DuckingSettings): boolean {
    return this.analyzePacket(packet, settings).triggered;
  }

  analyzePacket(packet: TS3VoiceData, settings: DuckingSettings): DuckingDetectionResult {
    const now = this.now();
    const thresholdDb = clampThresholdDb(settings.thresholdDb);
    if (packet.codec !== CODEC_OPUS_VOICE && packet.codec !== CODEC_OPUS_MUSIC) {
      return {
        clientId: packet.clientId,
        codec: packet.codec,
        packetBytes: packet.data.length,
        sampled: false,
        sampledAt: null,
        levelDb: null,
        thresholdDb,
        overThreshold: false,
        consecutiveLoudFrames: 0,
        requiredConsecutiveFrames: this.requiredConsecutiveFrames,
        triggered: false,
        decodeError: false,
        reason: "unsupported-codec",
      };
    }

    const state = this.getClientState(packet.clientId);
    const baseResult = {
      clientId: packet.clientId,
      codec: packet.codec,
      packetBytes: packet.data.length,
      sampledAt: null,
      levelDb: null,
      thresholdDb,
      overThreshold: false,
      consecutiveLoudFrames: state.consecutiveLoudFrames,
      requiredConsecutiveFrames: this.requiredConsecutiveFrames,
      triggered: false,
      decodeError: false,
    };

    if (now - state.lastSampleAt < this.sampleIntervalMs) {
      return {
        ...baseResult,
        sampled: false,
        reason: "throttled",
      };
    }
    if (now - state.lastSampleAt > this.loudStreakTimeoutMs) {
      state.consecutiveLoudFrames = 0;
    }
    state.lastSampleAt = now;

    let pcm: Buffer;
    try {
      pcm = state.encoder.decode(Buffer.from(packet.data));
    } catch (err) {
      this.logger.debug({ err, clientId: packet.clientId }, "Ignoring undecodable voice packet for ducking");
      state.consecutiveLoudFrames = 0;
      return {
        ...baseResult,
        sampled: true,
        sampledAt: now,
        consecutiveLoudFrames: state.consecutiveLoudFrames,
        decodeError: true,
        reason: "decode-error",
      };
    }

    const levelDb = calculatePcmRmsDb(pcm);
    if (levelDb >= thresholdDb) {
      state.consecutiveLoudFrames++;
      const triggered = state.consecutiveLoudFrames >= this.requiredConsecutiveFrames;
      return {
        ...baseResult,
        sampled: true,
        sampledAt: now,
        levelDb,
        overThreshold: true,
        consecutiveLoudFrames: state.consecutiveLoudFrames,
        triggered,
        reason: triggered ? "triggered" : "over-threshold",
      };
    }

    state.consecutiveLoudFrames = 0;
    return {
      ...baseResult,
      sampled: true,
      sampledAt: now,
      levelDb,
      consecutiveLoudFrames: state.consecutiveLoudFrames,
      reason: "below-threshold",
    };
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
