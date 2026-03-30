<p align="center">
  <img src="https://img.shields.io/badge/TeamSpeak_3-Music_Bot-blue?style=for-the-badge&logo=teamspeak" alt="TSMusicBot" />
</p>

<h1 align="center">TSMusicBot</h1>

<p align="center">
  <strong>TeamSpeak 3 音乐机器人</strong> — 网易云音乐 + QQ 音乐双平台，YesPlayMusic 风格 WebUI
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vue-3-4FC08D?logo=vuedotjs&logoColor=white" />
  <img src="https://img.shields.io/badge/License-MIT-green" />
  <img src="https://img.shields.io/badge/FFmpeg-Bundled-orange?logo=ffmpeg" />
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white" />
</p>

---

## Features

- **Dual Music Source** — NetEase Cloud Music + QQ Music, unified search with source badges
- **Real TS3 Client Protocol** — Bot appears as a visible client (not invisible ServerQuery)
- **YesPlayMusic WebUI** — Beautiful dark/light theme, responsive design
- **Full Playback Control** — Play, pause, next, prev, seek, volume
- **4 Play Modes** — Sequential, loop, shuffle, shuffle-loop
- **Synced Lyrics** — Real-time scrolling lyrics with translation, server-side frame-accurate sync
- **Playlist Management** — Recommended, daily, personal FM, user playlists
- **Audio Quality** — Standard (128k) to Master Quality (4000k FLAC)
- **QR Code Login** — Scan to login NetEase / QQ Music accounts
- **Multi-Instance** — Manage multiple bots connected to different TS servers
- **Lazy URL Loading** — Playlist loads instantly, URL fetched on-demand (never expires)
- **One-Click Deploy** — FFmpeg bundled, Windows batch / Linux systemd / Docker

## Screenshots

> *WebUI screenshots coming soon*

## Quick Start

### Option 1: Windows (Easiest)

```powershell
# 1. Clone
git clone https://github.com/YOUR_USERNAME/tsmusicbot.git
cd tsmusicbot

# 2. Setup (first time only — installs Node.js + all dependencies)
scripts\setup.bat

# 3. Start
scripts\start.bat
```

Open **http://localhost:3000** and follow the setup wizard.

### Option 2: Manual Install (Any OS)

