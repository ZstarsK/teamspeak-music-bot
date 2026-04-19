import Database from "better-sqlite3";
import { getDefaultDuckingSettings } from "./config.js";

export interface PlayHistoryEntry {
  botId: string;
  songId: string;
  songName: string;
  artist: string;
  album: string;
  platform: "netease" | "qq" | "bilibili" | "youtube" | "spotify";
  coverUrl: string;
}

export interface PlayHistoryRecord extends PlayHistoryEntry {
  id: number;
  playedAt: string;
}

export interface BotInstance {
  id: string;
  name: string;
  serverAddress: string;
  serverPort: number;
  nickname: string;
  defaultChannel: string;
  channelPassword: string;
  autoStart: boolean;
  /** "ts3" | "ts6" | "" (empty = auto-detect) */
  serverProtocol: string;
  /** API key for TS6 HTTP Query */
  ts6ApiKey: string;
  /** Password to join the TS server (server password) */
  serverPassword: string;
  duckingEnabled: boolean;
  duckingVolumePercent: number;
  duckingRecoveryMs: number;
  identity?: string;
}

export interface ProfileConfig {
  avatarEnabled: boolean;
  descriptionEnabled: boolean;
  nicknameEnabled: boolean;
  awayStatusEnabled: boolean;
  channelDescEnabled: boolean;
  nowPlayingMsgEnabled: boolean;
}

export const DEFAULT_PROFILE_CONFIG: ProfileConfig = {
  avatarEnabled: true,
  descriptionEnabled: true,
  nicknameEnabled: true,
  awayStatusEnabled: true,
  channelDescEnabled: true,
  nowPlayingMsgEnabled: true,
};

export interface BotDatabase {
  db: Database.Database;
  addPlayHistory(entry: PlayHistoryEntry): void;
  getPlayHistory(botId: string, limit: number): PlayHistoryRecord[];
  saveBotInstance(instance: BotInstance): void;
  getBotInstances(): BotInstance[];
  deleteBotInstance(id: string): boolean;
  getProfileConfig(botId: string): ProfileConfig;
  saveProfileConfig(botId: string, config: ProfileConfig): void;
  close(): void;
}

function migrateSchema(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(bot_instances)").all() as Array<{ name: string }>;
  const names = columns.map((c) => c.name);
  const defaultDucking = getDefaultDuckingSettings();
  if (!names.includes("identity")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN identity TEXT");
  }
  if (!names.includes("serverProtocol")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN serverProtocol TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes("ts6ApiKey")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN ts6ApiKey TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes("serverPassword")) {
    db.exec("ALTER TABLE bot_instances ADD COLUMN serverPassword TEXT NOT NULL DEFAULT ''");
  }
  if (!names.includes("duckingEnabled")) {
    db.exec(`ALTER TABLE bot_instances ADD COLUMN duckingEnabled INTEGER NOT NULL DEFAULT ${defaultDucking.enabled ? 1 : 0}`);
  }
  if (!names.includes("duckingVolumePercent")) {
    db.exec(`ALTER TABLE bot_instances ADD COLUMN duckingVolumePercent INTEGER NOT NULL DEFAULT ${defaultDucking.volumePercent}`);
  }
  if (!names.includes("duckingRecoveryMs")) {
    db.exec(`ALTER TABLE bot_instances ADD COLUMN duckingRecoveryMs INTEGER NOT NULL DEFAULT ${defaultDucking.recoveryMs}`);
  }
  // Profile feature flags
  const profileCols = [
    "profile_avatar_enabled",
    "profile_description_enabled",
    "profile_nickname_enabled",
    "profile_away_enabled",
    "profile_channel_desc_enabled",
    "profile_now_playing_enabled",
  ];
  for (const col of profileCols) {
    if (!names.includes(col)) {
      db.exec(`ALTER TABLE bot_instances ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 1`);
    }
  }
}

function initTables(db: Database.Database): void {
  const defaultDucking = getDefaultDuckingSettings();
  db.exec(`
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      botId TEXT NOT NULL,
      songId TEXT NOT NULL,
      songName TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT NOT NULL,
      platform TEXT NOT NULL,
      coverUrl TEXT NOT NULL,
      playedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bot_instances (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      serverAddress TEXT NOT NULL,
      serverPort INTEGER NOT NULL,
      nickname TEXT NOT NULL,
      defaultChannel TEXT NOT NULL,
      channelPassword TEXT NOT NULL,
      autoStart INTEGER NOT NULL DEFAULT 0,
      serverProtocol TEXT NOT NULL DEFAULT '',
      ts6ApiKey TEXT NOT NULL DEFAULT '',
      serverPassword TEXT NOT NULL DEFAULT '',
      duckingEnabled INTEGER NOT NULL DEFAULT ${defaultDucking.enabled ? 1 : 0},
      duckingVolumePercent INTEGER NOT NULL DEFAULT ${defaultDucking.volumePercent},
      duckingRecoveryMs INTEGER NOT NULL DEFAULT ${defaultDucking.recoveryMs},
      identity TEXT
    );
  `);
}

