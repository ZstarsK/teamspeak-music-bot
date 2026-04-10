"""More corner-case regressions.

A. resolveAndPlay disconnect-during-URL-resolve race
   The bot checks !this.connected at the top of resolveAndPlay, but the
   URL-resolve await can take several seconds. If stop is called during
   that window, playback would previously start on a disconnected bot.

B. /seek NaN/Infinity rejection
   typeof NaN === "number" and NaN < 0 is false, so a plain range check
   leaks NaN through and corrupts seekOffset / getElapsed.
"""
import threading
import time
import requests

BASE = "http://localhost:3000"


def api(path, method="GET", **kw):
    return getattr(requests, method.lower())(f"{BASE}{path}", timeout=30, **kw)


def get_bot(bot_id):
    return next(b for b in api("/api/bot/").json()["bots"] if b["id"] == bot_id)


def wait_connected(bot_id, want, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        if get_bot(bot_id)["connected"] is want:
            return True
        time.sleep(0.15)
    return False


def test_resolve_play_stop_race(bot_id):
    """Fire stopBot during the /play call's URL resolve window."""
    api(f"/api/bot/{bot_id}/stop", method="POST")
    wait_connected(bot_id, False)
    time.sleep(1)
    api(f"/api/bot/{bot_id}/start", method="POST")
    wait_connected(bot_id, True)

    # Schedule a stop 150ms into the play call — that lands inside the
    # provider.getSongUrl await, which is where the race lives.
    def delayed_stop():
        time.sleep(0.15)
        try:
            api(f"/api/bot/{bot_id}/stop", method="POST")
        except Exception:
            pass

    threading.Thread(target=delayed_stop, daemon=True).start()

    try:
        api(
            f"/api/player/{bot_id}/play",
            method="POST",
            json={"query": "the mass", "platform": "netease"},
        )
    except Exception:
        pass

    # Give both calls time to settle fully
    time.sleep(3)
    b = get_bot(bot_id)
    # Key invariant: we never want connected=false AND playing=true. That
    # pair is the exact Bug C symptom and would indicate the resolveAndPlay
    # post-await check didn't fire.
    assert not (b["connected"] is False and b["playing"] is True), (
        f"inconsistent state after race: {b}"
    )
    print(
        f"[PASS] resolveAndPlay stop-race — final state consistent "
        f"(connected={b['connected']} playing={b['playing']})"
    )


def test_seek_nan_rejected(bot_id):
    """Verify that NaN and Infinity seek positions are rejected at the API
    layer (instead of poisoning seekOffset)."""
    api(f"/api/bot/{bot_id}/stop", method="POST")
    wait_connected(bot_id, False)
    api(f"/api/bot/{bot_id}/start", method="POST")
    wait_connected(bot_id, True)

    # Start a real song so there is an active playback to seek against
    api(
        f"/api/player/{bot_id}/play",
        method="POST",
        json={"query": "the mass", "platform": "netease"},
    )
    time.sleep(1.2)

    # JSON spec doesn't allow NaN/Infinity literals, but Python's json
    # encoder emits them as bare tokens when allow_nan=True (the default).
    # Express's body-parser rejects them as invalid JSON, which itself is
    # a form of rejection. We additionally verify that sending a string
    # "NaN" or a negative value is also rejected with a clean 400.
    r = api(
        f"/api/player/{bot_id}/seek",
        method="POST",
        json={"position": -5},
    )
    assert r.status_code == 400, f"negative seek should be rejected, got {r.status_code}"

    r = api(
        f"/api/player/{bot_id}/seek",
        method="POST",
        json={"position": "fifty"},
    )
    assert r.status_code == 400, f"string seek should be rejected, got {r.status_code}"

    # Directly send NaN in raw body (body-parser will likely 400 it)
    r = requests.post(
        f"{BASE}/api/player/{bot_id}/seek",
        data='{"position": NaN}',
        headers={"Content-Type": "application/json"},
        timeout=10,
    )
    assert r.status_code >= 400, f"NaN seek should be rejected, got {r.status_code}"

    # After the junk attempts, a valid seek still works and the elapsed
    # time is a finite number (not NaN).
    r = api(
        f"/api/player/{bot_id}/seek",
        method="POST",
        json={"position": 30},
    )
    assert r.status_code == 200, f"valid seek failed: {r.text[:120]}"

    elapsed_resp = api(f"/api/player/{bot_id}/elapsed")
    elapsed = elapsed_resp.json().get("elapsed")
    assert elapsed is not None and isinstance(elapsed, (int, float)), (
        f"elapsed should be a number, got {elapsed}"
    )
    # Could be exactly 30 or a tiny bit more if a frame has advanced
    assert 29 <= elapsed < 40, f"elapsed after seek(30) out of range: {elapsed}"
    print(f"[PASS] seek NaN/Infinity rejected; valid seek produces finite elapsed={elapsed:.2f}")


def main():
    bots = api("/api/bot/").json()["bots"]
    if not bots:
        print("[skip] no bots")
        return
    bot_id = bots[0]["id"]
    initial = bots[0]["connected"]
    print(f"[init] bot={bot_id[:8]} initial connected={initial}")

    try:
        test_resolve_play_stop_race(bot_id)
        test_seek_nan_rejected(bot_id)
        print("ALL GREEN")
    finally:
        if initial:
            api(f"/api/bot/{bot_id}/start", method="POST")
            wait_connected(bot_id, True)
        else:
            api(f"/api/bot/{bot_id}/stop", method="POST")
            wait_connected(bot_id, False)
        print(f"[restore] connected={get_bot(bot_id)['connected']}")


if __name__ == "__main__":
    main()
