import { EventEmitter } from "node:events";
import {
  TS3Client,
  type TS3ClientOptions,
  type TS3TextMessage,
  type TS3VoiceData,
} from "../ts-protocol/client.js";
import { AudioPlayer } from "../audio/player.js";
import { PlayQueue, PlayMode, type QueuedSong } from "../audio/queue.js";
import type { MusicProvider } from "../music/provider.js";
import type { SpotifyProvider } from "../music/spotify.js";
import { SpotifyPlaybackEngine } from "../music/spotify-playback.js";
import {
  parseCommand,
  isAdminCommand,
  type ParsedCommand,
} from "./commands.js";
import type { Logger } from "../logger.js";
import type { BotDatabase, ProfileConfig } from "../data/database.js";
import {
  DUCKING_RECOVERY_MS_MAX,
  DUCKING_RECOVERY_MS_MIN,
  DUCKING_VOLUME_PERCENT_MAX,
  DUCKING_VOLUME_PERCENT_MIN,
  getConfiguredMaxVolume,
  getDefaultDuckingSettings,
  type BotConfig,
  type DuckingSettings,
} from "../data/config.js";
import { BotProfileManager } from "./profile.js";

const DUCKING_RELEASE_MS = 450;
const DUCKING_POLL_INTERVAL_MS = 100;
const TRACK_END_GRACE_SECONDS = 1.5;
const TRACK_END_STALL_MS = 2000;

export function shouldForceTrackAdvance(params: {
  playerState: "idle" | "playing" | "paused";
  duration: number;
  elapsed: number;
  msSinceLastFrame: number;
}): boolean {
  if (params.playerState !== "playing") return false;
  if (!Number.isFinite(params.duration) || params.duration <= 0) return false;
  if (!Number.isFinite(params.elapsed) || params.elapsed < 0) return false;
  if (!Number.isFinite(params.msSinceLastFrame) || params.msSinceLastFrame < TRACK_END_STALL_MS) {
    return false;
  }
  return params.elapsed >= Math.max(0, params.duration - TRACK_END_GRACE_SECONDS);
}

export function chooseInitialQueueIndex(params: {
  mode: PlayMode;
  queueSize: number;
  startIndex?: number;
}): number | null {
  const { mode, queueSize, startIndex } = params;
  if (!Number.isInteger(queueSize) || queueSize <= 0) return null;
  if (startIndex !== undefined) {
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= queueSize) {
      return null;
    }
    return startIndex;
  }
  if (mode === PlayMode.Random || mode === PlayMode.RandomLoop) {
    return Math.floor(Math.random() * queueSize);
  }
  return 0;
}

export interface BotInstanceOptions {
  id: string;
  name: string;
  tsOptions: TS3ClientOptions;
  neteaseProvider: MusicProvider;
  qqProvider: MusicProvider;
  bilibiliProvider: MusicProvider;
  youtubeProvider: MusicProvider;
  spotifyProvider?: SpotifyProvider;
  spotifyCacheDir?: string;
  database: BotDatabase;
  config: BotConfig;
  logger: Logger;
  duckingSettings?: DuckingSettings;
}

export interface BotStatus {
  id: string;
  name: string;
  connected: boolean;
  playing: boolean;
  paused: boolean;
  currentSong: QueuedSong | null;
  queueSize: number;
  volume: number;
  playMode: PlayMode;
  elapsed: number; // ground truth elapsed seconds from frame count
}

export class BotInstance extends EventEmitter {
  readonly id: string;
  name: string;

  private tsClient: TS3Client;
  private player: AudioPlayer;
  private queue: PlayQueue;
  private neteaseProvider: MusicProvider;
  private qqProvider: MusicProvider;
  private bilibiliProvider: MusicProvider;
  private youtubeProvider: MusicProvider;
  private spotifyProvider: SpotifyProvider | null = null;
  private spotifyPlayback: SpotifyPlaybackEngine | null = null;
  private database: BotDatabase;
  private config: BotConfig;
  private logger: Logger;
  private connected = false;
  private disconnectEmitted = false;
  private voteSkipUsers = new Set<string>();
  private isAdvancing = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private channelUserCount = 0;
  private profileManager: BotProfileManager;
  private duckingTimer: ReturnType<typeof setInterval> | null = null;
  private lastVoicePacketAt = 0;
  private forcedAdvanceToken: string | null = null;
  private duckingSettings: DuckingSettings;

