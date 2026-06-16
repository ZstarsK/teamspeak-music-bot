import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotManager } from "./manager.js";
import { createDatabase, type BotDatabase } from "../data/database.js";
import { getDefaultConfig } from "../data/config.js";
import type { Logger } from "../logger.js";

const logger = {
  child() {
    return this;
  },
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

const provider = {} as any;

describe("BotManager ducking config", () => {
  let database: BotDatabase;
  let manager: BotManager;

  beforeEach(() => {
    database = createDatabase(":memory:");
    manager = new BotManager(
      provider,
      provider,
      provider,
      database,
      getDefaultConfig(),
      logger,
    );
  });

  afterEach(() => {
    database.close();
  });

  it("persists and returns the ducking threshold", async () => {
    const bot = await manager.createBot({
      name: "Music Bot",
      serverAddress: "localhost",
      serverPort: 9987,
      nickname: "MusicBot",
      autoStart: false,
    });

    manager.updateBot(bot.id, {
      duckingRecoveryMs: 350,
      duckingThresholdDb: -20,
    });

    expect(manager.getBotConfig(bot.id)).toMatchObject({
      duckingRecoveryMs: 350,
      duckingThresholdDb: -20,
    });
    expect(bot.getStatus()).toMatchObject({
      duckingRecoveryMs: 350,
      duckingThresholdDb: -20,
    });
  });
});
