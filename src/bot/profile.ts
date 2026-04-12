import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import axios from "axios";
import { TS3Client, escapeTS3 } from "../ts-protocol/client.js";
import type { ProfileConfig } from "../data/database.js";
import type { QueuedSong } from "../audio/queue.js";
import type { Logger } from "../logger.js";

const TS3_NICKNAME_MAX = 30;
/** TS3 avatar max size — server default is ~300 KB. Use 200 KB to be safe. */
const AVATAR_MAX_BYTES = 200 * 1024;
/** Timeout for file-transfer operations (upload / delete). */
const FILE_TRANSFER_TIMEOUT_MS = 6000;

/**
 * Manages the bot's TeamSpeak presence (avatar, description, nickname,
 * away status, channel description, now-playing messages).
 *
 * Every update is permission-safe: if a feature fails due to insufficient
 * server permissions, it silently disables itself until the next reconnect.
 */
export class BotProfileManager {
  private tsClient: TS3Client;
  private logger: Logger;
  private config: ProfileConfig;
  private defaultNickname: string;

  /** Per-feature permission-denied flags. Reset on reconnect. */
  private permDenied = {
    avatar: false,
    description: false,
    nickname: false,
    awayStatus: false,
    channelDesc: false,
    nowPlayingMsg: false,
  };

  /**
   * Monotonically increasing generation counter. Incremented on every
   * onSongChange / onConnect call. Long-running operations (avatar
   * download/upload) check this before committing their result — if
   * the generation changed, a newer update has superseded them.
   */
  private generation = 0;

  constructor(
    tsClient: TS3Client,
    logger: Logger,
    config: ProfileConfig,
    defaultNickname: string,
  ) {
    this.tsClient = tsClient;
    this.logger = logger.child({ component: "profile" });
    this.config = { ...config };
    this.defaultNickname = defaultNickname;
  }

  // --- Public API ---

  /**
   * Called when a new song starts playing (song != null) or playback
   * stops (song == null).
   *
   * Commands are serialized to avoid overwhelming the TS3 command queue.
   * Nickname + away status are merged into a single `clientupdate` call.
   *
   * A generation counter guards against stale updates: if a newer
   * onSongChange fires while the avatar is still downloading, the old
   * update is discarded.
   */
  async onSongChange(song: QueuedSong | null): Promise<void> {
    const gen = ++this.generation;

    // 1. Avatar first — file transfer uses its own response tracker and
    //    must run before sendCommandNoWait calls whose orphaned responses
    //    could confuse the command matcher.
    await this.updateAvatar(song?.coverUrl ?? null, gen);
    if (this.generation !== gen) return; // superseded

    // 2. Combined clientupdate (nickname + away in one fire-and-forget)
    await this.updateClientProperties(song);
    // 3. Description (clientedit on TS3, httpQuery on TS6)
    await this.updateDescription(song);
    // 4. Channel description (fire-and-forget channeledit)
    await this.updateChannelDescription(song);
    // 5. Now-playing chat message
    if (song) await this.sendNowPlayingMessage(song);
  }

  /** Reset permission-denied flags and bump generation on new connection. */
  onConnect(): void {
    this.generation++;
    this.permDenied = {
      avatar: false,
      description: false,
      nickname: false,
      awayStatus: false,
      channelDesc: false,
      nowPlayingMsg: false,
    };
  }

  getConfig(): ProfileConfig {
    return { ...this.config };
  }

  updateConfig(partial: Partial<ProfileConfig>): void {
    Object.assign(this.config, partial);
  }

  // --- Internal update methods ---

