"""Regression: DELETE /api/bot/:id must broadcast botRemoved so the UI drops the row.

Creates an ephemeral bot, opens the dropdown, deletes the bot via API, and
asserts the row disappears without any page reload. Does not touch any
existing user bot.
"""
import time
import requests
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"
EPHEMERAL_NAME = "rmbot_test"
EPHEMERAL_NICK = "RmBotTest"


def api(path, method="GET", **kw):
    r = getattr(requests, method.lower())(f"{BASE}{path}", timeout=10, **kw)
    r.raise_for_status()
    return r.json() if r.text else None


def cleanup():
    for b in api("/api/bot/")["bots"]:
        if b["name"] == EPHEMERAL_NAME:
            try:
                api(f"/api/bot/{b['id']}", method="DELETE")
            except Exception:
                pass


def main():
    cleanup()
    new = api(
        "/api/bot/",
        method="POST",
        json={
            "name": EPHEMERAL_NAME,
            "serverAddress": "127.0.0.1",
            "serverPort": 9987,
            "nickname": EPHEMERAL_NICK,
            "autoStart": False,
        },
    )
    bot_id = new["id"]
    print(f"[setup] created ephemeral bot {bot_id[:8]}")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                page.goto(BASE)
                page.wait_for_load_state("networkidle")
                time.sleep(0.8)

                # Open dropdown and confirm the new bot row is present
                page.locator(".bot-selector-btn").click()
                page.wait_for_selector(".bot-dropdown")
                rows_before = page.locator(".bot-dropdown-row").count()
                print(f"[ui] dropdown rows before remove: {rows_before}")

                # Match the ephemeral row by its name text
                present = (
                    page.locator(".bot-dropdown-row", has_text=EPHEMERAL_NAME).count()
                )
                assert present == 1, f"ephemeral row not found (got {present})"

                # Delete via API
                api(f"/api/bot/{bot_id}", method="DELETE")
                print("[api] deleted bot")

                # Wait up to 4s for UI to drop the row
                removed = False
                for _ in range(40):
                    if (
                        page.locator(
                            ".bot-dropdown-row", has_text=EPHEMERAL_NAME
                        ).count()
                        == 0
                    ):
                        removed = True
                        break
                    time.sleep(0.1)

                rows_after = page.locator(".bot-dropdown-row").count()
                print(f"[ui] dropdown rows after remove: {rows_after}")
                assert removed, "ephemeral row did not disappear from UI after DELETE"
                assert rows_after == rows_before - 1, (
                    f"row count mismatch: before={rows_before} after={rows_after}"
                )
                print("[PASS] bot removal propagates to UI via WS")
            finally:
                browser.close()
    finally:
        cleanup()


if __name__ == "__main__":
    main()
