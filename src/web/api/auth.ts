import { Router } from "express";
import type { MusicProvider } from "../../music/provider.js";
import { YouTubeProvider } from "../../music/youtube.js";
import type { CookieStore } from "../../music/auth.js";
import { QQMusicProvider } from "../../music/qq.js";
import { NeteaseProvider } from "../../music/netease.js";
import type { Logger } from "../../logger.js";

export function createAuthRouter(
  neteaseProvider: NeteaseProvider,
  qqProvider: QQMusicProvider,
  bilibiliProvider: MusicProvider,
  logger: Logger,
  cookieStore?: CookieStore
): Router {
  const router = Router();
  // YouTube is auth-less; we only use this instance so /auth/status can
  // report whether yt-dlp is actually installed (loggedIn=false otherwise).
  const youtubeProvider: MusicProvider = new YouTubeProvider();

  function getProvider(platform?: string): MusicProvider {
    if (platform === "bilibili") return bilibiliProvider;
    if (platform === "youtube") return youtubeProvider;
    return platform === "qq" ? qqProvider : neteaseProvider;
  }

  function getAccountProvider(platform?: string): NeteaseProvider | QQMusicProvider | null {
    if (platform === "qq") return qqProvider;
    if (platform === "netease") return neteaseProvider;
    return null;
  }

  async function persistCookieForPlatform(
    platform: "netease" | "qq" | "bilibili",
    cookie: string
  ): Promise<void> {
    if (!cookieStore || !cookie) return;
    if (platform === "qq") {
      cookieStore.saveQQAccount(cookie, true);
      return;
    }
    if (platform === "netease") {
      const account = await neteaseProvider.upsertAccountFromCookie(cookie, true);
      if (account) {
        cookieStore.saveNeteaseAccount({
          uid: account.uid,
          cookie: account.cookie,
          nickname: account.nickname,
          avatarUrl: account.avatarUrl,
        }, true);
      } else {
        cookieStore.save("netease", cookie);
      }
      return;
    }
    cookieStore.save(platform, cookie);
  }

  router.get("/status", async (req, res) => {
    try {
      const platform = req.query.platform as string;
      const provider = getProvider(platform);
      const status = await provider.getAuthStatus();
      logger.debug({ platform, status }, "Auth status check");
      res.json({ platform: provider.platform, ...status });
    } catch (err) {
      logger.error({ err }, "Auth status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/accounts", async (req, res) => {
    const platform = req.query.platform as string;
    const provider = getAccountProvider(platform);
    if (!provider) {
      res.status(400).json({ error: "Only NetEase and QQ accounts are supported here" });
      return;
    }
    const accounts = await provider.getAccountsWithStatus();
    res.json({
      platform,
      primaryAccountId: provider.getPrimaryAccountId(),
      accounts,
    });
  });

  router.post("/accounts/primary", (req, res) => {
    const { platform, accountId } = req.body ?? {};
    const provider = getAccountProvider(platform);
    if (!provider) {
      res.status(400).json({ error: "Only NetEase and QQ accounts are supported here" });
      return;
    }
    if (typeof accountId !== "string" || !accountId) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    if (!provider.getAccounts().some((account) => account.id === accountId)) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    if (cookieStore) {
      const ok = platform === "qq"
        ? cookieStore.setQQPrimary(accountId)
        : cookieStore.setNeteasePrimary(accountId);
      if (!ok) {
        res.status(404).json({ error: "Account not found in cookie store" });
        return;
      }
    }
    provider.setPrimaryAccount(accountId);
    res.json({
      success: true,
      primaryAccountId: provider.getPrimaryAccountId(),
      accounts: provider.getAccounts(),
    });
  });

  router.delete("/accounts", (req, res) => {
    const { platform, accountId } = req.body ?? {};
    const provider = getAccountProvider(platform);
    if (!provider) {
      res.status(400).json({ error: "Only NetEase and QQ accounts are supported here" });
      return;
    }
    if (typeof accountId !== "string" || !accountId) {
      res.status(400).json({ error: "accountId is required" });
      return;
    }
    if (cookieStore) {
      const ok = platform === "qq"
        ? cookieStore.removeQQAccount(accountId)
        : cookieStore.removeNeteaseAccount(accountId);
      if (!ok) {
        res.status(404).json({ error: "Account not found in cookie store" });
        return;
      }
    }
    if (!provider.removeAccount(accountId)) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.json({
      success: true,
      primaryAccountId: provider.getPrimaryAccountId(),
      accounts: provider.getAccounts(),
    });
  });

  router.post("/qrcode", async (req, res) => {
    try {
      const { platform } = req.body;
      const provider = getProvider(platform);
      const qr = await provider.getQrCode();
      logger.info({ platform, key: qr.key }, "QR code generated");
      res.json(qr);
    } catch (err) {
      logger.error({ err }, "QR code generation failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/qrcode/status", async (req, res) => {
    try {
      const { key, platform } = req.query;
      if (!key) {
        res.status(400).json({ error: "key is required" });
        return;
      }
      const provider = getProvider(platform as string);
      const status = await provider.checkQrCodeStatus(key as string);
      logger.info({ platform, status, key }, "QR status check");

      // When confirmed, persist cookie
      if (status === "confirmed") {
        const cookie = provider.getCookie();
        const plat = (platform as string) === "bilibili" ? "bilibili" as const
          : (platform as string) === "qq" ? "qq" as const : "netease" as const;
        if (cookie && cookieStore) {
          await persistCookieForPlatform(plat, cookie);
          logger.info({ platform: plat }, "Cookie persisted to disk");
        }
      }

      res.json({ status });
    } catch (err) {
      logger.error({ err }, "QR status check failed");
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/sms/send", async (req, res) => {
    try {
      const { phone } = req.body;
      if (!phone) {
        res.status(400).json({ error: "phone is required" });
        return;
      }
      if (!neteaseProvider.sendSmsCode) {
        res
          .status(400)
          .json({ error: "SMS login not supported for this platform" });
        return;
      }
      const success = await neteaseProvider.sendSmsCode(phone);
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/sms/verify", async (req, res) => {
    try {
      const { phone, code } = req.body;
      if (!phone || !code) {
        res.status(400).json({ error: "phone and code are required" });
        return;
      }
      if (!neteaseProvider.loginWithSms) {
        res.status(400).json({ error: "SMS login not supported" });
        return;
      }
      const success = await neteaseProvider.loginWithSms(phone, code);
      if (success && cookieStore) {
        await persistCookieForPlatform("netease", neteaseProvider.getCookie());
      }
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/cookie", async (req, res) => {
    const { platform, cookie } = req.body;
    if (!cookie) {
      res.status(400).json({ error: "cookie is required" });
      return;
    }
    // YouTube has no cookie concept — reject instead of falling through and
    // clobbering the NetEase cookie entry.
    if (platform === "youtube") {
      res
        .status(400)
        .json({ error: "YouTube does not use cookies (uses yt-dlp binary)" });
      return;
    }
    const provider = getProvider(platform);
    provider.setCookie(cookie);
    const plat = platform === "bilibili" ? "bilibili" as const
      : platform === "qq" ? "qq" as const : "netease" as const;
    if (cookieStore) {
      await persistCookieForPlatform(plat, cookie);
    }
    res.json({ success: true });
  });

  return router;
}
