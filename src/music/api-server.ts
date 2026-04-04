import net from "node:net";
import type { Logger } from "../logger.js";
import type { Server } from "node:http";

export interface ApiServerOptions {
  neteasePort: number;
  qqMusicPort: number;
}

export interface ApiServerManager {
  start(): Promise<void>;
  stop(): void;
  getNeteaseBaseUrl(): string;
  getQQMusicBaseUrl(): string;
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      server.close(() => resolve(false));
    });
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

export function createApiServerManager(
  options: ApiServerOptions,
  logger: Logger
): ApiServerManager {
  let neteaseServer: Server | null = null;

  const neteaseBaseUrl = `http://127.0.0.1:${options.neteasePort}`;
  const qqMusicBaseUrl = `http://127.0.0.1:${options.qqMusicPort}`;

  return {
    async start(): Promise<void> {
      logger.info("Starting embedded music API servers...");

      // Start NetEase Cloud Music API
      try {
        const portFree = await isPortFree(options.neteasePort);
        if (!portFree) {
          logger.info(
            { port: options.neteasePort },
            "NetEase API port already in use — reusing existing instance"
          );
        } else {
          const ncmModule = await import("NeteaseCloudMusicApi") as any;
          const serverObj = ncmModule.server ?? ncmModule.default?.server;
          const app = await serverObj.serveNcmApi({ port: options.neteasePort });
          neteaseServer = app;
          logger.info(
            { port: options.neteasePort },
            "NetEase Cloud Music API started"
          );
        }
      } catch (err) {
        logger.error({ err }, "Failed to start NetEase Cloud Music API");
      }

      // Start QQ Music API (auto-starts on import)
      try {
        const portFree = await isPortFree(options.qqMusicPort);
        if (!portFree) {
          logger.info(
            { port: options.qqMusicPort },
            "QQ Music API port already in use — reusing existing instance"
          );
        } else {
          await import("@sansenjian/qq-music-api");
          logger.info(
            { port: options.qqMusicPort },
            "QQ Music API started"
          );
        }
      } catch (err) {
        logger.warn(
          { err },
          "QQ Music API not available — QQ Music features may be limited"
        );
      }
    },

    stop(): void {
      logger.info("Stopping music API servers");
      if (neteaseServer && typeof (neteaseServer as any).close === "function") {
        (neteaseServer as any).close();
      }
      neteaseServer = null;
    },

    getNeteaseBaseUrl(): string {
      return neteaseBaseUrl;
    },

    getQQMusicBaseUrl(): string {
      return qqMusicBaseUrl;
    },
  };
}
