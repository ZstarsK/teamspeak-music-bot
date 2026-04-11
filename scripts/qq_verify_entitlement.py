"""Open a visible browser at y.qq.com so the user can manually verify
whether their VIP account can play 稻香 (Jay Chou) in the real QQ Music
web player.

If the browser plays the song → entitlement exists and our 104003 is a
request-signing issue.
If the browser refuses / shows a VIP modal / silently fails → the
account doesn't have entitlement OR QQ's web player hits the same wall.
"""
import sys
import time
from playwright.sync_api import sync_playwright

# Force line-buffered stdout so logs actually reach the output file
sys.stdout.reconfigure(line_buffering=True)

START_URL = "https://y.qq.com/n/ryqq/player"
SONG_URL = "https://y.qq.com/n/ryqq/songDetail/003aAYrm3GE0Ac"


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> int:
    log("[setup] launching visible Chromium")
    log(f"[setup] start URL: {START_URL}")
    log(f"[setup] song URL:  {SONG_URL}")
    log("")
    log("action required:")
    log("  1. The browser opens at the player page")
    log("  2. Make sure your VIP account is logged in (top-right avatar)")
    log("     — if not, log in now, the script will wait")
    log("  3. Once logged in, the browser will auto-navigate to 稻香")
    log("  4. Click the PLAY button and report what happens:")
    log("     (a) song plays → account has entitlement, issue is request signing")
    log("     (b) VIP modal → account needs higher tier / digital album purchase")
    log("     (c) silent failure → QQ web player has same 104003 wall")
    log("")
    log("[wait] browser stays open for 5 minutes")
    log("")

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=False)
        except Exception as e:
            log(f"[fatal] failed to launch Chromium: {e}")
            return 1

        ctx = browser.new_context(
            viewport={"width": 1400, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/132.0.0.0 Safari/537.36"
            ),
        )
        page = ctx.new_page()

        # Log every navigation so we can see if pages fail
        page.on("framenavigated", lambda f: log(f"[nav] {f.url[:120]}") if f == page.main_frame else None)
        page.on("pageerror", lambda e: log(f"[js-error] {str(e)[:200]}"))

        # Step 1: open the player page (known working)
        log(f"[goto] {START_URL}")
        try:
            page.goto(START_URL, wait_until="domcontentloaded", timeout=30_000)
            log(f"[ok] loaded: {page.url}")
        except Exception as e:
            log(f"[warn] initial goto failed: {e}")
            log("[warn] browser stays open, try manual navigation")

        # Wait briefly for auth state to settle
        time.sleep(3)

        # Check if the user is logged in via the uin cookie
        cookies = ctx.cookies()
        uin = next((c["value"] for c in cookies if c["name"] == "uin" and c["value"]), None)
        if uin:
            log(f"[auth] logged in as uin={uin}")
        else:
            log("[auth] not logged in yet — please log in via the top-right avatar")
            log("[auth] waiting up to 2 minutes for login...")
            end = time.time() + 120
            while time.time() < end:
                time.sleep(1)
                cookies = ctx.cookies()
                uin = next((c["value"] for c in cookies if c["name"] == "uin" and c["value"]), None)
                if uin:
                    log(f"[auth] detected login: uin={uin}")
                    break
            if not uin:
                log("[abort] no login detected within 2 minutes")
                time.sleep(30)  # keep browser visible
                browser.close()
                return 2

        # Step 2: navigate to the song page
        log(f"[goto] {SONG_URL}")
        try:
            page.goto(SONG_URL, wait_until="domcontentloaded", timeout=30_000)
            log(f"[ok] loaded: {page.url}")
        except Exception as e:
            log(f"[warn] song navigation failed: {e}")
            log(f"[info] current page: {page.url}")

        log("")
        log("===========================================================")
        log("browser is open on the song page — click PLAY and observe.")
        log("keeping browser open for 5 more minutes")
        log("===========================================================")

        time.sleep(300)
        browser.close()
        return 0


if __name__ == "__main__":
    sys.exit(main())
