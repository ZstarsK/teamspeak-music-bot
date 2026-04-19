import { Router } from "express";
import type { BotManager } from "../../bot/manager.js";
import {
  DUCKING_RECOVERY_MS_MAX,
  DUCKING_RECOVERY_MS_MIN,
  DUCKING_VOLUME_PERCENT_MAX,
  DUCKING_VOLUME_PERCENT_MIN,
  type BotConfig,
} from "../../data/config.js";
import { saveConfig } from "../../data/config.js";
import type { Logger } from "../../logger.js";

export function createBotRouter(
  botManager: BotManager,
  config: BotConfig,
  configPath: string,
  logger: Logger
): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    const bots = botManager.getAllBots().map((b) => b.getStatus());
    res.json({ bots });
  });

  // GET /api/bot/settings — 读取全局 bot 行为设置
  router.get("/settings", (_req, res) => {
    res.json({
      idleTimeoutMinutes: config.idleTimeoutMinutes ?? 0,
    });
  });

  // POST /api/bot/settings — 保存全局 bot 行为设置
  router.post("/settings", (req, res) => {
    const updates: Partial<BotConfig> = {};

    if ("idleTimeoutMinutes" in req.body) {
      const { idleTimeoutMinutes } = req.body;
      if (typeof idleTimeoutMinutes !== "number" || idleTimeoutMinutes < 0) {
        res.status(400).json({ error: "idleTimeoutMinutes must be a non-negative number" });
        return;
      }
      updates.idleTimeoutMinutes = idleTimeoutMinutes;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No supported settings provided" });
      return;
    }

    Object.assign(config, updates);
    saveConfig(configPath, config);
    for (const bot of botManager.getAllBots()) {
      bot.updateIdleTimeout(config.idleTimeoutMinutes);
    }
    res.json({
      ok: true,
      settings: {
        idleTimeoutMinutes: config.idleTimeoutMinutes,
      },
    });
  });

  router.get("/:id", (req, res) => {
    const bot = botManager.getBot(req.params.id);
    if (!bot) {
      res.status(404).json({ error: "Bot not found" });
      return;
    }
    res.json(bot.getStatus());
  });

  // Get saved config for a bot
  router.get("/:id/config", (req, res) => {
    const saved = botManager.getBotConfig(req.params.id);
    if (!saved) {
      res.status(404).json({ error: "Bot config not found" });
      return;
    }
    res.json(saved);
  });

  router.post("/", async (req, res) => {
    try {
      const {
        name,
        serverAddress,
        serverPort,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
        autoStart,
      } = req.body;
      if (!name || !serverAddress || !nickname) {
        res
          .status(400)
          .json({ error: "name, serverAddress, and nickname are required" });
        return;
      }
      const bot = await botManager.createBot({
        name,
        serverAddress,
        serverPort: serverPort ?? 9987,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
        autoStart: autoStart ?? false,
      });
      res.status(201).json(bot.getStatus());
    } catch (err) {
      logger.error({ err }, "Failed to create bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Update bot config (must be stopped first to apply connection changes)
  router.put("/:id", async (req, res) => {
    try {
      const bot = botManager.getBot(req.params.id);
      if (!bot) {
        res.status(404).json({ error: "Bot not found" });
        return;
      }
      const {
        name,
        serverAddress,
        serverPort,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
        duckingEnabled,
        duckingVolumePercent,
        duckingRecoveryMs,
      } = req.body;

      if ("duckingEnabled" in req.body && typeof duckingEnabled !== "boolean") {
        res.status(400).json({ error: "duckingEnabled must be a boolean" });
        return;
      }
      if (
        "duckingVolumePercent" in req.body &&
        (
          typeof duckingVolumePercent !== "number" ||
          !Number.isFinite(duckingVolumePercent) ||
          duckingVolumePercent < DUCKING_VOLUME_PERCENT_MIN ||
          duckingVolumePercent > DUCKING_VOLUME_PERCENT_MAX
        )
      ) {
        res.status(400).json({
          error: `duckingVolumePercent must be between ${DUCKING_VOLUME_PERCENT_MIN} and ${DUCKING_VOLUME_PERCENT_MAX}`,
        });
        return;
      }
      if (
        "duckingRecoveryMs" in req.body &&
        (
          typeof duckingRecoveryMs !== "number" ||
          !Number.isFinite(duckingRecoveryMs) ||
          duckingRecoveryMs < DUCKING_RECOVERY_MS_MIN ||
          duckingRecoveryMs > DUCKING_RECOVERY_MS_MAX
        )
      ) {
        res.status(400).json({
          error: `duckingRecoveryMs must be between ${DUCKING_RECOVERY_MS_MIN} and ${DUCKING_RECOVERY_MS_MAX}`,
        });
        return;
      }

      // Update in database
      botManager.updateBot(req.params.id, {
        name,
        serverAddress,
        serverPort,
        nickname,
        defaultChannel,
        channelPassword,
        serverPassword,
        ...(typeof duckingEnabled === "boolean" ? { duckingEnabled } : {}),
        ...(typeof duckingVolumePercent === "number"
          ? { duckingVolumePercent: Math.round(duckingVolumePercent) }
          : {}),
        ...(typeof duckingRecoveryMs === "number"
          ? { duckingRecoveryMs: Math.round(duckingRecoveryMs) }
          : {}),
      });
      res.json({ success: true });
    } catch (err) {
      logger.error({ err }, "Failed to update bot");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await botManager.removeBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/start", async (req, res) => {
    try {
      await botManager.startBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/:id/stop", (req, res) => {
    try {
      botManager.stopBot(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
  return router;
}
