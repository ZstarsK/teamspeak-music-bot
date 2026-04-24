import type { PlayerState } from "../audio/player.js";

export const SPOTIFY_SOURCE_RECOVERY_MAX_ATTEMPTS = 2;
export const SPOTIFY_SOURCE_RECOVERY_DELAY_MS = 350;
export const SPOTIFY_HARD_RECOVERY_MAX_ATTEMPTS = 1;
export const SPOTIFY_SOURCE_FAILURE_RECOVERY_THRESHOLD_MS = 1_000;
export const SPOTIFY_END_LOCAL_GRACE_SECONDS = 0.35;
export const SPOTIFY_END_WAIT_POLL_MS = 120;
export const SPOTIFY_END_WAIT_MAX_MS = 30_000;
export const SPOTIFY_EARLY_END_IGNORE_THRESHOLD_MS = 10_000;
export const SPOTIFY_EARLY_END_REWIND_MS = 700;

export interface SpotifySourceCloseLike {
  code: number | null;
  gotData: boolean;
}

export type SpotifyEndOfTrackDecision =
  | { action: "complete"; remainingMs: number }
  | { action: "ignore"; remainingMs: number }
  | { action: "delay"; remainingMs: number };

export type SpotifySourceCloseDecision =
  | { action: "advance-near-end"; remainingMs: number }
  | { action: "soft-recover"; remainingMs: number; nextAttempt: number }
  | { action: "hard-recover"; remainingMs: number; nextAttempt: number }
  | { action: "advance-failed"; remainingMs: number };

export function getSpotifyLocalTrackEndRemainingMs(params: {
  durationSeconds: number;
  elapsedSeconds: number;
}): number {
  if (!Number.isFinite(params.durationSeconds) || params.durationSeconds <= 0) return 0;
  if (!Number.isFinite(params.elapsedSeconds) || params.elapsedSeconds < 0) return 0;
  return Math.max(0, (params.durationSeconds - SPOTIFY_END_LOCAL_GRACE_SECONDS - params.elapsedSeconds) * 1000);
}

export function decideSpotifyEndOfTrack(params: {
  durationSeconds: number;
  elapsedSeconds: number;
  playerState: PlayerState;
}): SpotifyEndOfTrackDecision {
  if (params.playerState === "idle") {
    return { action: "complete", remainingMs: 0 };
  }
  const remainingMs = getSpotifyLocalTrackEndRemainingMs(params);
  if (remainingMs <= 0) {
    return { action: "complete", remainingMs };
  }
  if (remainingMs > SPOTIFY_EARLY_END_IGNORE_THRESHOLD_MS) {
    return { action: "ignore", remainingMs };
  }
  return { action: "delay", remainingMs };
}

export function isGracefulSpotifySourceClose(event: SpotifySourceCloseLike): boolean {
  return event.code === 0 && event.gotData;
}

export function decideSpotifySourceClose(params: {
  remainingMs: number;
  gracefulSourceEnd: boolean;
  softAttempts: number;
  maxSoftAttempts?: number;
  hardAttempts: number;
  maxHardAttempts?: number;
}): SpotifySourceCloseDecision {
  const maxSoftAttempts = params.maxSoftAttempts ?? SPOTIFY_SOURCE_RECOVERY_MAX_ATTEMPTS;
  const maxHardAttempts = params.maxHardAttempts ?? SPOTIFY_HARD_RECOVERY_MAX_ATTEMPTS;
  const sourceRecoveryThreshold = params.gracefulSourceEnd
    ? SPOTIFY_EARLY_END_IGNORE_THRESHOLD_MS
    : SPOTIFY_SOURCE_FAILURE_RECOVERY_THRESHOLD_MS;

  if (params.remainingMs <= sourceRecoveryThreshold) {
    return { action: "advance-near-end", remainingMs: params.remainingMs };
  }
  if (params.softAttempts < maxSoftAttempts) {
    return { action: "soft-recover", remainingMs: params.remainingMs, nextAttempt: params.softAttempts + 1 };
  }
  if (params.hardAttempts < maxHardAttempts) {
    return { action: "hard-recover", remainingMs: params.remainingMs, nextAttempt: maxSoftAttempts + params.hardAttempts + 1 };
  }
  return { action: "advance-failed", remainingMs: params.remainingMs };
}
