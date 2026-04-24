import type { Song } from "./provider.js";

export type SpotifyPlaybackState =
  | "idle"
  | "starting"
  | "playing"
  | "switching"
  | "seeking"
  | "recovering"
  | "ending"
  | "failed";

export interface SpotifyPlaybackCommand {
  id: number;
  trackUri: string;
  trackId: string;
}

export interface SpotifyActiveTrack {
  trackUri: string;
  trackId: string;
  durationSeconds: number;
  song?: Song;
}

export class SpotifyPlaybackSession {
  private commandId = 0;
  private state: SpotifyPlaybackState = "idle";
  private active: SpotifyActiveTrack | null = null;
  private recoveryTrackUri: string | null = null;
  private softRecoveryAttempts = 0;
  private hardRecoveryAttempts = 0;

  beginPlay(track: SpotifyActiveTrack): SpotifyPlaybackCommand {
    this.commandId += 1;
    this.state = "starting";
    this.setActiveTrack(track);
    return this.currentCommand();
  }

  beginRecovery(track: SpotifyActiveTrack): SpotifyPlaybackCommand {
    this.commandId += 1;
    this.state = "recovering";
    this.setActiveTrack(track);
    return this.currentCommand();
  }

  setActiveTrack(track: SpotifyActiveTrack): void {
    this.active = { ...track };
    this.resetRecoveryIfTrackChanged(track.trackUri);
  }

  currentCommand(): SpotifyPlaybackCommand {
    return {
      id: this.commandId,
      trackUri: this.active?.trackUri ?? "",
      trackId: this.active?.trackId ?? "",
    };
  }

  isCurrent(command: SpotifyPlaybackCommand | number): boolean {
    const id = typeof command === "number" ? command : command.id;
    return id === this.commandId;
  }

  isCurrentTrack(command: SpotifyPlaybackCommand | number, trackUri: string, trackId: string): boolean {
    return this.isCurrent(command)
      && this.active?.trackUri === trackUri
      && this.active?.trackId === trackId;
  }

  setState(state: SpotifyPlaybackState): void {
    this.state = state;
  }

  getState(): SpotifyPlaybackState {
    return this.state;
  }

  getActive(): SpotifyActiveTrack | null {
    return this.active ? { ...this.active } : null;
  }

  clearActive(): void {
    this.active = null;
    this.state = "idle";
    this.recoveryTrackUri = null;
    this.softRecoveryAttempts = 0;
    this.hardRecoveryAttempts = 0;
  }

  getSoftRecoveryAttempts(): number {
    return this.softRecoveryAttempts;
  }

  getHardRecoveryAttempts(): number {
    return this.hardRecoveryAttempts;
  }

  restoreRecoveryCounters(trackUri: string, softAttempts: number, hardAttempts: number): void {
    this.recoveryTrackUri = trackUri;
    this.softRecoveryAttempts = Math.max(0, softAttempts);
    this.hardRecoveryAttempts = Math.max(0, hardAttempts);
  }

  reserveSoftRecovery(): number {
    this.softRecoveryAttempts += 1;
    return this.softRecoveryAttempts;
  }

  reserveHardRecovery(maxSoftAttempts: number, maxHardAttempts: number): number | null {
    if (this.hardRecoveryAttempts >= maxHardAttempts) {
      return null;
    }
    this.hardRecoveryAttempts += 1;
    return maxSoftAttempts + this.hardRecoveryAttempts;
  }

  resetRecoveryIfTrackChanged(trackUri: string): void {
    if (this.recoveryTrackUri === trackUri) return;
    this.recoveryTrackUri = trackUri;
    this.softRecoveryAttempts = 0;
    this.hardRecoveryAttempts = 0;
  }
}