  constructor(options: BotInstanceOptions) {
    super();
    this.id = options.id;
    this.name = options.name;
    this.neteaseProvider = options.neteaseProvider;
    this.qqProvider = options.qqProvider;
    this.bilibiliProvider = options.bilibiliProvider;
    this.youtubeProvider = options.youtubeProvider;
    this.spotifyProvider = options.spotifyProvider ?? null;
    this.database = options.database;
    this.config = options.config;
    this.logger = options.logger.child({ botId: this.id });
    this.duckingSettings = { ...(options.duckingSettings ?? getDefaultDuckingSettings()) };

    this.tsClient = new TS3Client(options.tsOptions, this.logger);
    this.player = new AudioPlayer(this.logger, {
      maxVolume: getConfiguredMaxVolume(this.config),
    });
    if (this.spotifyProvider && options.spotifyCacheDir) {
      this.spotifyPlayback = new SpotifyPlaybackEngine(
        this.spotifyProvider,
        this.config,
        this.logger,
        this.id,
        options.spotifyCacheDir,
      );
    }
    this.syncDuckingConfig();
    this.queue = new PlayQueue();

    const profileConfig = this.database.getProfileConfig(this.id);
    this.profileManager = new BotProfileManager(
      this.tsClient,
      this.logger,
      profileConfig,
      options.tsOptions.nickname,
    );

    this.setupPlayerEvents();
    this.setupTsEvents();
  }

