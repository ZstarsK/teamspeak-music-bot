import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface DuckingSettings {
  enabled: boolean;
  volumePercent: number;
  recoveryMs: number;
}

export const DEFAULT_MAX_VOLUME = 20;
export const MAX_VOLUME_CONFIG_MIN = 1;
export const MAX_VOLUME_CONFIG_MAX = 100;
export const DUCKING_VOLUME_PERCENT_MIN = 0;
export const DUCKING_VOLUME_PERCENT_MAX = 100;
export const DUCKING_RECOVERY_MS_MIN = 0;
export const DUCKING_RECOVERY_MS_MAX = 10_000;

export function getDefaultDuckingSettings(): DuckingSettings {
  return {
    enabled: true,
    volumePercent: 35,
    recoveryMs: 420,
  };
}

export interface BotConfig {
  webPort: number;
  locale: "zh" | "en";
  theme: "dark" | "light";
  commandPrefix: string;
  commandAliases: Record<string, string>;
  neteaseApiPort: number;
  qqMusicApiPort: number;
  adminPassword: string;
  adminGroups: number[];
  autoReturnDelay: number;
  autoPauseOnEmpty: boolean;
  idleTimeoutMinutes: number;
  maxVolume: number;
  // Public base URL used when generating share links (e.g. the bot专属链接).
  // Leave empty to use the browser's current origin. Example:
  //   "https://music.example.com" or "http://1.2.3.4:3000"
  publicUrl: string;
  // When true, Express trusts X-Forwarded-* headers from a reverse proxy
  // (nginx/Caddy/Cloudflare). Required for correct protocol/host detection
  // behind HTTPS-terminating proxies.
  trustProxy: boolean;
  spotifyClientId: string;
  spotifyClientSecret: string;
  spotifyRedirectUri: string;
  spotifyLibrespotPath: string;
  spotifyDeviceName: string;
}

export function getDefaultConfig(): BotConfig {
  return {
    webPort: 3000,
    locale: "zh",
    theme: "dark",
    commandPrefix: "!",
    commandAliases: { p: "play", s: "skip", n: "next" },
    neteaseApiPort: 3001,
    qqMusicApiPort: 3200,
    adminPassword: "",
    adminGroups: [],
    autoReturnDelay: 300,
    autoPauseOnEmpty: true,
    idleTimeoutMinutes: 0,
    maxVolume: DEFAULT_MAX_VOLUME,
    publicUrl: "",
    trustProxy: false,
    spotifyClientId: "",
    spotifyClientSecret: "",
    spotifyRedirectUri: "",
    spotifyLibrespotPath: "librespot",
    spotifyDeviceName: "TSMusicBot Spotify",
  };
}

export function getConfiguredMaxVolume(config?: Partial<BotConfig> | null): number {
  const raw = config?.maxVolume;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_MAX_VOLUME;
  }
  return Math.max(
    MAX_VOLUME_CONFIG_MIN,
    Math.min(MAX_VOLUME_CONFIG_MAX, Math.round(raw)),
  );
}

export function loadConfig(path: string): BotConfig {
  const defaults = getDefaultConfig();
  try {
    const raw = readFileSync(path, "utf-8");
    const partial = JSON.parse(raw) as Partial<BotConfig>;
    return { ...defaults, ...partial };
  } catch {
    return defaults;
  }
}

export function saveConfig(path: string, config: BotConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}