**Prerequisites:** [Node.js 20+](https://nodejs.org/) and a TeamSpeak 3 server.
FFmpeg is **bundled automatically** — no manual install needed.

```bash
# Clone
git clone https://github.com/YOUR_USERNAME/tsmusicbot.git
cd tsmusicbot

# Install dependencies
npm install
cd web && npm install && cd ..

# Build
npm run build

# Start
npm start
```

### Option 3: Docker

All dependencies included. Zero configuration.

```bash
git clone https://github.com/YOUR_USERNAME/tsmusicbot.git
cd tsmusicbot/scripts/docker
docker-compose up -d
```

Open **http://localhost:3000**

<details>
<summary>Docker details</summary>

- First build takes a few minutes (compiling native modules)
- Uses `host` network mode for LAN TS3 server connectivity
- Data persisted in Docker named volume `tsmusicbot-data`
- Built-in health check at `/api/health`

```bash
docker logs -f tsmusicbot          # View logs
docker-compose down                # Stop
docker-compose up -d --build       # Rebuild after code update
```

If TS3 server is remote, edit `docker-compose.yml`:
```yaml
# Replace network_mode: host with:
ports:
  - "3000:3000"
```

</details>

### Option 4: Linux (systemd)

```bash
chmod +x scripts/install.sh
sudo ./scripts/install.sh
```

Auto-installs Node.js, dependencies, configures systemd service with auto-start.

## Usage

### First-Time Setup

1. Open **http://localhost:3000/setup**
2. Enter your TeamSpeak server address (default port: 9987)
3. Set bot nickname
4. (Optional) Scan QR code to login NetEase/QQ Music for VIP songs

### WebUI Pages

| Page | Description |
|------|-------------|
| **Home** | Recommended playlists, daily picks, personal FM, my playlists |
| **Search** | Unified search across both platforms, results show source badge |
| **Playlist** | View playlist detail, play all (respects current play mode) |
| **Lyrics** | Full-screen synced lyrics with blurred album art background |
| **History** | All previously played songs |
| **Settings** | Theme, bot management, account login, audio quality, command prefix |

### TeamSpeak Text Commands

Control the bot by sending text messages in your TS channel:

| Command | Description |
|---------|-------------|
| `!play <song>` | Search and play |
| `!play -q <song>` | Search from QQ Music |
| `!add <song>` | Add to queue |
| `!pause` / `!resume` | Pause / Resume |
| `!next` / `!prev` | Next / Previous track |
| `!stop` | Stop and clear queue |
| `!vol <0-100>` | Set volume |
| `!queue` | Show queue |
| `!mode <seq\|loop\|random\|rloop>` | Change play mode |
| `!playlist <ID>` | Load playlist |
| `!album <ID>` | Load album |
| `!fm` | Personal FM (NetEase) |
| `!lyrics` | Show lyrics |
| `!now` | Current track info |
| `!vote` | Vote to skip |
| `!help` | Help |

> Default prefix: `!` (configurable in Settings). Aliases: `!p` = `!play`, `!s` = `!skip`, `!n` = `!next`

### Audio Quality

| Level | Bitrate | Format | Note |
|-------|---------|--------|------|
| Standard | 128kbps | MP3 | Free |
| Higher | 192kbps | MP3 | Free |
| **Exhigh** | **320kbps** | **MP3** | **Default** |
| Lossless | ~900kbps | FLAC | VIP required |
| Hi-Res | ~1500kbps | FLAC | VIP required |
| Master | ~4000kbps | FLAC | Premium VIP |

Change in Settings page. Takes effect immediately for subsequent songs.

## Architecture

```
tsmusicbot/
├── src/                        # Backend (TypeScript)
│   ├── audio/                  # Audio pipeline: FFmpeg → PCM → Opus → 20ms frames
│   │   ├── encoder.ts          # Opus encoder (@discordjs/opus)
│   │   ├── player.ts           # FFmpeg player (bundled ffmpeg-static, frame-count tracking)
│   │   └── queue.ts            # Play queue (4 modes, lazy URL)
│   ├── bot/                    # Bot core
│   │   ├── commands.ts         # Text command parser (prefix, aliases, permissions)
│   │   ├── instance.ts         # Bot instance (TS3 + player + music provider)
│   │   └── manager.ts          # Multi-instance lifecycle
│   ├── data/                   # Data layer
│   │   ├── config.ts           # JSON config
│   │   └── database.ts         # SQLite (history, instances)
│   ├── music/                  # Music sources
│   │   ├── provider.ts         # Unified MusicProvider interface
│   │   ├── netease.ts          # NetEase Cloud Music adapter
│   │   ├── qq.ts               # QQ Music adapter
│   │   ├── auth.ts             # Cookie persistence
│   │   └── api-server.ts       # Embedded API servers (auto-start)
│   ├── ts-protocol/            # TS3 client protocol
│   │   └── client.ts           # Full client (ECDH + AES-EAX encryption)
│   ├── web/                    # Web backend
│   │   ├── server.ts           # Express + WebSocket
│   │   └── api/                # REST API (bot, music, player, auth)
│   └── index.ts                # Entry point
├── web/src/                    # Frontend (Vue 3)
│   ├── components/             # Player, Navbar, Queue, CoverArt, SongCard
│   ├── views/                  # Home, Search, Playlist, Lyrics, History, Settings, Setup
│   ├── stores/                 # Pinia (server-synced elapsed time)
│   └── styles/                 # SCSS theme (dark/light)
├── scripts/
│   ├── setup.bat               # Windows first-time setup
│   ├── start.bat               # Windows start script
│   ├── install.sh              # Linux installer + systemd
│   └── docker/                 # Dockerfile + docker-compose.yml
├── data/                       # Runtime (auto-created): DB, cookies, logs
└── config.json                 # Config (auto-generated on first run)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20+, TypeScript 5 |
| Backend | Express 4, WebSocket (ws) |
| Database | better-sqlite3 (SQLite) |
| Audio | FFmpeg (ffmpeg-static), @discordjs/opus |
| TS3 Protocol | @honeybbq/teamspeak-client (full ECDH + AES-EAX) |
| NetEase API | NeteaseCloudMusicApi |
| QQ Music API | @sansenjian/qq-music-api |
| Frontend | Vue 3, Vite 5, Pinia, Vue Router 4 |
| Styling | SCSS (YesPlayMusic-inspired design) |
| Icons | @iconify/vue |
| Logging | pino |

## Configuration

The `config.json` file is auto-generated on first run:

```json
{
  "webPort": 3000,
  "locale": "zh",
  "theme": "dark",
  "commandPrefix": "!",
  "commandAliases": { "p": "play", "s": "skip", "n": "next" },
  "neteaseApiPort": 3001,
  "qqMusicApiPort": 3200,
  "adminPassword": "",
  "adminGroups": [],
  "autoReturnDelay": 300,
  "autoPauseOnEmpty": true
}
```

## FAQ

**Q: Bot connects but no sound in TeamSpeak?**
A: Make sure the bot is in the same channel as you. Check volume (`!vol 75`). Ensure the song has a playable URL (some VIP songs require login).

**Q: "Cannot get play URL" error?**
A: Login to your music account in Settings (QR code scan). Many songs require authentication.

**Q: How to change the bot's TS channel?**
A: Use `!move <channel name>` command, or set default channel in Settings when creating the bot.

**Q: Can I run multiple bots?**
A: Yes. Create additional bot instances in Settings page, each connecting to a different TS server or channel.

**Q: Port 3200 already in use?**
A: The QQ Music API auto-starts on port 3200. If a previous instance is still running, the app will reuse it. Kill old `node` processes if needed.

**Q: Docker build fails?**
A: Native modules (opus, sqlite3) need compilation tools. The Dockerfile includes them. Make sure Docker has enough memory (2GB+).

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Acknowledgments

- [YesPlayMusic](https://github.com/qier222/YesPlayMusic) — UI design inspiration
- [TS3AudioBot](https://github.com/Splamy/TS3AudioBot) — Architecture reference
- [TS3AudioBot-NetEaseCloudmusic-plugin](https://github.com/ZHANGTIANYAO1/TS3AudioBot-NetEaseCloudmusic-plugin) — Lazy loading pattern
- [NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi) — NetEase Cloud Music API
- [@sansenjian/qq-music-api](https://github.com/sansenjian/qq-music-api) — QQ Music API
- [@honeybbq/teamspeak-client](https://www.npmjs.com/package/@honeybbq/teamspeak-client) — TS3 client protocol

## License

[MIT](LICENSE)
