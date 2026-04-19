import fs from "node:fs";
import path from "node:path";

export interface StoredQQAccount {
  id: string;
  uin: string;
  cookie: string;
  updatedAt: string;
}

export interface StoredNeteaseAccount {
  id: string;
  uid: string;
  cookie: string;
  nickname?: string;
  avatarUrl?: string;
  updatedAt: string;
}

export interface StoredSpotifyAccount {
  id: string;
  userId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope: string;
  expiresAt: number;
  avatarUrl?: string;
  updatedAt: string;
}

export interface CookieStore {
  save(platform: "netease" | "qq" | "bilibili", cookie: string): void;
  load(platform: "netease" | "qq" | "bilibili"): string;
  saveNeteaseAccount(
    account: {
      uid: string;
      cookie: string;
      nickname?: string;
      avatarUrl?: string;
    },
    makePrimary?: boolean
  ): StoredNeteaseAccount;
  loadNeteaseAccounts(): StoredNeteaseAccount[];
  getNeteasePrimaryId(): string | null;
  setNeteasePrimary(accountId: string): boolean;
  removeNeteaseAccount(accountId: string): boolean;
  saveQQAccount(cookie: string, makePrimary?: boolean): StoredQQAccount | null;
  loadQQAccounts(): StoredQQAccount[];
  getQQPrimaryId(): string | null;
  setQQPrimary(accountId: string): boolean;
  removeQQAccount(accountId: string): boolean;
  saveSpotifyAccount(account: Omit<StoredSpotifyAccount, "id" | "updatedAt">, makePrimary?: boolean): StoredSpotifyAccount;
  loadSpotifyAccounts(): StoredSpotifyAccount[];
  getSpotifyPrimaryId(): string | null;
  setSpotifyPrimary(accountId: string): boolean;
  removeSpotifyAccount(accountId: string): boolean;
}