  private setupPlayerEvents(): void {
    this.player.on("frame", (opusFrame: Buffer) => {
      this.tsClient.sendVoiceData(opusFrame);
    });

    this.player.on("trackEnd", () => {
      this.logger.debug("Track ended, advancing queue");
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after trackEnd");
      });
    });

    this.player.on("error", (err: Error) => {
      this.logger.error({ err }, "Player error");
      this.playNext().catch((err2) => {
        this.logger.error({ err: err2 }, "playNext failed after player error");
      });
    });
  }

  private setupTsEvents(): void {
    this.tsClient.on("textMessage", (msg: TS3TextMessage) => {
      this.handleTextMessage(msg).catch((err) => {
        this.logger.error({ err }, "Unhandled error in text message handler");
      });
    });

    this.tsClient.on("disconnected", () => {
      // Always reset local state — covers the case where connect() never
      // completed (hanging handshake → 60s library idle timeout) and
      // this.connected was never flipped to true. Previously this handler
      // short-circuited on !this.connected, leaving player stuck as "playing".
      this.connected = false;
      this.stopDuckingMonitor();
      this.lastVoicePacketAt = 0;
      this.player.setDuckingActive(false);
      this.player.stop();
      this.spotifyPlayback?.shutdown();
      // Only emit externally once per lifecycle so clients don't see a
      // duplicate "disconnected" after an explicit disconnect() call.
      if (this.disconnectEmitted) return;
      this.disconnectEmitted = true;
      this.emit("disconnected");
    });

    this.tsClient.on("connected", () => {
      this._startIdlePoller();
      this.startDuckingMonitor();
      this.lastVoicePacketAt = 0;
      this.player.setDuckingActive(false);
    });

    this.tsClient.on("voiceData", (_packet: TS3VoiceData) => {
      this.lastVoicePacketAt = Date.now();
    });
  }

  async connect(): Promise<void> {
    this.disconnectEmitted = false;
    await this.tsClient.connect();
    // Race guard: if disconnect() was called while the handshake was
    // awaiting, don't flip connected back to true — that would leave the
    // bot in an inconsistent state (externally "connected" but the tsClient
    // has already been torn down).
    if (this.disconnectEmitted) {
      throw new Error("Connect aborted by concurrent disconnect");
    }
    this.connected = true;
    this.profileManager.onConnect();
    this.emit("connected");
  }

  disconnect(): void {
    this._cancelIdleTimer();
    this.stopDuckingMonitor();
    this.lastVoicePacketAt = 0;
    this.player.setDuckingActive(false);
    this.player.stop();
    this.spotifyPlayback?.shutdown();
    this.connected = false;
    if (!this.disconnectEmitted) {
      this.disconnectEmitted = true;
      this.emit("disconnected");
    }
    this.tsClient.disconnect();
  }

  /** 外部更新 idleTimeoutMinutes（由 API 保存时调用） */
  updateIdleTimeout(minutes: number): void {
    this.config.idleTimeoutMinutes = minutes;
    if (minutes === 0) this._cancelIdleTimer();
  }

  private _startIdlePoller(): void {
    // 每 30 秒检查一次频道人数
    const poll = async () => {
      if (!this.connected) return;
      try {
        const clients = await this.tsClient.getClientsInChannel();
        const userCount = clients.length - 1; // 排除 bot 自身
        if (userCount <= 0) {
          this._scheduleIdleCheck();
        } else {
          this._cancelIdleTimer();
        }
      } catch { /* ignore */ }
      setTimeout(poll, 30_000);
    };
    setTimeout(poll, 30_000);
  }

  private _scheduleIdleCheck(): void {
    if (this.idleTimer !== null) return; // 已经在倒计时，不重复创建
    const minutes = this.config.idleTimeoutMinutes ?? 0;
    if (!this.connected || minutes <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (!this.connected) return;
      this.logger.info({ idleMinutes: minutes }, "Channel empty, disconnecting due to idle timeout");
      this.disconnect();
    }, minutes * 60 * 1000);
  }

  private _cancelIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private startDuckingMonitor(): void {
    if (this.duckingTimer) return;
    this.duckingTimer = setInterval(() => {
      if (!this.connected) return;
      this.syncDuckingConfig();
      const active =
        this.duckingSettings.enabled &&
        Date.now() - this.lastVoicePacketAt < DUCKING_RELEASE_MS;
      this.player.setDuckingActive(active);
      this.checkPlaybackStall();
    }, DUCKING_POLL_INTERVAL_MS);
  }

  private stopDuckingMonitor(): void {
    if (!this.duckingTimer) return;
    clearInterval(this.duckingTimer);
    this.duckingTimer = null;
  }

  syncDuckingConfig(): void {
    this.player.setDuckingConfig(this.duckingSettings);
  }

  getDuckingSettings(): DuckingSettings {
    return { ...this.duckingSettings };
  }

  updateDuckingSettings(partial: Partial<DuckingSettings>, persist = true): DuckingSettings {
    this.duckingSettings = {
      ...this.duckingSettings,
      ...partial,
    };
    this.syncDuckingConfig();
    if (persist) {
      const saved = this.database.getBotInstances().find((instance) => instance.id === this.id);
      if (saved) {
        this.database.saveBotInstance({
          ...saved,
          duckingEnabled: this.duckingSettings.enabled,
          duckingVolumePercent: this.duckingSettings.volumePercent,
          duckingRecoveryMs: this.duckingSettings.recoveryMs,
        });
      }
    }
    return this.getDuckingSettings();
  }

  private checkPlaybackStall(): void {
    const current = this.queue.current();
    if (!current) {
      this.forcedAdvanceToken = null;
      return;
    }

    const token = `${current.platform}:${current.id}:${this.queue.getCurrentIndex()}`;
    const lastFrameAt = this.player.getLastFrameAt();
    const msSinceLastFrame = lastFrameAt > 0 ? Date.now() - lastFrameAt : Number.POSITIVE_INFINITY;
    const shouldAdvance = shouldForceTrackAdvance({
      playerState: this.player.getState(),
      duration: current.duration,
      elapsed: this.player.getElapsed(),
      msSinceLastFrame,
    });

    if (!shouldAdvance) {
      if (this.forcedAdvanceToken === token && this.player.getState() !== "playing") {
        this.forcedAdvanceToken = null;
      } else if (this.forcedAdvanceToken !== token) {
        this.forcedAdvanceToken = null;
      }
      return;
    }

    if (this.forcedAdvanceToken === token || this.isAdvancing) return;
    this.forcedAdvanceToken = token;
    this.logger.warn(
      {
        songId: current.id,
        name: current.name,
        elapsed: this.player.getElapsed(),
        duration: current.duration,
        msSinceLastFrame,
      },
      "Playback stalled near track end, forcing advance",
    );
    this.playNext().catch((err) => {
      this.logger.error({ err, songId: current.id }, "Forced playNext failed after playback stall");
      this.forcedAdvanceToken = null;
    });
  }

  private async handleTextMessage(msg: TS3TextMessage): Promise<void> {
    const parsed = parseCommand(
      msg.message,
      this.config.commandPrefix,
      this.config.commandAliases
    );
    if (!parsed) return;

    if (isAdminCommand(parsed.name)) {
      // TODO: Check if invoker is in adminGroups
    }

    this.logger.info(
      { command: parsed.name, args: parsed.args, invoker: msg.invokerName },
      "Command received"
    );

    try {
      const response = await this.executeCommand(parsed, msg);
      if (response) {
        await this.tsClient.sendTextMessage(response);
      }
    } catch (err) {
      this.logger.error({ err, command: parsed.name }, "Command execution error");
      try {
        await this.tsClient.sendTextMessage(
          `Error: ${(err as Error).message}`
        );
      } catch (sendErr) {
        this.logger.error({ err: sendErr }, "Failed to send error message to chat");
      }
    }
  }

  async executeCommand(
    cmd: ParsedCommand,
    msg?: TS3TextMessage
  ): Promise<string | null> {
    // Reject commands that would push audio when the bot isn't connected:
    // otherwise ffmpeg spawns and voice goes to a half-initialized or
    // torn-down TS client, leaving player.state="playing" on a disconnected
    // bot. Config-only commands (vol, mode, clear, stop, queue, now) are
    // still allowed so the UI stays usable while the bot is offline.
    const AUDIO_COMMANDS = new Set([
      "play",
      "add",
      "next",
      "skip",
      "prev",
      "playlist",
      "album",
      "fm",
    ]);
    if (!this.connected && AUDIO_COMMANDS.has(cmd.name)) {
      throw new Error("Bot is not connected to TeamSpeak");
    }
    switch (cmd.name) {
      case "play":
        return this.cmdPlay(cmd);
      case "add":
        return this.cmdAdd(cmd);
      case "pause":
        return this.cmdPause();
      case "resume":
        return this.cmdResume();
      case "stop":
        return this.cmdStop();
      case "next":
      case "skip":
        return this.cmdNext();
      case "prev":
        return this.cmdPrev();
      case "vol":
        return this.cmdVol(cmd);
      case "now":
        return this.cmdNow();
      case "queue":
      case "list":
        return this.cmdQueue();
      case "clear":
        return this.cmdClear();
      case "remove":
        return this.cmdRemove(cmd);
      case "mode":
        return this.cmdMode(cmd);
      case "duck":
        return this.cmdDuck(cmd);
      case "playlist":
        return this.cmdPlaylist(cmd);
      case "album":
        return this.cmdAlbum(cmd);
      case "fm":
        return this.cmdFm();
      case "vote":
        return this.cmdVote(msg);
      case "lyrics":
        return this.cmdLyrics();
      case "move":
        return this.cmdMove(cmd);
      case "follow":
        return this.cmdFollow(msg);
      case "help":
        return this.cmdHelp();
      default:
        return `Unknown command: ${cmd.name}. Type ${this.config.commandPrefix}help for help.`;
    }
  }

  getProviderFor(platform: "netease" | "qq" | "bilibili" | "youtube" | "spotify"): MusicProvider {
    if (platform === "spotify" && this.spotifyProvider) return this.spotifyProvider;
    if (platform === "bilibili") return this.bilibiliProvider;
    if (platform === "youtube") return this.youtubeProvider;
    return platform === "qq" ? this.qqProvider : this.neteaseProvider;
  }

  private getProvider(flags: Set<string>): MusicProvider {
    if (flags.has("s") && this.spotifyProvider) return this.spotifyProvider;
    if (flags.has("b")) return this.bilibiliProvider;
    if (flags.has("q")) return this.qqProvider;
    if (flags.has("y")) return this.youtubeProvider;
    return this.spotifyProvider?.hasAccount() ? this.spotifyProvider : this.neteaseProvider;
  }

  /** Resolve URL for a song and start playing it. Skips to next if URL fails. */
  async resolveAndPlay(song: QueuedSong): Promise<boolean> {
    if (!this.connected) {
      this.logger.warn({ songId: song.id, name: song.name }, "resolveAndPlay called on disconnected bot — skipping");
      return false;
    }
    // Clear any accumulated skip votes — every fresh track starts with a
    // clean slate, regardless of which code path loaded it (cmdPlay,
    // cmdPlaylist, cmdAlbum, cmdFm, trackEnd auto-advance, etc.).
    this.voteSkipUsers.clear();
    const provider = this.getProviderFor(song.platform);
    try {
      if (song.platform === "spotify") {
        if (!this.spotifyPlayback || !this.spotifyProvider) {
          throw new Error("Spotify playback is not configured");
        }
        await this.spotifyPlayback.play(song, this.player, () => {
          this.logger.debug("Spotify track ended, advancing queue");
          return this.playNext();
        });
        this.database.addPlayHistory({
          botId: this.id,
          songId: song.id,
          songName: song.name,
          artist: song.artist,
          album: song.album,
          platform: song.platform,
          coverUrl: song.coverUrl,
        });
        this.profileManager.onSongChange(song).catch((err) => {
          this.logger.warn({ err }, "Profile update failed after Spotify song change");
        });
        this.emit("stateChange");
        return true;
      }
      const url = await provider.getSongUrl(song.id, undefined, song);
      if (!url) {
        this.logger.warn({ songId: song.id, name: song.name }, "No URL available, skipping");
        return false;
      }
      // Re-check connection state AFTER the network round-trip — the URL
      // resolve can take multiple seconds and the user may have called stop
      // during that window. Without this, we'd spawn ffmpeg on a
      // disconnected bot and land back in the same "connected=false but
      // playing=true" inconsistency that Bug C was about.
      if (!this.connected) {
        this.logger.warn(
          { songId: song.id, name: song.name },
          "bot disconnected during URL resolve — aborting playback",
        );
        return false;
      }
      song.url = url;
      this.player.play(url);
      this.database.addPlayHistory({
        botId: this.id,
        songId: song.id,
        songName: song.name,
        artist: song.artist,
        album: song.album,
        platform: song.platform,
        coverUrl: song.coverUrl,
      });
      // Update bot presence (fire-and-forget — never blocks playback)
      this.profileManager.onSongChange(song).catch((err) => {
        this.logger.warn({ err }, "Profile update failed after song change");
      });
      this.emit("stateChange");
      return true;
    } catch (err) {
      this.logger.error({ err, songId: song.id }, "Failed to resolve URL");
      return false;
    }
  }

  private async cmdPlay(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !play <song name or URL>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 1);
    if (result.songs.length === 0)
      return `No results found for: ${cmd.args}`;

    const song = result.songs[0];
    this.queue.clear();
    this.queue.add({ ...song, platform: provider.platform });
    this.queue.play();

    // Reset failure counter on user-initiated play
    this.player.resetFailures();
    const ok = await this.resolveAndPlay(this.queue.current()!);
    if (!ok) return `Cannot play: ${song.name}`;
    return `Now playing: ${song.name} - ${song.artist}`;
  }

  private async cmdAdd(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !add <song name>";
    const provider = this.getProvider(cmd.flags);
    const result = await provider.search(cmd.args, 1);
    if (result.songs.length === 0)
      return `No results found for: ${cmd.args}`;

    const song = result.songs[0];
    const wasIdle = this.player.getState() === "idle";
    this.queue.add({ ...song, platform: provider.platform });

    // If nothing was playing, start this newly-added song immediately.
    // Matches /api/player/:id/add-by-id behavior so both add paths feel
    // the same to the user (add to idle bot → plays now).
    if (wasIdle) {
      this.queue.playAt(this.queue.size() - 1);
      this.player.resetFailures();
      await this.resolveAndPlay(this.queue.current()!);
      this.emit("stateChange");
      return `Now playing: ${song.name} - ${song.artist}`;
    }

    this.emit("stateChange");
    return `Added to queue: ${song.name} - ${song.artist} (position ${this.queue.size()})`;
  }

  private cmdPause(): string {
    this.player.pause();
    if (this.queue.current()?.platform === "spotify") {
      this.spotifyPlayback?.pause().catch((err) => {
        this.logger.warn({ err }, "Failed to pause Spotify playback");
      });
    }
    this.emit("stateChange");
    return "Paused";
  }

  private cmdResume(): string {
    this.player.resume();
    if (this.queue.current()?.platform === "spotify") {
      this.spotifyPlayback?.resume().catch((err) => {
        this.logger.warn({ err }, "Failed to resume Spotify playback");
      });
    }
    this.emit("stateChange");
    return "Resumed";
  }

  private cmdStop(): string {
    this.player.stop();
    this.queue.clear();
    this.profileManager.onSongChange(null).catch((err) => {
      this.logger.warn({ err }, "Profile restore failed on stop");
    });
    this.emit("stateChange");
    return "Stopped and queue cleared";
  }

  private async cmdNext(): Promise<string> {
    await this.playNext();
    const current = this.queue.current();
    if (current)
      return `Now playing: ${current.name} - ${current.artist}`;
    return "Queue is empty";
  }

  private async cmdPrev(): Promise<string> {
    const prev = this.queue.prev();
    if (prev) {
      const ok = await this.resolveAndPlay(prev);
      if (!ok) return "Cannot play previous song";
      return `Now playing: ${prev.name} - ${prev.artist}`;
    }
    return "No previous song";
  }

  private cmdVol(cmd: ParsedCommand): string {
    const maxVolume = getConfiguredMaxVolume(this.config);
    const vol = parseInt(cmd.args, 10);
    if (isNaN(vol) || vol < 0 || vol > maxVolume) return `Usage: !vol <0-${maxVolume}>`;
    this.player.setVolume(vol);
    this.emit("stateChange");
    return `Volume set to ${vol}%`;
  }

  private cmdNow(): string {
    const song = this.queue.current();
    if (!song) return "Nothing is playing";
    return `Now playing: ${song.name} - ${song.artist} [${song.album}] (${song.platform})`;
  }

  private cmdQueue(): string {
    const songs = this.queue.list();
    if (songs.length === 0) return "Queue is empty";
    const currentIdx = this.queue.getCurrentIndex();
    const lines = songs.map((s, i) => {
      const marker = i === currentIdx ? "▶ " : "  ";
      return `${marker}${i + 1}. ${s.name} - ${s.artist}`;
    });
    return `Queue (${songs.length} songs, mode: ${this.queue.getMode()}):\n${lines.join("\n")}`;
  }

  private cmdClear(): string {
    this.player.stop();
    this.queue.clear();
    this.profileManager.onSongChange(null).catch((err) => {
      this.logger.warn({ err }, "Profile restore failed on clear");
    });
    this.emit("stateChange");
    return "Queue cleared";
  }

  private cmdRemove(cmd: ParsedCommand): string {
    const index = parseInt(cmd.args, 10) - 1;
    if (isNaN(index) || index < 0) return "Usage: !remove <number>";
    const removed = this.queue.remove(index);
    if (!removed) return "Invalid position";
    this.emit("stateChange");
    return `Removed: ${removed.name}`;
  }

  private cmdMode(cmd: ParsedCommand): string {
    const modeMap: Record<string, PlayMode> = {
      seq: PlayMode.Sequential,
      loop: PlayMode.Loop,
      random: PlayMode.Random,
      rloop: PlayMode.RandomLoop,
    };
    const mode = modeMap[cmd.args];
    if (mode === undefined) return "Usage: !mode <seq|loop|random|rloop>";
    this.queue.setMode(mode);
    this.emit("stateChange");
    return `Play mode set to: ${cmd.args}`;
  }

  private formatDuckingSettings(settings: DuckingSettings = this.duckingSettings): string {
    return `Ducking: ${settings.enabled ? "on" : "off"}, level ${settings.volumePercent}%, recovery ${settings.recoveryMs}ms`;
  }

  private cmdDuck(cmd: ParsedCommand): string {
    const [actionRaw, valueRaw] = cmd.rawArgs;
    if (!actionRaw) {
      return this.formatDuckingSettings();
    }

    const action = actionRaw.toLowerCase();
    if (action === "on" || action === "enable") {
      this.updateDuckingSettings({ enabled: true });
    } else if (action === "off" || action === "disable") {
      this.updateDuckingSettings({ enabled: false });
    } else if (action === "percent" || action === "level" || action === "volume") {
      const value = Number.parseInt(valueRaw ?? "", 10);
      if (
        !Number.isFinite(value) ||
        value < DUCKING_VOLUME_PERCENT_MIN ||
        value > DUCKING_VOLUME_PERCENT_MAX
      ) {
        return `Usage: !duck percent <${DUCKING_VOLUME_PERCENT_MIN}-${DUCKING_VOLUME_PERCENT_MAX}>`;
      }
      this.updateDuckingSettings({ volumePercent: value });
    } else if (action === "release" || action === "recovery") {
      const value = Number.parseInt(valueRaw ?? "", 10);
      if (
        !Number.isFinite(value) ||
        value < DUCKING_RECOVERY_MS_MIN ||
        value > DUCKING_RECOVERY_MS_MAX
      ) {
        return `Usage: !duck release <${DUCKING_RECOVERY_MS_MIN}-${DUCKING_RECOVERY_MS_MAX}>`;
      }
      this.updateDuckingSettings({ recoveryMs: value });
    } else if (action === "status") {
      return this.formatDuckingSettings();
    } else {
      return [
        "Usage:",
        "!duck",
        "!duck <on|off>",
        `!duck percent <${DUCKING_VOLUME_PERCENT_MIN}-${DUCKING_VOLUME_PERCENT_MAX}>`,
        `!duck release <${DUCKING_RECOVERY_MS_MIN}-${DUCKING_RECOVERY_MS_MAX}>`,
      ].join("\n");
    }

    return this.formatDuckingSettings();
  }

  private async cmdPlaylist(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !playlist <playlist ID or URL>";
    const provider = this.getProvider(cmd.flags);
    const id = this.extractId(cmd.args);
    const songs = await provider.getPlaylistSongs(id);
    if (songs.length === 0) return "Playlist is empty or not found";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    const startIndex = chooseInitialQueueIndex({
      mode: this.queue.getMode(),
      queueSize: this.queue.size(),
    });
    const first = startIndex === null ? null : this.queue.playAt(startIndex);
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdAlbum(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !album <album ID>";
    const provider = this.getProvider(cmd.flags);
    const songs = await provider.getAlbumSongs(cmd.args);
    if (songs.length === 0) return "Album is empty or not found";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: provider.platform });
    }
    const startIndex = chooseInitialQueueIndex({
      mode: this.queue.getMode(),
      queueSize: this.queue.size(),
    });
    const first = startIndex === null ? null : this.queue.playAt(startIndex);
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}`;
  }

  private async cmdFm(): Promise<string> {
    if (!this.neteaseProvider.getPersonalFm) {
      return "Personal FM is only available for NetEase Cloud Music";
    }
    const songs = await this.neteaseProvider.getPersonalFm();
    if (songs.length === 0)
      return "No FM songs available (need to login first)";

    this.queue.clear();
    for (const song of songs) {
      this.queue.add({ ...song, platform: "netease" });
    }
    const startIndex = chooseInitialQueueIndex({
      mode: this.queue.getMode(),
      queueSize: this.queue.size(),
    });
    const first = startIndex === null ? null : this.queue.playAt(startIndex);
    if (first) await this.resolveAndPlay(first);
    this.emit("stateChange");
    return `Personal FM started: ${first?.name ?? "unknown"} - ${first?.artist ?? ""}`;
  }

  private async cmdVote(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Vote can only be used in TeamSpeak";
    this.voteSkipUsers.add(msg.invokerUid);
    const clients = await this.tsClient.getClientsInChannel();
    const totalUsers = clients.length - 1; // exclude the bot itself
    // At least 1 vote is always required — otherwise a single voter in an
    // otherwise empty channel (or a transient clients.length=1 race) could
    // unanimously "win" with needed=0.
    const needed = Math.max(1, Math.ceil(totalUsers / 2));
    const votes = this.voteSkipUsers.size;

    if (votes >= needed) {
      this.voteSkipUsers.clear();
      this.playNext().catch((err) => {
        this.logger.error({ err }, "playNext failed after vote skip");
      });
      return `Vote passed (${votes}/${needed}). Skipping to next song.`;
    }
    return `Vote to skip: ${votes}/${needed} (need ${needed - votes} more)`;
  }

  private async cmdLyrics(): Promise<string> {
    const song = this.queue.current();
    if (!song) return "Nothing is playing";
    const provider = this.getProviderFor(song.platform);
    const lyrics = await provider.getLyrics(song.id);
    if (lyrics.length === 0) return "No lyrics available";
    const lines = lyrics.slice(0, 10).map((l) => l.text);
    return `Lyrics for ${song.name}:\n${lines.join("\n")}`;
  }

  private async cmdMove(cmd: ParsedCommand): Promise<string> {
    if (!cmd.args) return "Usage: !move <channel name or ID>";
    await this.tsClient.joinChannel(cmd.args);
    return `Moved to channel: ${cmd.args}`;
  }

  private async cmdFollow(msg?: TS3TextMessage): Promise<string> {
    if (!msg) return "Follow can only be used in TeamSpeak";
    return "Following you to your channel";
  }

  private cmdHelp(): string {
    const p = this.config.commandPrefix;
    const maxVolume = getConfiguredMaxVolume(this.config);
    return [
      "TSMusicBot Commands:",
      `${p}play <song>  — Search and play`,
      `${p}play -q <song> — Search from QQ Music`,
      `${p}play -b <song> — Search from BiliBili`,
      `${p}play -y <song> — Search from YouTube (yt-dlp)`,
      `${p}play -s <song> — Search from Spotify`,
      `${p}add <song>   — Add to queue`,
      `${p}pause/resume — Pause/resume`,
      `${p}next/prev    — Next/previous`,
      `${p}stop         — Stop and clear queue`,
      `${p}vol <0-${maxVolume}>  — Set volume`,
      `${p}duck [on|off|percent|release] — Ducking settings`,
      `${p}queue        — Show queue`,
      `${p}mode <seq|loop|random|rloop> — Play mode`,
      `${p}playlist <id> — Load playlist`,
      `${p}album <id>   — Load album`,
      `${p}fm           — Personal FM (NetEase)`,
      `${p}vote         — Vote to skip`,
      `${p}lyrics       — Show lyrics`,
      `${p}now          — Current song info`,
      `${p}help         — This help message`,
    ].join("\n");
  }

  private async playNext(): Promise<void> {
    if (this.isAdvancing || !this.connected) return;
    this.isAdvancing = true;
    try {
      this.forcedAdvanceToken = null;
      this.voteSkipUsers.clear();
      const next = this.queue.next();
      if (next) {
        let started = await this.resolveAndPlay(next);
        if (!started) {
          // Skip to next if URL resolve fails (up to 3 retries)
          for (let i = 0; i < 3 && this.connected; i++) {
            const retry = this.queue.next();
            if (!retry) break;
            if (await this.resolveAndPlay(retry)) {
              started = true;
              break;
            }
          }
        }
        if (!started) {
          this.player.stop();
          this.profileManager.onSongChange(null).catch(() => {});
        }
      } else {
        this.player.stop();
        this.profileManager.onSongChange(null).catch(() => {});
      }
      this.emit("stateChange");
    } finally {
      this.isAdvancing = false;
    }
  }

  private extractId(input: string): string {
    const match = input.match(/[?&]id=(\d+)/);
    if (match) return match[1];
    const pathMatch = input.match(/\/(\d+)/);
    if (pathMatch) return pathMatch[1];
    return input;
  }

  getStatus(): BotStatus {
    return {
      id: this.id,
      name: this.name,
      connected: this.connected,
      playing: this.player.getState() === "playing",
      paused: this.player.getState() === "paused",
      currentSong: this.queue.current(),
      queueSize: this.queue.size(),
      volume: this.player.getVolume(),
      playMode: this.queue.getMode(),
      elapsed: this.player.getElapsed(),
    };
  }

  getQueue(): QueuedSong[] {
    return this.queue.list();
  }

  getPlayer(): AudioPlayer {
    return this.player;
  }

  async seek(seconds: number): Promise<void> {
    const current = this.queue.current();
    if (current?.platform === "spotify") {
      await this.spotifyPlayback?.seek(seconds);
      this.player.markSeek(seconds);
      this.emit("stateChange");
      return;
    }
    this.player.seek(seconds);
    this.emit("stateChange");
  }

  getQueueManager(): PlayQueue {
    return this.queue;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getProfileManager(): BotProfileManager {
    return this.profileManager;
  }

  getIdentityExport(): string | undefined {
    return this.tsClient.getIdentityExport();
  }
}
