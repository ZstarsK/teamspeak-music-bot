import express from "express";
import axios from "axios";
import http from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { BotManager } from "../bot/manager.js";
import type { MusicProvider } from "../music/provider.js";
import type { NeteaseProvider } from "../music/netease.js";
import type { QQMusicProvider } from "../music/qq.js";
import type { SpotifyProvider } from "../music/spotify.js";
import type { BotDatabase } from "../data/database.js";
import type { BotConfig } from "../data/config.js";
import type { Logger } from "../logger.js";
import type { CookieStore } from "../music/auth.js";
import { createBotRouter } from "./api/bot.js";
import { createMusicRouter } from "./api/music.js";
import { createPlayerRouter } from "./api/player.js";
import { createAuthRouter } from "./api/auth.js";
import { setupWebSocket } from "./websocket.js";

export interface WebServerOptions {
  port: number;
  botManager: BotManager;
  neteaseProvider: NeteaseProvider;
  qqProvider: QQMusicProvider;
  bilibiliProvider: MusicProvider;
  spotifyProvider?: SpotifyProvider;
  database: BotDatabase;
  config: BotConfig;
  configPath: string;
  logger: Logger;
  cookieStore?: CookieStore;
  staticDir?: string;
}

export interface WebServer {
  start(): Promise<void>;
  stop(): void;
}

export function createWebServer(options: WebServerOptions): WebServer {
  const app = express();
  const server = http.createServer(app);
  const logger = options.logger.child({ component: "web" });

  if (options.config.trustProxy) {
    // Honor X-Forwarded-* from a reverse proxy (nginx/Caddy/Cloudflare).
    app.set("trust proxy", true);
  }

  app.use(express.json());

  app.get("/api/config/public-url", (_req, res) => {
    const raw = (options.config.publicUrl ?? "").trim();
    res.json({ publicUrl: raw ? raw.replace(/\/+$/, "") : null });
  });

  app.use(
    "/api/bot",
    createBotRouter(options.botManager, options.config, options.configPath, logger)
  );
  app.use(
    "/api/music",
    createMusicRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, logger, options.spotifyProvider)
  );
  app.use("/api/player", createPlayerRouter(
    options.botManager, logger, options.database,
    options.neteaseProvider, options.qqProvider, options.bilibiliProvider, options.config,
  ));
  app.use(
    "/api/auth",
    createAuthRouter(options.neteaseProvider, options.qqProvider, options.bilibiliProvider, logger, options.cookieStore, options.spotifyProvider, options.config)
  );

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", version: "0.1.0" });
  });

  app.get("/api/proxy/image", async (req, res) => {
    try {
      const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
      if (!rawUrl) {
        res.status(400).json({ error: "url is required" });
        return;
      }
      const target = new URL(rawUrl);
      const host = target.hostname.toLowerCase();
      const allowed =
        host === "hdslb.com" ||
        host.endsWith(".hdslb.com") ||
        host === "bilibili.com" ||
        host.endsWith(".bilibili.com");
      if (!["http:", "https:"].includes(target.protocol) || !allowed) {
        res.status(400).json({ error: "image host is not allowed" });
        return;
      }

      const upstream = await axios.get(target.toString(), {
        responseType: "stream",
        timeout: 10_000,
        headers: {
          Referer: "https://www.bilibili.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        validateStatus: (status) => status >= 200 && status < 400,
      });

      res.setHeader("Cache-Control", "public, max-age=86400");
      const contentType = upstream.headers["content-type"];
      if (contentType) res.setHeader("Content-Type", contentType);
      const contentLength = upstream.headers["content-length"];
      if (contentLength) res.setHeader("Content-Length", contentLength);
      upstream.data.pipe(res);
    } catch (err) {
      logger.warn({ err }, "Image proxy request failed");
      if (!res.headersSent) {
        res.status(502).json({ error: "image proxy failed" });
      }
    }
  });

  if (options.staticDir) {
    app.use(express.static(options.staticDir));
    app.get(/^(?!\/api|\/ws)/, (_req, res) => {
      res.sendFile(path.join(options.staticDir!, "index.html"));
    });
  }

  server.on("error", (err) => {
    logger.error({ err }, "HTTP server error");
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("error", (err) => {
    logger.error({ err }, "WebSocket server error");
  });
  const cleanupWs = setupWebSocket(wss, options.botManager, logger);

  return {
    async start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(options.port, () => {
          logger.info({ port: options.port }, "Web server started");
          resolve();
        });
      });
    },
    stop(): void {
      cleanupWs();
      wss.close();
      server.close();
    },
  };
}
