import fs from "node:fs";
import path from "node:path";

export interface StoredQQAccount {
  id: string;
  uin: string;
  cookie: string;
  updatedAt: string;
}

export interface CookieStore {
  save(platform: "netease" | "qq" | "bilibili", cookie: string): void;
  load(platform: "netease" | "qq" | "bilibili"): string;
  saveQQAccount(cookie: string, makePrimary?: boolean): StoredQQAccount | null;
  loadQQAccounts(): StoredQQAccount[];
  getQQPrimaryId(): string | null;
  setQQPrimary(accountId: string): boolean;
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
  };
}