  private async updateAvatar(coverUrl: string | null, gen: number): Promise<void> {
    if (!this.config.avatarEnabled || this.permDenied.avatar) return;
    try {
      if (!coverUrl) {
        await this.clearAvatar(gen);
        return;
      }
      // Request a thumbnail from the CDN to stay within TS3's avatar size limit.
      const thumbUrl = this.thumbnailUrl(coverUrl);
      const imageBuffer = await this.downloadImage(thumbUrl);

      // Check generation after the slow download — bail if superseded.
      if (this.generation !== gen) return;

      if (!imageBuffer || imageBuffer.length === 0) return;
      if (imageBuffer.length > AVATAR_MAX_BYTES) {
        this.logger.warn(
          { bytes: imageBuffer.length, max: AVATAR_MAX_BYTES },
          "Cover image still too large after resize — skipping avatar update",
        );
        return;
      }

      // Wrap the file-transfer sequence with a timeout — the TS3
      // full-client file transfer can silently hang.
      await this.withTimeout(this.doAvatarUpload(imageBuffer), FILE_TRANSFER_TIMEOUT_MS);
      this.logger.info("Avatar updated");
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }

  private async doAvatarUpload(imageBuffer: Buffer): Promise<void> {
    const host = this.tsClient.getHost();
    const info = await this.tsClient.fileTransferInitUpload(
      0n, "/avatar", "", BigInt(imageBuffer.length), true,
    );
    await this.tsClient.uploadFileData(host, info, Readable.from(imageBuffer));
    const md5 = createHash("md5").update(imageBuffer).digest("hex");
    await this.tsClient.sendCommandNoWait(`clientupdate client_flag_avatar=${escapeTS3(md5)}`);
  }

  private async clearAvatar(gen: number): Promise<void> {
    try {
      await this.withTimeout(
        this.tsClient.fileTransferDeleteFile(0n, ["/avatar"]),
        FILE_TRANSFER_TIMEOUT_MS,
      );
    } catch {
      // File may not exist or transfer timed out — that's fine
    }
    // Bail if a newer song started while we were deleting
    if (this.generation !== gen) return;
    try {
      await this.tsClient.sendCommandNoWait("clientupdate client_flag_avatar=");
    } catch (err) {
      this.handleFeatureError("avatar", err);
    }
  }

  private async updateDescription(song: QueuedSong | null): Promise<void> {
    if (!this.config.descriptionEnabled || this.permDenied.description) return;
    try {
      const text = song
        ? `${song.name} - ${song.artist} [${song.album}]`
        : "";
      const httpQuery = this.tsClient.getHttpQuery();
      if (httpQuery) {
        await httpQuery.clientUpdate({ client_description: text });
      } else {
        // clientupdate rejects client_description (error 1538).
        // Use clientedit on our own clid instead — this is what
        // TS3AudioBot does via TSLib's ChangeDescription().
        const clid = this.tsClient.getClientId();
        if (clid <= 0) return;
        // Use a 5s timeout — if clientedit hangs, don't block the
        // remaining profile updates (channeledit, now-playing msg).
        await this.withTimeout(
          this.tsClient.execCommand(
            `clientedit clid=${clid} client_description=${escapeTS3(text)}`,
          ),
          5000,
        );
      }
      this.logger.info("Description updated");
    } catch (err) {
      this.handleFeatureError("description", err);
    }
  }

  /**
   * Build and send a single `clientupdate` command that sets nickname
   * and away status together, avoiding multiple round-trips that can
   * cause command-queue timeouts on the TS3 protocol.
   */
  private async updateClientProperties(song: QueuedSong | null): Promise<void> {
    const parts: string[] = [];

    // --- Nickname ---
    if (this.config.nicknameEnabled && !this.permDenied.nickname) {
      if (!song) {
        parts.push(`client_nickname=${escapeTS3(this.defaultNickname)}`);
      } else {
        const nickname = this.buildNickname(song);
        if (nickname) {
          parts.push(`client_nickname=${escapeTS3(nickname)}`);
        }
      }
    }

    // --- Away status ---
    if (this.config.awayStatusEnabled && !this.permDenied.awayStatus) {
      if (song) {
        parts.push("client_away=0");
      } else {
        parts.push(`client_away=1 client_away_message=${escapeTS3("\u7B49\u5F85\u64AD\u653E")}`);
      }
    }

    if (parts.length === 0) return;

    try {
      const httpQuery = this.tsClient.getHttpQuery();
      if (httpQuery) {
        // TS6: build a properties object
        const props: Record<string, string | number> = {};
        for (const part of parts) {
          const eq = part.indexOf("=");
          if (eq > 0) props[part.slice(0, eq)] = part.slice(eq + 1);
        }
        await httpQuery.clientUpdate(props);
      } else {
        // Use sendCommandNoWait: the TS3 full-client protocol often
        // doesn't return a timely error response for clientupdate,
        // causing execCommand to time out after 10s.
        await this.tsClient.sendCommandNoWait(`clientupdate ${parts.join(" ")}`);
      }
      this.logger.info("Client properties updated (nickname + away)");
    } catch (err) {
      // Flag both features on permission error
      this.handleFeatureError("nickname", err);
      this.handleFeatureError("awayStatus", err);
    }
  }

  /**
   * Build a nickname string that fits within TS3_NICKNAME_MAX.
   * Uses UTF-8 byte length for the limit since TS3 counts bytes,
   * not characters.
   */
  private buildNickname(song: QueuedSong): string | null {
    const songInfo = `${song.name} - ${song.artist}`;
    const prefix = "\u266A "; // ♪
    const sep = " - ";
    const suffix = `${sep}${this.defaultNickname}`;

    const overheadBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
    if (overheadBytes >= TS3_NICKNAME_MAX) {
      // Default nickname alone is too long with decoration — skip
      return null;
    }

    const maxSongBytes = TS3_NICKNAME_MAX - overheadBytes;
    const truncated = this.truncateUtf8(songInfo, maxSongBytes);
    return `${prefix}${truncated}${suffix}`;
  }

  /**
   * Truncate a string so its UTF-8 byte length does not exceed maxBytes.
   * Appends an ellipsis if truncation occurred, taking its byte cost
   * into account. Never splits a multi-byte character.
   */
  private truncateUtf8(str: string, maxBytes: number): string {
    if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
    const ellipsis = "\u2026"; // …
    const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8"); // 3
    const target = maxBytes - ellipsisBytes;
    if (target <= 0) return ellipsis;
    // Walk characters, accumulating byte length
    let byteLen = 0;
    let end = 0;
    for (const ch of str) {
      const chBytes = Buffer.byteLength(ch, "utf8");
      if (byteLen + chBytes > target) break;
      byteLen += chBytes;
      end += ch.length; // ch.length handles surrogate pairs
    }
    return str.slice(0, end) + ellipsis;
  }

  private async updateChannelDescription(song: QueuedSong | null): Promise<void> {
    if (!this.config.channelDescEnabled || this.permDenied.channelDesc) return;
    try {
      const channelId = this.tsClient.getChannelId();
      if (channelId === 0n) return; // unknown channel

      if (!song) {
        await this.tsClient.sendCommandNoWait(
          `channeledit cid=${channelId} channel_description=`,
        );
        return;
      }

      const lines = [
        `\u266A \u6B63\u5728\u64AD\u653E: ${song.name} - ${song.artist}`, // ♪ 正在播放:
        `\u4E13\u8F91: ${song.album}`, // 专辑:
        `\u5E73\u53F0: ${song.platform}`, // 平台:
      ];
      const desc = lines.join("\\n");
      await this.tsClient.sendCommandNoWait(
        `channeledit cid=${channelId} channel_description=${escapeTS3(desc)}`,
      );
    } catch (err) {
      this.handleFeatureError("channelDesc", err);
    }
  }

  private async sendNowPlayingMessage(song: QueuedSong): Promise<void> {
    if (!this.config.nowPlayingMsgEnabled || this.permDenied.nowPlayingMsg) return;
    try {
      const text = `\u266A \u6B63\u5728\u64AD\u653E: ${song.name} - ${song.artist} [${song.album}]`;
      await this.tsClient.sendTextMessage(text);
    } catch (err) {
      this.handleFeatureError("nowPlayingMsg", err);
    }
  }

  // --- Helpers ---

  /**
   * Append CDN resize parameters to get a thumbnail suitable for TS3 avatars.
   * NetEase and QQ Music CDNs support URL-based image resizing.
   * BiliBili and YouTube covers fall through to the size-check guard.
   */
  private thumbnailUrl(url: string): string {
    if (url.includes("music.126.net") || url.includes("netease")) {
      return url.includes("?") ? url : `${url}?param=200y200`;
    }
    if (url.includes("qqmusic") || url.includes("qq.com")) {
      return url.replace(/\/\d+$/, "/200");
    }
    if (url.includes("bilivideo") || url.includes("hdslb")) {
      // BiliBili CDN supports @<w>w_<h>h suffix
      return url.includes("@") ? url : `${url}@200w_200h`;
    }
    return url;
  }

  private async downloadImage(url: string): Promise<Buffer | null> {
    try {
      const resp = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 8000,
        maxContentLength: 2 * 1024 * 1024, // 2 MB cap
      });
      return Buffer.from(resp.data);
    } catch (err) {
      this.logger.warn({ err, url }, "Failed to download cover image");
      return null;
    }
  }

  /** Race a promise against a timeout. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  private handleFeatureError(
    feature: keyof typeof this.permDenied,
    err: unknown,
  ): void {
    const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    // Disable the feature for this session on unrecoverable errors:
    // - permission / insufficient → server denies the action
    // - invalid parameter → command not supported by this protocol
    if (
      msg.includes("permission") ||
      msg.includes("insufficient") ||
      msg.includes("invalid parameter")
    ) {
      this.permDenied[feature] = true;
      this.logger.info(
        { feature, reason: msg },
        "Feature disabled for this session (will retry after reconnect)",
      );
    } else {
      this.logger.warn({ feature, err }, "Profile update failed");
    }
  }
}
