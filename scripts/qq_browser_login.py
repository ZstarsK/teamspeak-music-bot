"""Open a real Chromium browser at y.qq.com, let the user log in via any
method (password / QR / QQ connect), then extract the resulting cookie
set and save it to data/cookies/qq.json. Also tests whether the cookie
actually unlocks a known VIP track (Jay Chou 稻香) against the local
QQ Music API before declaring success.

Usage:
    "C:/Users/saopig1/miniforge3/python.exe" scripts/qq_browser_login.py

Steps:
    1. A visible Chromium window opens at y.qq.com/n/ryqq/player
    2. Click the login button in the top right and log in with your
       real QQ Music account (the one that has VIP)
    3. The script POLLS cookies in the background and auto-detects
       successful login by watching for the `uin` cookie to appear
    4. Once detected, cookies are captured, tested against
       /getMusicPlay for 稻香, and saved on success
    5. If VIP still fails, cookies are NOT saved — your existing bot
       cookie stays untouched

No terminal input required — the script exits on its own when login
is detected (or after the configured timeout).
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

BOT_ROOT = Path(r"C:\Users\saopig1\Music\teamspeak music bot")
COOKIE_FILE = BOT_ROOT / "data" / "cookies" / "qq.json"
QQ_API = "http://localhost:3200"
VIP_TEST_SONGMID = "003aAYrm3GE0Ac"  # 稻香 周杰伦

# How long to wait for the user to finish logging in
LOGIN_TIMEOUT_S = 300  # 5 minutes
POLL_INTERVAL_S = 1.0
# After detecting login, wait a bit for extra cookies (e.g. qqmusic_key)
SETTLE_DELAY_S = 4.0


def qq_cookies(ctx) -> list[dict]:
    wanted_suffixes = (".qq.com", "y.qq.com", ".music.qq.com")
    return [
        c for c in ctx.cookies()
        if any(c.get("domain", "").endswith(s) or c.get("domain", "") == s.lstrip(".")
               for s in wanted_suffixes)
    ]


def cookies_to_header(cookies: list[dict]) -> str:
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies)


def cookie_has_uin(cookies: list[dict]) -> str | None:
    for c in cookies:
        if c["name"] == "uin" and c["value"]:
            return c["value"]
    return None


def test_vip_unlock(cookie_header: str) -> tuple[bool, dict]:
    try:
        r = requests.get(
            f"{QQ_API}/getMusicPlay",
            params={"songmid": VIP_TEST_SONGMID, "cookie": cookie_header},
            timeout=10,
            proxies={"http": None, "https": None},
        )
        body = r.json()
        play = body.get("data", {}).get("playUrl", {}).get(VIP_TEST_SONGMID, {})
        url = play.get("url", "")
        return (
            bool(url),
            {
                "url_length": len(url),
                "url_prefix": url[:120] if url else "",
                "error": play.get("error", ""),
            },
        )
    except Exception as e:
        return False, {"error": f"request failed: {e}"}


def main() -> int:
    print("[setup] launching visible Chromium — look for the window on your desktop")
    print("[setup] goto https://y.qq.com/n/ryqq/player")
    print()
    print("action required:")
    print("  1. Click the 登录 button (top-right) in the browser window")
    print("  2. Log in with your VIP QQ Music account (QR / password / WeChat)")
    print("  3. Do NOTHING in this terminal — the script detects login itself")
    print()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 820},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/132.0.0.0 Safari/537.36"
            ),
        )
        page = ctx.new_page()
        try:
            page.goto("https://y.qq.com/n/ryqq/player", wait_until="domcontentloaded", timeout=30_000)
        except Exception as e:
            print(f"[warn] initial navigation slow: {e}")

        print(f"[wait] polling every {POLL_INTERVAL_S}s for login (timeout {LOGIN_TIMEOUT_S}s)")
        deadline = time.time() + LOGIN_TIMEOUT_S
        uin_detected: str | None = None
        last_report = 0.0
        while time.time() < deadline:
            cks = qq_cookies(ctx)
            uin = cookie_has_uin(cks)
            if uin:
                uin_detected = uin
                print(f"[detect] uin cookie appeared: {uin}")
                break
            now = time.time()
            if now - last_report >= 15:
                remaining = int(deadline - now)
                n = len(cks)
                print(f"[wait] still waiting... {n} qq.com cookies so far, {remaining}s left")
                last_report = now
            time.sleep(POLL_INTERVAL_S)

        if not uin_detected:
            print("[abort] login not detected within timeout")
            browser.close()
            return 1

        print(f"[settle] waiting {SETTLE_DELAY_S}s for session cookies to populate")
        time.sleep(SETTLE_DELAY_S)

        cks = qq_cookies(ctx)
        cookie_header = cookies_to_header(cks)
        print(f"[capture] {len(cks)} cookies, {len(cookie_header)} char header")

        qm_key = next((c["value"] for c in cks if c["name"] == "qqmusic_key"), "")
        qm_keyst = next((c["value"] for c in cks if c["name"] == "qm_keyst"), "")
        p_skey = next((c["value"] for c in cks if c["name"] == "p_skey"), "")
        print(f"[capture] qqmusic_key: {'present (' + qm_key[:20] + '...)' if qm_key else '(absent)'}")
        print(f"[capture] qm_keyst   : {'present (' + qm_keyst[:20] + '...)' if qm_keyst else '(absent)'}")
        print(f"[capture] p_skey     : {'present' if p_skey else '(absent)'}")

        print("\n[test] calling /getMusicPlay for 稻香 with captured cookie...")
        unlocked, details = test_vip_unlock(cookie_header)
        print(f"[test] unlocked: {unlocked}")
        print(f"[test] details: {details}")

        if not unlocked:
            print(
                "\n[result] VIP did NOT unlock even with browser-extracted cookies.\n"
                "         Existing cookie file is UNTOUCHED.\n"
                "         Diagnosis: the login flow is not the bottleneck — the\n"
                "         account likely lacks entitlement for this specific track,\n"
                "         OR QQ requires additional session setup (gateway handshake)\n"
                "         beyond what's in the cookie itself.\n"
            )
            # Dump the full cookie set for inspection
            dump_path = BOT_ROOT / "data" / "cookies" / "qq.browser-capture.json"
            dump_path.write_text(
                json.dumps(
                    {"cookie": cookie_header, "cookieList": cks, "capturedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ")},
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            print(f"[dump] full browser cookies written to {dump_path}")
            print("       (for side-by-side comparison with OAuth-derived cookies)")
            browser.close()
            return 2

        print("\n[save] VIP unlocked. Writing cookie to bot...")
        COOKIE_FILE.write_text(
            json.dumps(
                {"cookie": cookie_header, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ")},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"[save] wrote {COOKIE_FILE}")

        try:
            r = requests.post(
                "http://localhost:3000/api/auth/cookie",
                json={"platform": "qq", "cookie": cookie_header},
                timeout=5,
                proxies={"http": None, "https": None},
            )
            print(f"[notify] /api/auth/cookie POST: {r.status_code}")
        except Exception as e:
            print(f"[notify] failed to push cookie to bot: {e}")
            print("         Restart the bot to pick up the new cookie from disk.")

        print("\n[done] VIP should now work through the bot. Try playing 稻香!")
        browser.close()
        return 0


if __name__ == "__main__":
    import sys

    sys.exit(main())
