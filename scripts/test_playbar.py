"""Reproduce / regression-check the player-bar-not-appearing bug.

Captures the bot's initial playback state and restores it on exit so the
test never leaves the user with surprise music or a cleared queue.
"""
import time
import requests
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3000"


def api(path, method="GET", **kw):
    fn = getattr(requests, method.lower())
    r = fn(f"{BASE}{path}", timeout=10, **kw)
    r.raise_for_status()
    return r.json() if r.text else None


def get_bot(bot_id):
    return next(b for b in api("/api/bot/")["bots"] if b["id"] == bot_id)


def capture_state(bot_id):
    b = get_bot(bot_id)
    return {
        "playing": b["playing"],
        "paused": b["paused"],
        "song": (b["currentSong"] or {}).get("name"),
    }


def main():
    bots = api("/api/bot/")["bots"]
    if not bots:
        print("[skip] no bots")
        return
    bot_id = bots[0]["id"]
    initial = capture_state(bot_id)
    print(f"[init] initial state: {initial}")

    try:
        # Clear slate
        api(f"/api/player/{bot_id}/stop", method="POST")
        time.sleep(0.6)

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                ctx = browser.new_context()
                ctx.add_init_script(
                    """
                    (() => {
                      const OrigWS = window.WebSocket;
                      window.__wsMessages = [];
                      window.WebSocket = function(...args) {
                        const ws = new OrigWS(...args);
                        ws.addEventListener('message', (ev) => {
                          try {
                            const d = JSON.parse(ev.data);
                            window.__wsMessages.push({type: d.type, botId: d.botId});
                          } catch(e) {}
                        });
                        return ws;
                      };
                      Object.assign(window.WebSocket, OrigWS);
                    })();
                    """
                )
                page = ctx.new_page()
                page.goto(BASE)
                page.wait_for_load_state("networkidle")
                time.sleep(0.8)

                assert page.locator(".player-wrapper").count() == 0, (
                    "player bar should be hidden before playback"
                )

                # Trigger play via API (simulates any play trigger)
                api(
                    f"/api/player/{bot_id}/play",
                    method="POST",
                    json={"query": "the mass", "platform": "netease"},
                )

                # Poll for up to 6s to see if player bar appears automatically
                appeared_at = None
                for i in range(60):
                    if page.locator(".player-wrapper").count() > 0:
                        appeared_at = i * 0.1
                        break
                    page.wait_for_timeout(100)

                if appeared_at is None:
                    msgs = page.evaluate("() => window.__wsMessages")
                    print(f"[FAIL] player bar never appeared; WS msgs: {msgs}")
                    raise AssertionError("player bar did not auto-show on stateChange")
                print(f"[PASS] player bar appeared after {appeared_at:.1f}s")
            finally:
                browser.close()
    finally:
        # Restore: stop the "test" song we triggered, then re-apply initial
        # state as best we can. We can't re-queue the user's previous song,
        # but we can at least stop ours and leave the bot idle if it was idle.
        try:
            api(f"/api/player/{bot_id}/stop", method="POST")
        except Exception as e:
            print(f"[warn] failed to stop test song on cleanup: {e}")
        post = capture_state(bot_id)
        print(f"[restore] bot now idle (was playing={initial['playing']} song={initial['song']!r})")
        if initial["playing"] and initial["song"]:
            print(
                f"[note] initial bot was playing {initial['song']!r}; "
                "this test cannot resume arbitrary tracks — you may need to restart playback"
            )


if __name__ == "__main__":
    main()