export function createDatabase(dbPath: string): BotDatabase {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  initTables(db);
  migrateSchema(db);

  const insertHistory = db.prepare(`
    INSERT INTO play_history (botId, songId, songName, artist, album, platform, coverUrl)
    VALUES (@botId, @songId, @songName, @artist, @album, @platform, @coverUrl)
  `);

  const selectHistory = db.prepare(`
    SELECT * FROM play_history WHERE botId = ? ORDER BY id DESC LIMIT ?
  `);

  const upsertInstance = db.prepare(`
    INSERT INTO bot_instances (id, name, serverAddress, serverPort, nickname, defaultChannel, channelPassword, autoStart, serverProtocol, ts6ApiKey, serverPassword, duckingEnabled, duckingVolumePercent, duckingRecoveryMs, identity)
    VALUES (@id, @name, @serverAddress, @serverPort, @nickname, @defaultChannel, @channelPassword, @autoStart, @serverProtocol, @ts6ApiKey, @serverPassword, @duckingEnabled, @duckingVolumePercent, @duckingRecoveryMs, @identity)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      serverAddress = excluded.serverAddress,
      serverPort = excluded.serverPort,
      nickname = excluded.nickname,
      defaultChannel = excluded.defaultChannel,
      channelPassword = excluded.channelPassword,
      autoStart = excluded.autoStart,
      serverProtocol = excluded.serverProtocol,
      ts6ApiKey = excluded.ts6ApiKey,
      serverPassword = excluded.serverPassword,
      duckingEnabled = excluded.duckingEnabled,
      duckingVolumePercent = excluded.duckingVolumePercent,
      duckingRecoveryMs = excluded.duckingRecoveryMs,
      identity = excluded.identity
  `);

  const selectInstances = db.prepare(`SELECT * FROM bot_instances`);

  const deleteInstance = db.prepare(`DELETE FROM bot_instances WHERE id = ?`);

  const selectProfileConfig = db.prepare(`
    SELECT profile_avatar_enabled, profile_description_enabled,
           profile_nickname_enabled, profile_away_enabled,
           profile_channel_desc_enabled, profile_now_playing_enabled
    FROM bot_instances WHERE id = ?
  `);

  const updateProfileConfig = db.prepare(`
    UPDATE bot_instances SET
      profile_avatar_enabled = @avatar,
      profile_description_enabled = @description,
      profile_nickname_enabled = @nickname,
      profile_away_enabled = @away,
      profile_channel_desc_enabled = @channelDesc,
      profile_now_playing_enabled = @nowPlaying
    WHERE id = @id
  `);

  return {
    db,

    addPlayHistory(record) {
      insertHistory.run(record);
    },

    getPlayHistory(botId, limit) {
      return selectHistory.all(botId, limit) as PlayHistoryRecord[];
    },

    saveBotInstance(instance) {
      upsertInstance.run({
        ...instance,
        autoStart: instance.autoStart ? 1 : 0,
        duckingEnabled: instance.duckingEnabled ? 1 : 0,
        identity: instance.identity ?? null,
      });
    },

    getBotInstances() {
      const rows = selectInstances.all() as Array<Record<string, unknown>>;
      const defaultDucking = getDefaultDuckingSettings();
      return rows.map((r) => ({
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        serverAddress: String(r.serverAddress ?? ""),
        serverPort: Number(r.serverPort ?? 9987),
        nickname: String(r.nickname ?? ""),
        defaultChannel: String(r.defaultChannel ?? ""),
        channelPassword: String(r.channelPassword ?? ""),
        autoStart: r.autoStart === 1,
        serverProtocol: String(r.serverProtocol ?? ""),
        ts6ApiKey: String(r.ts6ApiKey ?? ""),
        serverPassword: String(r.serverPassword ?? ""),
        duckingEnabled: r.duckingEnabled === 1,
        duckingVolumePercent: Number(r.duckingVolumePercent ?? defaultDucking.volumePercent),
        duckingRecoveryMs: Number(r.duckingRecoveryMs ?? defaultDucking.recoveryMs),
        identity: typeof r.identity === "string" ? r.identity : undefined,
      }));
    },

    deleteBotInstance(id) {
      const result = deleteInstance.run(id);
      return result.changes > 0;
    },

    getProfileConfig(botId) {
      const row = selectProfileConfig.get(botId) as Record<string, number> | undefined;
      if (!row) return { ...DEFAULT_PROFILE_CONFIG };
      return {
        avatarEnabled: row.profile_avatar_enabled === 1,
        descriptionEnabled: row.profile_description_enabled === 1,
        nicknameEnabled: row.profile_nickname_enabled === 1,
        awayStatusEnabled: row.profile_away_enabled === 1,
        channelDescEnabled: row.profile_channel_desc_enabled === 1,
        nowPlayingMsgEnabled: row.profile_now_playing_enabled === 1,
      };
    },

    saveProfileConfig(botId, config) {
      updateProfileConfig.run({
        id: botId,
        avatar: config.avatarEnabled ? 1 : 0,
        description: config.descriptionEnabled ? 1 : 0,
        nickname: config.nicknameEnabled ? 1 : 0,
        away: config.awayStatusEnabled ? 1 : 0,
        channelDesc: config.channelDescEnabled ? 1 : 0,
        nowPlaying: config.nowPlayingMsgEnabled ? 1 : 0,
      });
    },

    close() {
      db.close();
    },
  };
}
