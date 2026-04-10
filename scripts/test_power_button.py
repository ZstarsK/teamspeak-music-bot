"""E2E: the new power button in the Bot Selector dropdown toggles bot connected state.

Captures the target bot's initial connected state and restores it on exit
(including on assertion failure), so running this test never pollutes the
user's current bot setup.
"""
import time
import requests
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def get_bot(bot_id):
    return next(b for b in requests.get(f"{BASE}/api/bot/").json()["bots"] if b["id"] == bot_id)


def wait_for_connected(bot_id, want: bool, timeout_s: float = 12.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if get_bot(bot_id)["connected"] is want:
            return True
        time.sleep(0.2)
    return False


def set_connected(bot_id, want: bool) -> None:
    """Force the bot into the given connected state via API."""
    current = get_bot(bot_id)["connected"]
    if current == want:
        return
    endpoint = "start" if want else "stop"
    requests.post(f"{BASE}/api/bot/{bot_id}/{endpoint}")
    wait_for_connected(bot_id, want)


def main():
    bots = requests.get(f"{BASE}/api/bot/").json()["bots"]
    if not bots:
        print("[skip] no bots registered, nothing to test")
        return
    target = bots[0]
    bot_id = target["id"]
    initial_connected = target["connected"]
    print(f"[init] target bot {target['name']} ({bot_id[:8]}), initial connected={initial_connected}")

    try:
        # Force bot disconnected before the test
        set_connected(bot_id, False)
        assert not get_bot(bot_id)["connected"], "bot should be disconnected at start"

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                page.goto(BASE)
                page.wait_for_load_state("networkidle")
                time.sleep(0.6)

                # Open dropdown
                page.locator(".bot-selector-btn").click()
                page.wait_for_selector(".bot-power-btn")

                # Click the power button to start
                page.locator(".bot-power-btn").first.click()
                print("[ui] clicked power (start)")

                assert wait_for_connected(bot_id, True), "bot should be connected after clicking start"
                print("[api] bot connected = True")

                # Let UI catch up via WS then re-open the dropdown to re-check class
                time.sleep(1.0)
                page.locator(".bot-selector-btn").click()  # close
                time.sleep(0.2)
                page.locator(".bot-selector-btn").click()  # reopen
                page.wait_for_selector(".bot-power-btn.online", timeout=3000)
                print("[ui] power button now shows .online class")

                # Click again to stop
                page.locator(".bot-power-btn.online").first.click()
                print("[ui] clicked power (stop)")

                assert wait_for_connected(bot_id, False), "bot should be disconnected after clicking stop"
                print("[api] bot connected = False")

                print("[PASS] power button toggles bot connection")
            finally:
                browser.close()
    finally:
        # Always restore the initial state so the test never leaves the bot
        # in an unexpected place
        set_connected(bot_id, initial_connected)
        final = get_bot(bot_id)["connected"]
        print(f"[restore] bot connected={final} (initial was {initial_connected})")
        if final != initial_connected:
            print("[warn] failed to restore initial connected state")


if __name__ == "__main__":
    main()
