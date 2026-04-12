# Bot Profile Manager — Design Spec

## Goal

When the bot plays a song, automatically update its TeamSpeak presence (avatar, description, nickname, away status, channel description) and send a "now playing" chat message. When playback stops, restore all values to defaults. Each feature is independently configurable and permission-safe — if the bot lacks a required server permission, that feature silently disables itself until the next reconnect.

## Features

| # | Feature | Update on song | Restore on stop | TS3 mechanism | TS6 mechanism |
|---|---------|---------------|-----------------|---------------|---------------|
| 1 | Avatar | Album cover art | Delete avatar | File transfer upload + `clientupdate client_flag_avatar=<md5>` | Same (file transfer is protocol-level) |
| 2 | Description | `歌名 - 歌手 [专辑]` | Clear (empty string) | `clientupdate client_description=...` | `httpQuery.clientUpdate(...)` |
| 3 | Nickname | `♪ 歌名 - 歌手 \| 原昵称` (max 30 chars) | Restore `defaultNickname` | `clientupdate client_nickname=...` | `httpQuery.clientUpdate(...)` |
| 4 | Away status | `client_away=1`, message = `正在播放: 歌名 - 歌手` | `client_away=0` | `clientupdate client_away=...` | `httpQuery.clientUpdate(...)` |
| 5 | Channel description | `正在播放: 歌名 - 歌手\n专辑: xxx\n平台: xxx` | Clear | `channeledit cid=... channel_description=...` | `httpQuery.request("POST", "/1/channeledit", ...)` |
| 6 | Now-playing message | `♪ 正在播放: 歌名 - 歌手 [专辑]` | (not sent on stop) | `sendTextMessage` (existing) | `sendTextMessage` (existing) |

## Architecture

```
resolveAndPlay() success / stop / clear / playNext exhausted
    ↓
BotInstance → BotProfileManager.onSongChange(song | null)
                 ├─ updateAvatar(coverUrl | null)       [fire-and-forget]
                 ├─ updateDescription(song | null)
                 ├─ updateNickname(song | null)
                 ├─ updateAwayStatus(song | null)
                 ├─ updateChannelDescription(song | null)
                 └─ sendNowPlayingMessage(song)          [only when song != null]

BotInstance.connect()  → profileManager.onConnect()   // reset perm flags, restore defaults
BotInstance.disconnect() → (no action needed, server cleans up)
```

## File Changes

| File | Change |
|------|--------|
| `src/bot/profile.ts` | **New** — `BotProfileManager` class |
| `src/ts-protocol/client.ts` | Add `execCommand`, `execCommandWithResponse`, file transfer methods, `escapeTS3()` |
| `src/bot/instance.ts` | Create & hold `BotProfileManager`, call at lifecycle points |
| `src/data/database.ts` | Add 6 profile config columns via ALTER TABLE migration |
| `src/web/api/player.ts` | Add `GET/PUT /api/player/:botId/profile` endpoints |

## TS3Client Layer Extensions

New methods on `TS3Client` (all delegate to underlying `@honeybbq/teamspeak-client` Client):

```typescript
execCommand(cmd: string): Promise<void>
execCommandWithResponse(cmd: string): Promise<Record<string, string>[]>
fileTransferInitUpload(channelID: bigint, path: string, password: string,
                       size: bigint, overwrite?: boolean): Promise<FileUploadInfo>
uploadFileData(host: string, info: FileUploadInfo, data: Readable): Promise<void>
fileTransferDeleteFile(channelID: bigint, paths: string[]): Promise<void>
```

Utility: `escapeTS3(str: string): string` — escapes spaces (`\s`), backslashes (`\\`), pipes (`\p`), slashes (`\/`).

## BotProfileManager Detail

```typescript
interface ProfileConfig {
  avatarEnabled: boolean;        // default true
  descriptionEnabled: boolean;   // default true
  nicknameEnabled: boolean;      // default true
  awayStatusEnabled: boolean;    // default true
  channelDescEnabled: boolean;   // default true
  nowPlayingMsgEnabled: boolean; // default true
}
```

### Permission Handling

- Each feature has an independent `permDenied: boolean` flag.
- On first failure where error message contains "permission" or "insufficient" → set flag, skip subsequent calls.
- On `onConnect()` → reset all flags (new connection may have different permissions).
- Non-permission errors (network timeout, etc.) do NOT set the flag — next song change will retry.

### Nickname Truncation

- Format: `♪ {songInfo} | {defaultNickname}`
- TS3 max nickname: 30 characters
- If total > 30: truncate songInfo, keep defaultNickname
- If `♪  | {defaultNickname}` alone > 30: skip nickname update entirely

### Avatar Upload Flow (TS3)

1. Download cover image via axios (HTTP GET coverUrl) → Buffer
2. `fileTransferInitUpload(0n, "/avatar", "", BigInt(buffer.length), true)`
3. `uploadFileData(host, info, Readable.from(buffer))`
4. Compute MD5: `crypto.createHash('md5').update(buffer).digest('hex')`
5. `execCommand("clientupdate client_flag_avatar=" + md5)`

To clear: `fileTransferDeleteFile(0n, ["/avatar"])` + `execCommand("clientupdate client_flag_avatar=")`

### Fire-and-Forget

Avatar download/upload is slow. `onSongChange()` launches all updates concurrently via `Promise.allSettled()` — failures are logged but never block playback.

## Database Migration

```sql
ALTER TABLE bot_instances ADD COLUMN profile_avatar_enabled INTEGER DEFAULT 1;
ALTER TABLE bot_instances ADD COLUMN profile_description_enabled INTEGER DEFAULT 1;
ALTER TABLE bot_instances ADD COLUMN profile_nickname_enabled INTEGER DEFAULT 1;
ALTER TABLE bot_instances ADD COLUMN profile_away_enabled INTEGER DEFAULT 1;
ALTER TABLE bot_instances ADD COLUMN profile_channel_desc_enabled INTEGER DEFAULT 1;
ALTER TABLE bot_instances ADD COLUMN profile_now_playing_enabled INTEGER DEFAULT 1;
```

## Web API

```
GET  /api/player/:botId/profile  → { avatarEnabled, descriptionEnabled, ... }
PUT  /api/player/:botId/profile  → body: Partial<ProfileConfig> → 200 OK
```

## Constraints

- All profile operations are async, never block playback
- Uses existing `axios` dependency for image download
- MD5 via Node.js built-in `crypto`
- No new npm dependencies required
