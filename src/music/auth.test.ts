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
});