export function createCookieStore(cookieDir: string): CookieStore {
  if (!fs.existsSync(cookieDir)) {
    fs.mkdirSync(cookieDir, { recursive: true });
  }

  const extractQQUin = (cookie: string): string | null => {
    const match = /(?:^|; )uin=o?0?(\d+)/.exec(cookie);
    return match ? match[1] : null;
  };

  const qqFilePath = path.join(cookieDir, "qq.json");
  const neteaseFilePath = path.join(cookieDir, "netease.json");
  const spotifyFilePath = path.join(cookieDir, "spotify.json");

  const readNeteaseState = (): {
    primaryId: string | null;
    accounts: StoredNeteaseAccount[];
    legacyCookie: string;
  } => {
    if (!fs.existsSync(neteaseFilePath)) {
      return { primaryId: null, accounts: [], legacyCookie: "" };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(neteaseFilePath, "utf-8"));
      if (typeof raw?.cookie === "string" && !Array.isArray(raw?.accounts)) {
        return {
          primaryId: null,
          accounts: [],
          legacyCookie: raw.cookie,
        };
      }
      const accounts: StoredNeteaseAccount[] = Array.isArray(raw?.accounts)
        ? raw.accounts
            .map((entry: any) => {
              const uid = typeof entry?.uid === "string" && entry.uid
                ? entry.uid
                : typeof entry?.id === "string"
                  ? String(entry.id).replace(/^netease:/, "")
                  : "";
              const cookie = typeof entry?.cookie === "string" ? entry.cookie : "";
              if (!uid || !cookie) return null;
              return {
                id: typeof entry?.id === "string" && entry.id ? entry.id : `netease:${uid}`,
                uid,
                cookie,
                nickname: typeof entry?.nickname === "string" ? entry.nickname : undefined,
                avatarUrl: typeof entry?.avatarUrl === "string" ? entry.avatarUrl : undefined,
                updatedAt: typeof entry?.updatedAt === "string"
                  ? entry.updatedAt
                  : new Date().toISOString(),
              } satisfies StoredNeteaseAccount;
            })
            .filter((entry: StoredNeteaseAccount | null): entry is StoredNeteaseAccount => entry !== null)
        : [];
      const primaryId = typeof raw?.primaryId === "string" && accounts.some((entry: StoredNeteaseAccount) => entry.id === raw.primaryId)
        ? raw.primaryId
        : accounts[0]?.id ?? null;
      return { primaryId, accounts, legacyCookie: "" };
    } catch {
      return { primaryId: null, accounts: [], legacyCookie: "" };
    }
  };

  const writeNeteaseState = (state: {
    primaryId: string | null;
    accounts: StoredNeteaseAccount[];
  }): void => {
    fs.writeFileSync(
      neteaseFilePath,
      JSON.stringify(state, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  };

  const readQQState = (): { primaryId: string | null; accounts: StoredQQAccount[] } => {
    if (!fs.existsSync(qqFilePath)) {
      return { primaryId: null, accounts: [] };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(qqFilePath, "utf-8"));
      if (typeof raw?.cookie === "string") {
        const uin = extractQQUin(raw.cookie);
        if (!uin) {
          return { primaryId: null, accounts: [] };
        }
        const account: StoredQQAccount = {
          id: `qq:${uin}`,
          uin,
          cookie: raw.cookie,
          updatedAt: raw.updatedAt ?? new Date().toISOString(),
        };
        return { primaryId: account.id, accounts: [account] };
      }
      const accounts: StoredQQAccount[] = Array.isArray(raw?.accounts)
        ? raw.accounts
            .map((entry: any) => {
              const uin = typeof entry?.uin === "string" && entry.uin
                ? entry.uin
                : extractQQUin(String(entry?.cookie ?? ""));
              const cookie = typeof entry?.cookie === "string" ? entry.cookie : "";
              if (!uin || !cookie) return null;
              return {
                id: typeof entry?.id === "string" && entry.id ? entry.id : `qq:${uin}`,
                uin,
                cookie,
                updatedAt: typeof entry?.updatedAt === "string"
                  ? entry.updatedAt
                  : new Date().toISOString(),
              } satisfies StoredQQAccount;
            })
            .filter((entry: StoredQQAccount | null): entry is StoredQQAccount => entry !== null)
        : [];
      const primaryId = typeof raw?.primaryId === "string" && accounts.some((entry: StoredQQAccount) => entry.id === raw.primaryId)
        ? raw.primaryId
        : accounts[0]?.id ?? null;
      return { primaryId, accounts };
    } catch {
      return { primaryId: null, accounts: [] };
    }
  };

  const writeQQState = (state: { primaryId: string | null; accounts: StoredQQAccount[] }): void => {
    fs.writeFileSync(
      qqFilePath,
      JSON.stringify(state, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  };

  const readSpotifyState = (): { primaryId: string | null; accounts: StoredSpotifyAccount[] } => {
    if (!fs.existsSync(spotifyFilePath)) {
      return { primaryId: null, accounts: [] };
    }
    try {
      const raw = JSON.parse(fs.readFileSync(spotifyFilePath, "utf-8"));
      const accounts: StoredSpotifyAccount[] = Array.isArray(raw?.accounts)
        ? raw.accounts
            .map((entry: any) => {
              const userId = typeof entry?.userId === "string" ? entry.userId : "";
              const accessToken = typeof entry?.accessToken === "string" ? entry.accessToken : "";
              const refreshToken = typeof entry?.refreshToken === "string" ? entry.refreshToken : "";
              if (!userId || !accessToken || !refreshToken) return null;
              return {
                id: typeof entry?.id === "string" && entry.id ? entry.id : `spotify:${userId}`,
                userId,
                displayName: typeof entry?.displayName === "string" && entry.displayName
                  ? entry.displayName
                  : userId,
                accessToken,
                refreshToken,
                tokenType: typeof entry?.tokenType === "string" ? entry.tokenType : "Bearer",
                scope: typeof entry?.scope === "string" ? entry.scope : "",
                expiresAt: typeof entry?.expiresAt === "number" ? entry.expiresAt : 0,
                avatarUrl: typeof entry?.avatarUrl === "string" ? entry.avatarUrl : undefined,
                updatedAt: typeof entry?.updatedAt === "string"
                  ? entry.updatedAt
                  : new Date().toISOString(),
              } satisfies StoredSpotifyAccount;
            })
            .filter((entry: StoredSpotifyAccount | null): entry is StoredSpotifyAccount => entry !== null)
        : [];
      const primaryId = typeof raw?.primaryId === "string" && accounts.some((entry) => entry.id === raw.primaryId)
        ? raw.primaryId
        : accounts[0]?.id ?? null;
      return { primaryId, accounts };
    } catch {
      return { primaryId: null, accounts: [] };
    }
  };

  const writeSpotifyState = (state: { primaryId: string | null; accounts: StoredSpotifyAccount[] }): void => {
    fs.writeFileSync(
      spotifyFilePath,
      JSON.stringify(state, null, 2),
      { encoding: "utf-8", mode: 0o600 },
    );
  };

  return {
    save(platform: "netease" | "qq" | "bilibili", cookie: string): void {
      if (platform === "qq") {
        this.saveQQAccount(cookie, true);
        return;
      }
      const filePath = path.join(cookieDir, `${platform}.json`);
      fs.writeFileSync(
        filePath,
        JSON.stringify({ cookie, updatedAt: new Date().toISOString() }),
        { encoding: "utf-8", mode: 0o600 }
      );
    },

    load(platform: "netease" | "qq" | "bilibili"): string {
      if (platform === "netease") {
        const { primaryId, accounts, legacyCookie } = readNeteaseState();
        if (accounts.length === 0) {
          return legacyCookie;
        }
        const primary = accounts.find((entry) => entry.id === primaryId) ?? accounts[0];
        return primary?.cookie ?? "";
      }
      if (platform === "qq") {
        const { primaryId, accounts } = readQQState();
        const primary = accounts.find((entry) => entry.id === primaryId) ?? accounts[0];
        return primary?.cookie ?? "";
      }
      const filePath = path.join(cookieDir, `${platform}.json`);
      if (!fs.existsSync(filePath)) return "";
      try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return data.cookie ?? "";
      } catch {
        return "";
      }
    },

    saveNeteaseAccount(
      account: {
        uid: string;
        cookie: string;
        nickname?: string;
        avatarUrl?: string;
      },
      makePrimary = true,
    ): StoredNeteaseAccount {
      const state = readNeteaseState();
      const nextAccount: StoredNeteaseAccount = {
        id: `netease:${account.uid}`,
        uid: account.uid,
        cookie: account.cookie,
        nickname: account.nickname,
        avatarUrl: account.avatarUrl,
        updatedAt: new Date().toISOString(),
      };
      const nextAccounts = state.accounts.filter((entry) => entry.id !== nextAccount.id);
      nextAccounts.push(nextAccount);
      writeNeteaseState({
        primaryId: makePrimary || !state.primaryId ? nextAccount.id : state.primaryId,
        accounts: nextAccounts,
      });
      return nextAccount;
    },

    loadNeteaseAccounts(): StoredNeteaseAccount[] {
      return readNeteaseState().accounts;
    },

    getNeteasePrimaryId(): string | null {
      return readNeteaseState().primaryId;
    },

    setNeteasePrimary(accountId: string): boolean {
      const state = readNeteaseState();
      if (!state.accounts.some((entry) => entry.id === accountId)) {
        return false;
      }
      writeNeteaseState({ ...state, primaryId: accountId });
      return true;
    },

    removeNeteaseAccount(accountId: string): boolean {
      const state = readNeteaseState();
      if (!state.accounts.some((entry) => entry.id === accountId)) {
        return false;
      }
      const accounts = state.accounts.filter((entry) => entry.id !== accountId);
      writeNeteaseState({
        primaryId: state.primaryId === accountId ? (accounts[0]?.id ?? null) : state.primaryId,
        accounts,
      });
      return true;
    },

    saveQQAccount(cookie: string, makePrimary = true): StoredQQAccount | null {
      const uin = extractQQUin(cookie);
      if (!uin) return null;
      const state = readQQState();
      const account: StoredQQAccount = {
        id: `qq:${uin}`,
        uin,
        cookie,
        updatedAt: new Date().toISOString(),
      };
      const nextAccounts = state.accounts.filter((entry) => entry.id !== account.id);
      nextAccounts.push(account);
      writeQQState({
        primaryId: makePrimary || !state.primaryId ? account.id : state.primaryId,
        accounts: nextAccounts,
      });
      return account;
    },

    loadQQAccounts(): StoredQQAccount[] {
      return readQQState().accounts;
    },

    getQQPrimaryId(): string | null {
      return readQQState().primaryId;
    },

    setQQPrimary(accountId: string): boolean {
      const state = readQQState();
      if (!state.accounts.some((entry) => entry.id === accountId)) {
        return false;
      }
      writeQQState({ ...state, primaryId: accountId });
      return true;
    },

    removeQQAccount(accountId: string): boolean {
      const state = readQQState();
      if (!state.accounts.some((entry) => entry.id === accountId)) {
        return false;
      }
      const accounts = state.accounts.filter((entry) => entry.id !== accountId);
      writeQQState({
        primaryId: state.primaryId === accountId ? (accounts[0]?.id ?? null) : state.primaryId,
        accounts,
      });
      return true;
    },

    saveSpotifyAccount(
      account: Omit<StoredSpotifyAccount, "id" | "updatedAt">,
      makePrimary = true,
    ): StoredSpotifyAccount {
      const state = readSpotifyState();
      const nextAccount: StoredSpotifyAccount = {
        ...account,
        id: `spotify:${account.userId}`,
        updatedAt: new Date().toISOString(),
      };
      const nextAccounts = state.accounts.filter((entry) => entry.id !== nextAccount.id);
      nextAccounts.push(nextAccount);
      writeSpotifyState({
        primaryId: makePrimary || !state.primaryId ? nextAccount.id : state.primaryId,
        accounts: nextAccounts,
      });
      return nextAccount;
    },

    loadSpotifyAccounts(): StoredSpotifyAccount[] {
      return readSpotifyState().accounts;
    },

    getSpotifyPrimaryId(): string | null {
      return readSpotifyState().primaryId;
    },

    setSpotifyPrimary(accountId: string): boolean {
      const state = readSpotifyState();
      if (!state.accounts.some((entry) => entry.id === accountId)) {
        return false;
      }
      writeSpotifyState({ ...state, primaryId: accountId });
      return true;
    },

    removeSpotifyAccount(accountId: string): boolean {
      const state = readSpotifyState();
      if (!state.accounts.some((entry) => entry.id === accountId)) {
        return false;
      }
      const accounts = state.accounts.filter((entry) => entry.id !== accountId);
      writeSpotifyState({
        primaryId: state.primaryId === accountId ? (accounts[0]?.id ?? null) : state.primaryId,
        accounts,
      });
      return true;
    },
  };
}
