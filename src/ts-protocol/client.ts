import { EventEmitter } from "node:events";
import {
  Client as TS3FullClient,
  generateIdentity as genTS3Identity,
  identityFromString,
  sendTextMessage,
  listChannels,
  listClients,
  clientMove,
  type Identity,
  type TextMessage,
  type ClientInfo,
  type CommandMiddleware,
} from "@honeybbq/teamspeak-client";
import type { Logger } from "../logger.js";
import {
  detectServerProtocol,
  type ServerProtocol,
} from "./protocol-detect.js";
import { TS6HttpQuery } from "./http-query.js";
import { ts6VersionMiddleware } from "./ts6-compat.js";

export { CODEC_OPUS_MUSIC } from "./voice.js";
export type { ServerProtocol } from "./protocol-detect.js";

export interface TS3ClientOptions {
  host: string;
  port: number; // Voice/virtual server port (default 9987)
  queryPort: number; // ServerQuery port (10011 for TS3, 10080 for TS6 HTTP)
  nickname: string;
  identity?: string; // Exported identity string, or undefined to generate new
  defaultChannel?: string;
  channelPassword?: string;
  serverPassword?: string;
  /** Force a specific protocol instead of auto-detecting. */
  serverProtocol?: ServerProtocol;
  /** API key for TS6 HTTP Query authentication. */
  ts6ApiKey?: string;
}

export interface TS3TextMessage {
  invokerName: string;
  invokerId: string;
  invokerUid: string;
  message: string;
  targetMode: number; // 1=private, 2=channel, 3=server
}

