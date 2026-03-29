import pino from "pino";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function createLogger(logDir?: string): pino.Logger {
  if (!logDir) {
    return pino({ level: "info" });
  }

  mkdirSync(logDir, { recursive: true });

  const transport = pino.transport({
    targets: [
      {
        target: "pino/file",
        options: { destination: 1 }, // stdout
        level: "info",
      },
      {
        target: "pino/file",
        options: { destination: join(logDir, "bot.log"), mkdir: true },
        level: "debug",
      },
    ],
  });

  return pino({ level: "debug" }, transport);
}
