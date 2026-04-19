import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  getConfiguredMaxVolume,
  getConfiguredSpotifyLibrespotAuthMode,
  getDefaultConfig,
  loadConfig,
  saveConfig,
} from "./config.js";

describe("config", () => {
  const dirs: string[] = [];

  function makeTmpDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tsmusicbot-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("returns default config when file does not exist", () => {
    const config = loadConfig("/nonexistent/path/config.json");
    expect(config).toEqual(getDefaultConfig());
  });

  it("creates config file on save", () => {
    const dir = makeTmpDir();
    const path = join(dir, "sub", "config.json");
    const config = getDefaultConfig();
    saveConfig(path, config);

    const loaded = loadConfig(path);
    expect(loaded).toEqual(config);
  });

  it("merges partial config with defaults", () => {
    const dir = makeTmpDir();
    const path = join(dir, "config.json");

    // Save a partial config by writing only some fields
    const partial = { webPort: 8080, locale: "en" };
    writeFileSync(path, JSON.stringify(partial), "utf-8");

    const loaded = loadConfig(path);
    expect(loaded.webPort).toBe(8080);
    expect(loaded.locale).toBe("en");
    // defaults should fill in the rest
    expect(loaded.theme).toBe("dark");
    expect(loaded.commandPrefix).toBe("!");
    expect(loaded.autoPauseOnEmpty).toBe(true);
    expect(loaded.idleTimeoutMinutes).toBe(0);
    expect(loaded.maxVolume).toBe(20);
  });

  it("sanitizes configured max volume", () => {
    expect(getConfiguredMaxVolume({ maxVolume: 35 })).toBe(35);
    expect(getConfiguredMaxVolume({ maxVolume: 999 })).toBe(100);
    expect(getConfiguredMaxVolume({ maxVolume: 0 })).toBe(1);
    expect(getConfiguredMaxVolume({})).toBe(20);
  });

  it("defaults librespot auth mode to access-token and accepts credentials-cache", () => {
    expect(getConfiguredSpotifyLibrespotAuthMode({})).toBe("access-token");
    expect(getConfiguredSpotifyLibrespotAuthMode({ spotifyLibrespotAuthMode: "credentials-cache" })).toBe("credentials-cache");
    expect(getConfiguredSpotifyLibrespotAuthMode({ spotifyLibrespotAuthMode: "access-token" })).toBe("access-token");
    expect(getDefaultConfig().spotifyLibrespotAuthMode).toBe("access-token");
  });
});
