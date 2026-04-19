import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCookieStore } from "./auth.js";

describe("cookie store", () => {
  const dirs: string[] = [];

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "tsmusicbot-cookie-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("stores multiple QQ accounts and switches primary account", () => {
    const store = createCookieStore(makeDir());
    const qqCookieA = "uin=o12345; foo=bar;";
    const qqCookieB = "uin=o67890; foo=baz;";

    const accountA = store.saveQQAccount(qqCookieA, true)!;
    const accountB = store.saveQQAccount(qqCookieB, false)!;

    expect(store.loadQQAccounts().map((entry) => entry.id)).toEqual([
      accountA.id,
      accountB.id,
    ]);
    expect(store.getQQPrimaryId()).toBe(accountA.id);
    expect(store.load("qq")).toBe(qqCookieA);

    expect(store.setQQPrimary(accountB.id)).toBe(true);
    expect(store.getQQPrimaryId()).toBe(accountB.id);
    expect(store.load("qq")).toBe(qqCookieB);
  });

  it("stores multiple NetEase accounts and switches primary account", () => {
    const store = createCookieStore(makeDir());
    const accountA = store.saveNeteaseAccount({
      uid: "1001",
      cookie: "MUSIC_U=aaa;",
      nickname: "Alice",
      avatarUrl: "https://example.com/a.png",
    }, true);
    const accountB = store.saveNeteaseAccount({
      uid: "1002",
      cookie: "MUSIC_U=bbb;",
      nickname: "Bob",
      avatarUrl: "https://example.com/b.png",
    }, false);

    expect(store.loadNeteaseAccounts().map((entry) => entry.id)).toEqual([
      accountA.id,
      accountB.id,
    ]);
    expect(store.getNeteasePrimaryId()).toBe(accountA.id);
    expect(store.load("netease")).toBe("MUSIC_U=aaa;");

    expect(store.setNeteasePrimary(accountB.id)).toBe(true);
    expect(store.getNeteasePrimaryId()).toBe(accountB.id);
    expect(store.load("netease")).toBe("MUSIC_U=bbb;");

    expect(store.removeNeteaseAccount(accountB.id)).toBe(true);
    expect(store.loadNeteaseAccounts().map((entry) => entry.id)).toEqual([
      accountA.id,
    ]);
  });
});
