import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import { getConfiguredMaxVolume, type BotConfig } from "../../data/config.js";
import type { BotDatabase } from "../../data/database.js";
import type { MusicProvider } from "../../music/provider.js";
import type { Logger } from "../../logger.js";
import { parseCommand } from "../../bot/commands.js";
import { chooseInitialQueueIndex } from "../../bot/instance.js";

export function createPlayerRouter(
  botManager: BotManager,
  logger: Logger,
  database?: BotDatabase,
  neteaseProvider?: MusicProvider,
  qqProvider?: MusicProvider,
  bilibiliProvider?: MusicProvider,
  config?: BotConfig,
): Router {
  const router = Router();
  const maxVolume = getConfiguredMaxVolume(config);

  router.use("/:botId", (req, res, next) => {
    const bot = botManager.getBot(req.params.botId);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    (req as any).bot = bot;
    next();
  });

  /** Map API platform string to the corresponding command flag. */
  const platformFlag = (platform: unknown): string => {
    if (platform === "bilibili") return "-b";
    if (platform === "qq") return "-q";
    if (platform === "youtube") return "-y";
    return "";
  };

  router.post("/:botId/play", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      if (!query) {
        res.status(400).json({ error: "query is required" });
        return;
      }
      const cmd = parseCommand(`!play ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/add", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { query, platform } = req.body;
      const cmd = parseCommand(`!add ${platformFlag(platform)} ${query}`.trim(), "!");
      if (!cmd) {
        res.status(400).json({ error: "Invalid command" });
        return;
      }
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const simpleCommand = (cmdStr: string) => async (req: any, res: any) => {
    try {
      const bot = req.bot;
      const cmd = parseCommand(cmdStr, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  };

  router.post("/:botId/pause", simpleCommand("!pause"));
  router.post("/:botId/resume", simpleCommand("!resume"));
  router.post("/:botId/next", simpleCommand("!next"));
  router.post("/:botId/prev", simpleCommand("!prev"));
  router.post("/:botId/stop", simpleCommand("!stop"));
  router.post("/:botId/clear", simpleCommand("!clear"));

  router.post("/:botId/volume", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { volume } = req.body;
      // Reject bad input with a proper 4xx instead of letting cmdVol
      // return a "Usage:" string inside a 200 body — API clients can't
      // detect that failure mode, and the UI would silently swallow it.
      if (
        typeof volume !== "number" ||
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > maxVolume
      ) {
        res
          .status(400)
          .json({ error: `volume must be a number between 0 and ${maxVolume}` });
        return;
      }
      const cmd = parseCommand(`!vol ${Math.round(volume)}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  const VALID_MODES = new Set(["seq", "loop", "random", "rloop"]);

  const isValidSongId = (songId: unknown): songId is string =>
    typeof songId === "string" &&
    songId.trim().length > 0 &&
    songId !== "undefined" &&
    songId !== "null";

  const songFromRequest = (
    raw: any,
    songId: string,
    platform: MusicProvider["platform"]
  ) => {
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string") {
      return null;
    }
    return {
      id: songId,
      name: raw.name,
      artist: typeof raw.artist === "string" ? raw.artist : "",
      album: typeof raw.album === "string" ? raw.album : "",
      duration: typeof raw.duration === "number" && Number.isFinite(raw.duration) ? raw.duration : 0,
      coverUrl: typeof raw.coverUrl === "string" ? raw.coverUrl : "",
      platform,
      ...(typeof raw.mediaId === "string" && raw.mediaId ? { mediaId: raw.mediaId } : {}),
    };
  };

  router.post("/:botId/mode", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { mode } = req.body;
      if (typeof mode !== "string" || !VALID_MODES.has(mode)) {
        res
          .status(400)
          .json({ error: "mode must be one of: seq, loop, random, rloop" });
        return;
      }
      const cmd = parseCommand(`!mode ${mode}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Get current elapsed time (ground truth from server)
  router.get("/:botId/elapsed", (req, res) => {
    const bot = (req as any).bot;
    res.json({ elapsed: bot.getPlayer().getElapsed() });
  });

  // Seek to position
  router.post("/:botId/seek", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { position } = req.body; // seconds
      // typeof NaN === "number" and NaN < 0 is false, so a plain range
      // check lets NaN/Infinity through and later corrupts seekOffset.
      if (typeof position !== "number" || !Number.isFinite(position) || position < 0) {
        res
          .status(400)
          .json({ error: "position must be a finite non-negative number" });
        return;
      }
      bot.getPlayer().seek(position);
      res.json({ message: `Seeked to ${Math.floor(position)}s`, seekOffset: position });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/queue", (req, res) => {
    const bot = (req as any).bot;
    res.json({ queue: bot.getQueue(), status: bot.getStatus() });
  });

  router.delete("/:botId/queue/:index", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const cmd = parseCommand(`!remove ${req.params.index}`, "!")!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Jump to a specific index in the queue (without clearing it)
  router.post("/:botId/play-at", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { index } = req.body;
      if (typeof index !== "number" || index < 0) {
        res.status(400).json({ error: "index is required" });
        return;
      }
      const queue = bot.getQueueManager();
      // Validate the index BEFORE stopping current playback — otherwise an
      // invalid index silently kills the user's current song and leaves the
      // queue idle.
      if (index >= queue.size()) {
        res.status(400).json({ error: "Invalid queue index" });
        return;
      }
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();
      const song = queue.playAt(index);
      if (!song) {
        res.status(400).json({ error: "Invalid queue index" });
        return;
      }
      const ok = await bot.resolveAndPlay(song);
      if (!ok) {
        res.json({ message: `Cannot play: ${song.name}` });
        return;
      }
      res.json({ message: `Now playing: ${song.name} - ${song.artist}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:botId/playlist", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform } = req.body;
      const cmd = parseCommand(
        `!playlist ${platformFlag(platform)} ${playlistId}`.trim(),
        "!"
      )!;
      const response = await bot.executeCommand(cmd);
      res.json({ message: response });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a playlist by ID — stores metadata only, resolves URL for first song
  // Respects current play mode (random = pick random first song)
  router.post("/:botId/play-playlist", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { playlistId, platform, startIndex } = req.body;
      if (
        startIndex !== undefined &&
        (
          typeof startIndex !== "number" ||
          !Number.isInteger(startIndex) ||
          startIndex < 0
        )
      ) {
        res.status(400).json({ error: "startIndex must be a non-negative integer" });
        return;
      }
      // Use the bot's own provider lookup — it already knows about youtube,
      // which the router's constructor params did not.
      const provider = bot.getProviderFor(
        platform === "bilibili" || platform === "qq" || platform === "youtube"
          ? platform
          : "netease"
      );

      // Stop current playback
      bot.getPlayer().stop();
      bot.getPlayer().resetFailures();

      const songs = await provider.getPlaylistSongs(playlistId);
      if (songs.length === 0) {
        res.json({ message: "Playlist is empty" });
        return;
      }
      if (typeof startIndex === "number" && startIndex >= songs.length) {
        res.status(400).json({ error: "startIndex is out of range" });
        return;
      }

      const queue = bot.getQueueManager();
      queue.clear();
      for (const song of songs) {
        queue.add({ ...song, platform: provider.platform });
      }

      const initialIndex = chooseInitialQueueIndex({
        mode: queue.getMode(),
        queueSize: queue.size(),
        ...(typeof startIndex === "number" ? { startIndex } : {}),
      });
      const first = initialIndex === null ? null : queue.playAt(initialIndex);

      if (first) {
        await bot.resolveAndPlay(first);
      }

      res.json({ message: `Loaded ${songs.length} songs. Now playing: ${first?.name ?? "unknown"}` });
    } catch (err) {
      logger.error({ err }, "Play playlist failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Play a single song by ID — resolves URL on demand
  router.post("/:botId/play-by-id", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { songId, platform, song: rawSong } = req.body;
      if (!isValidSongId(songId)) {
        res.status(400).json({ error: "songId is required" });
        return;
      }
      const provider = bot.getProviderFor(
        platform === "bilibili" || platform === "qq" || platform === "youtube"
          ? platform
          : "netease"
      );

      const song = songFromRequest(rawSong, songId, provider.platform)
        ?? await provider.getSongDetail(songId);
      if (!song) {
        res.json({ message: "Song not found" });
        return;
      }

      const queue = bot.getQueueManager();
      queue.clear();
      queue.add({ ...song, platform: provider.platform });
      queue.play();

      bot.getPlayer().resetFailures();
      const ok = await bot.resolveAndPlay(queue.current()!);
      if (!ok) {
        res.json({ message: `Cannot play: ${song.name || song.id}` });
        return;
      }

      res.json({ message: `Now playing: ${song.name} - ${song.artist}` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Add a song to queue by ID — metadata only
  router.post("/:botId/add-by-id", async (req, res) => {
    try {
      const bot = (req as any).bot;
      const { songId, platform, song: rawSong } = req.body;
      if (!isValidSongId(songId)) {
        res.status(400).json({ error: "songId is required" });
        return;
      }
      const provider = bot.getProviderFor(
        platform === "bilibili" || platform === "qq" || platform === "youtube"
          ? platform
          : "netease"
      );

      const song = songFromRequest(rawSong, songId, provider.platform)
        ?? await provider.getSongDetail(songId);
      if (!song) {
        res.json({ message: "Song not found" });
        return;
      }

      const queue = bot.getQueueManager();
      queue.add({ ...song, platform: provider.platform });

      // If nothing is playing, start the first song
      if (bot.getPlayer().getState() === "idle") {
        const first = queue.play();
        if (first) await bot.resolveAndPlay(first);
      }

      res.json({ message: `Added: ${song.name} - ${song.artist} (position ${queue.size()})` });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Profile config endpoints ---

  router.get("/:botId/profile", (req, res) => {
    const bot = (req as any).bot;
    res.json(bot.getProfileManager().getConfig());
  });

  router.put("/:botId/profile", (req, res) => {
    try {
      const bot = (req as any).bot;
      const pm = bot.getProfileManager();
      pm.updateConfig(req.body);
      if (database) {
        database.saveProfileConfig(bot.id, pm.getConfig());
      }
      res.json(pm.getConfig());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/:botId/history", (req, res) => {
    if (!database) {
      res.json({ history: [] });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const records = database.getPlayHistory(req.params.botId, limit);
    const history = records.map((r) => ({
      id: r.songId,
      name: r.songName,
      artist: r.artist,
      album: r.album,
      duration: 0,
      coverUrl: r.coverUrl,
      platform: r.platform,
      playedAt: r.playedAt,
    }));
    res.json({ history });
  });

  return router;
}