export class TS3Client extends EventEmitter {
  private client: TS3FullClient | null = null;
  private identity: Identity;
  private clientId = 0;
  private logger: Logger;
  private disconnecting = false;
  private detectedProtocol: ServerProtocol = "unknown";
  private httpQuery: TS6HttpQuery | null = null;
  private udpErrorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private options: TS3ClientOptions, logger: Logger) {
    super();
    this.logger = logger;

    if (options.identity) {
      this.identity = identityFromString(options.identity);
    } else {
      this.identity = genTS3Identity(8);
    }
  }

  /** The detected (or forced) server protocol after connect(). */
  getServerProtocol(): ServerProtocol {
    return this.detectedProtocol;
  }

  /** TS6 HTTP Query client (available after connecting to a TS6 server). */
  getHttpQuery(): TS6HttpQuery | null {
    return this.httpQuery;
  }

  async connect(): Promise<void> {
    const addr = `${this.options.host}:${this.options.port}`;

    // Detect or use forced protocol
    if (this.options.serverProtocol && this.options.serverProtocol !== "unknown") {
      this.detectedProtocol = this.options.serverProtocol;
      this.logger.info(
        { addr, protocol: this.detectedProtocol },
        "Using forced server protocol",
      );
    } else {
      this.logger.info({ addr }, "Detecting server protocol (TS3/TS6)...");
      const detection = await detectServerProtocol(
        this.options.host,
        this.options.port,
        3000,
        { ts3QueryPort: 10011, ts6HttpPort: 10080 },
      );
      this.detectedProtocol = detection.protocol;
      if (this.detectedProtocol === "unknown") {
        this.logger.warn(
          { addr },
          "Could not detect server protocol (query ports 10011/10080 unreachable). " +
            "Will attempt voice connection anyway. Use serverProtocol option to force TS3 or TS6.",
        );
      } else {
        this.logger.info(
          { addr, protocol: this.detectedProtocol, queryPort: detection.queryPort },
          `Server protocol detected: ${this.detectedProtocol.toUpperCase()}`,
        );
      }
    }

    // Set up TS6 HTTP Query if applicable
    if (this.detectedProtocol === "ts6") {
      const queryPort = this.options.queryPort !== 10011 ? this.options.queryPort : 10080;
      this.httpQuery = new TS6HttpQuery({
        host: this.options.host,
        port: queryPort,
        apiKey: this.options.ts6ApiKey,
      });
    }

    // Guard against calling connect() while already connected
    if (this.client) {
      this.logger.warn("connect() called while already connected, disconnecting first");
      this.disconnect();
      // Give the old client a moment to tear down
      await new Promise((r) => setTimeout(r, 100));
    }

    this.logger.info(
      { addr, protocol: this.detectedProtocol },
      "Connecting to TeamSpeak server (full client protocol)",
    );

    // Throttle repeated "udp send error" warnings (fires every 20ms during playback if UDP breaks)
    let udpErrorCount = 0;
    const throttledWarn = (msg: string, ...args: unknown[]) => {
      if (typeof msg === "string" && msg.includes("udp send error")) {
        udpErrorCount++;
        if (udpErrorCount === 1) {
          this.logger.warn(msg);
          // After 2 seconds, log a summary and reset
          this.udpErrorTimer = setTimeout(() => {
            if (udpErrorCount > 1) {
              this.logger.warn(`udp send error (repeated ${udpErrorCount} times, connection may be lost)`);
            }
            udpErrorCount = 0;
            this.udpErrorTimer = null;
          }, 2000);
        }
        return;
      }
      this.logger.warn(msg);
    };

    // Apply TS6 version middleware if connecting to a TS6 server
    const commandMiddleware: CommandMiddleware[] = [];
    if (this.detectedProtocol === "ts6") {
      commandMiddleware.push(ts6VersionMiddleware("3.6.2"));
      this.logger.info("Applying TS6 compatibility: upgrading client_version to 3.6.2");
    }

    this.client = new TS3FullClient(this.identity, addr, this.options.nickname, {
      logger: {
        debug: (msg) => this.logger.debug(msg),
        info: (msg) => this.logger.info(msg),
        warn: throttledWarn,
        error: (msg) => this.logger.error(msg),
      },
      commandMiddleware,
    });

    this.client.on("textMessage", (msg: TextMessage) => {
      const tsMsg: TS3TextMessage = {
        invokerName: msg.invokerName,
        invokerId: String(msg.invokerID),
        invokerUid: msg.invokerUID,
        message: msg.message,
        targetMode: msg.targetMode,
      };
      this.emit("textMessage", tsMsg);
    });

    this.client.on("disconnected", (err) => {
      this.logger.warn({ err: err?.message }, "Connection closed");
      this.clientId = 0;
      this.emit("disconnected");
    });

    this.client.on("clientEnter", (info: ClientInfo) => {
      this.logger.debug(
        { nickname: info.nickname, id: info.id },
        "Client entered"
      );
    });

    await this.client.connect();
    await this.client.waitConnected();
    this.clientId = this.client.clientID();
    this.voiceFramesSent = 0;
    this.logger.info(
      { clientId: this.clientId, protocol: this.detectedProtocol },
      `Logged in (visible client, ${this.detectedProtocol.toUpperCase()} server)`,
    );

    // Join default channel if specified
    if (this.options.defaultChannel) {
      await this.joinChannel(
        this.options.defaultChannel,
        this.options.channelPassword
      );
    }

    this.emit("connected");
  }

  async joinChannel(channelName: string, password?: string): Promise<void> {
    if (!this.client) return;

    try {
      const channels = await listChannels(this.client);
      const channel = channels.find((ch) => ch.name === channelName);

      if (!channel) {
        this.logger.warn({ channelName }, "Channel not found");
        return;
      }

      await clientMove(
        this.client,
        this.clientId,
        channel.id,
        password
      );
      this.logger.info(
        { channelName, cid: channel.id.toString() },
        "Joined channel"
      );
    } catch (err) {
      this.logger.error({ err, channelName }, "Failed to join channel");
    }
  }

  async sendTextMessage(
    message: string,
    targetMode: number = 2
  ): Promise<void> {
    if (!this.client) return;
    // targetMode 2 = channel, target 0 = current channel
    const target = targetMode === 2 ? BigInt(0) : BigInt(this.clientId);
    await sendTextMessage(this.client, targetMode, target, message);
  }

  async getClientsInChannel(): Promise<ClientInfo[]> {
    if (!this.client) return [];
    try {
      const allClients = await listClients(this.client);
      const myChannelId = this.client.channelID();
      return allClients.filter((c) => c.channelID === myChannelId);
    } catch {
      return [];
    }
  }

  private voiceFramesSent = 0;

  sendVoiceData(opusFrame: Buffer): void {
    if (!this.client || this.disconnecting) return;
    try {
      this.client.sendVoice(opusFrame, 5);
      this.voiceFramesSent++;
      if (this.voiceFramesSent === 1) {
        this.logger.info({ opusBytes: opusFrame.length, clientId: this.clientId }, "First voice packet sent to TeamSpeak");
      }
    } catch (err) {
      if (this.voiceFramesSent === 0) {
        this.logger.error({ err }, "Failed to send first voice packet");
      }
    }
  }

  getIdentityExport(): string {
    return this.identity.toString();
  }

  getClientId(): number {
    return this.clientId;
  }

  disconnect(): void {
    if (this.client && !this.disconnecting) {
      this.disconnecting = true;
      const client = this.client;
      client.disconnect().catch(() => {}).finally(() => {
        if (this.client === client) {
          this.client = null;
        }
        this.disconnecting = false;
      });
    }
    this.clientId = 0;
    this.httpQuery = null;
    this.detectedProtocol = "unknown";
    if (this.udpErrorTimer) {
      clearTimeout(this.udpErrorTimer);
      this.udpErrorTimer = null;
    }
    this.logger.info("Disconnected from TeamSpeak server");
  }
}
