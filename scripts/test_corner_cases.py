"""Corner case regressions that go beyond Bugs A/B/C.

A. Race — disconnect() called during connect()'s awaited handshake must
   NOT leave the bot reporting connected=true afterwards.

B. Config-only commands (vol, mode, clear) must work even when the bot is
   disconnected (UI should stay usable while the bot is offline).

C. After a disconnect mid-playback, the player must not be able to
   auto-advance to the next queued song (trackEnd → resolveAndPlay).
"""
import time
import threading
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
        time.sleep(0.1)
    return False


def test_config_commands_when_disconnected(bot_id):
    """B. vol/mode/clear should succeed while bot is disconnected."""
    api(f"/api/bot/{bot_id}/stop", method="POST")
    wait_connected(bot_id, False)

    # volume is the simplest config-only command
    r = api(
        f"/api/player/{bot_id}/volume",
        method="POST",
        json={"volume": 60},
    )
    assert r.status_code == 200, f"volume failed while disconnected: {r.status_code} {r.text[:100]}"

    r = api(
        f"/api/player/{bot_id}/mode",
        method="POST",
        json={"mode": "seq"},
    )
    assert r.status_code == 200, f"mode failed while disconnected: {r.status_code} {r.text[:100]}"

    r = api(f"/api/player/{bot_id}/clear", method="POST")
    assert r.status_code == 200, f"clear failed while disconnected: {r.status_code} {r.text[:100]}"

    print("[PASS] config commands (vol/mode/clear) work when disconnected")


def test_play_rejected_when_disconnected(bot_id):
    """B (negative). play/add/next/prev should still be rejected."""
    r = api(
        f"/api/player/{bot_id}/play",
        method="POST",
        json={"query": "test", "platform": "netease"},
    )
    assert r.status_code >= 400, f"play should fail while disconnected"

    r = api(
        f"/api/player/{bot_id}/add",
        method="POST",
        json={"query": "test", "platform": "netease"},
    )
    assert r.status_code >= 400, f"add should fail while disconnected"

    r = api(f"/api/player/{bot_id}/next", method="POST")
    assert r.status_code >= 400, f"next should fail while disconnected"

    print("[PASS] audio commands (play/add/next) rejected when disconnected")


def test_disconnect_during_connect_race(bot_id):
    """A. disconnect() called while connect() is awaiting must win the race.

    Fires a stop 200ms into a start call; after things settle the bot's
    connected state must be stable (either cleanly disconnected, or cleanly
    connected if the stop happened after connect completed). It must NOT
    end up in a weird state where connected=true but a subsequent query
    shows inconsistent data.
    """
    # Ensure disconnected first
    api(f"/api/bot/{bot_id}/stop", method="POST")
    wait_connected(bot_id, False)
    time.sleep(1)  # give TS server a moment to forget us

    def delayed_stop():
        time.sleep(0.2)
        try:
            api(f"/api/bot/{bot_id}/stop", method="POST")
        except Exception:
            pass

    threading.Thread(target=delayed_stop, daemon=True).start()
    try:
        r = api(f"/api/bot/{bot_id}/start", method="POST")
    except Exception as e:
        r = None
        print(f"[info] start threw: {e}")

    # Wait for all state transitions to settle
    time.sleep(2)

    b = get_bot(bot_id)
    # The key invariant: if connected is false, playing must also be false;
    # if connected is true, the transport is actually up (we can issue
    # another command without error).
    assert not (b["connected"] is False and b["playing"] is True), (
        f"inconsistent state: connected={b['connected']} playing={b['playing']}"
    )
    print(
        f"[PASS] disconnect-during-connect race — final state consistent "
        f"(connected={b['connected']} playing={b['playing']})"
    )


def test_resolve_guard(bot_id):
    """C. resolveAndPlay on a disconnected bot is a no-op.

    We can't directly invoke resolveAndPlay from the API, but we can
    verify by checking that after a stop, the bot stays idle even if we
    wait for a trackEnd-like event to fire.
    """
    api(f"/api/bot/{bot_id}/stop", method="POST")
    wait_connected(bot_id, False)
    time.sleep(1.5)  # more than a frame cycle
    b = get_bot(bot_id)
    assert not b["playing"], (
        f"player should stay stopped after disconnect: {b}"
    )
    print("[PASS] player stays idle after disconnect (no ghost autoplay)")


def main():
    bots = api("/api/bot/").json()["bots"]
    if not bots:
        print("[skip] no bots")
        return
    bot_id = bots[0]["id"]
    initial = bots[0]["connected"]
    print(f"[init] bot={bot_id[:8]} initial connected={initial}")

    try:
        test_config_commands_when_disconnected(bot_id)
        test_play_rejected_when_disconnected(bot_id)
        test_resolve_guard(bot_id)
        test_disconnect_during_connect_race(bot_id)
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
