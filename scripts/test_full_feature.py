"""Comprehensive feature + corner-case test for TSMusicBot against a
local TeamSpeak 3 server.

Exercises every major HTTP endpoint, the WebSocket state-broadcast path,
all music providers, bot lifecycle transitions, and a handful of races
that have burned us in the past. Designed to be safe to run against a
real installation: captures the target bot's initial connected/volume/
mode settings and restores them in `finally`.

Usage:
    "C:/Users/saopig1/miniforge3/python.exe" scripts/test_full_feature.py

Exit code: 0 if every non-skipped test passed, 1 otherwise.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Any

import requests

BASE = "http://localhost:3000"
POLL_INTERVAL = 0.15
CONNECT_TIMEOUT = 20        # tolerate occasional TS3 anti-flood grace
ANTIFLOOD_BREATHER = 1.5    # gap between rapid cycles so TS3 stays happy


# ----------------------------- HTTP helpers ---------------------------------


def api(path: str, method: str = "GET", json_body: Any = None):
    """Return (status_code, body). Never raises."""
    try:
        fn = getattr(requests, method.lower())
        r = fn(f"{BASE}{path}", json=json_body, timeout=30)
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, r.text
    except Exception as e:
        return None, f"<{type(e).__name__}: {e}>"


def get_bot(bot_id: str) -> dict | None:
    _, data = api("/api/bot/")
    if not isinstance(data, dict):
        return None
    return next((b for b in data.get("bots", []) if b["id"] == bot_id), None)


def wait_connected(bot_id: str, want: bool, timeout: float = CONNECT_TIMEOUT) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        b = get_bot(bot_id)
        if b is not None and b["connected"] is want:
            return True
        time.sleep(POLL_INTERVAL)
    return False


def start_and_wait(bot_id: str, retries: int = 2) -> bool:
    """Start the bot, tolerating transient TS3 anti-flood by retrying with
    exponential backoff. Returns True only when the bot reports connected."""
    for attempt in range(retries + 1):
        s, _ = api(f"/api/bot/{bot_id}/start", method="POST")
        if s == 200 and wait_connected(bot_id, True):
            return True
        # If /start returned an error (e.g. connect timeout from our 15s
        # deadline), back off and retry — TS3 server-side anti-flood
        # usually clears in a few seconds.
        if attempt < retries:
            time.sleep(3.0 * (attempt + 1))
            # Make sure we're fully stopped before the next attempt so
            # oldBot.disconnect() doesn't double-fire
            api(f"/api/bot/{bot_id}/stop", method="POST")
            wait_connected(bot_id, False, timeout=5)
    return False


def stop_and_wait(bot_id: str) -> bool:
    api(f"/api/bot/{bot_id}/stop", method="POST")
    return wait_connected(bot_id, False)


def assert_started(bot_id: str):
    """Helper that raises with a clear message when start fails so test
    output points at 'could not connect' rather than an empty assertion."""
    if not start_and_wait(bot_id):
        raise AssertionError(
            "could not bring bot online (TS3 server may be anti-flooding "
            "or unreachable)"
        )


# ----------------------------- test runner ----------------------------------


@dataclass
class TestResult:
    name: str
    status: str  # PASS / FAIL / ERROR / SKIP
    detail: str = ""


passed = 0
failed = 0
skipped = 0
results: list[TestResult] = []


def run(name: str, fn):
    global passed, failed
    try:
        fn()
        print(f"  [PASS] {name}")
        passed += 1
        results.append(TestResult(name, "PASS"))
    except AssertionError as e:
        print(f"  [FAIL] {name}: {e}")
        failed += 1
        results.append(TestResult(name, "FAIL", str(e)))
    except Exception as e:
        print(f"  [ERROR] {name}: {type(e).__name__}: {e}")
        failed += 1
        results.append(TestResult(name, "ERROR", f"{type(e).__name__}: {e}"))


def skip(name: str, reason: str):
    global skipped
    print(f"  [SKIP] {name}  ({reason})")
    skipped += 1
    results.append(TestResult(name, "SKIP", reason))


# ----------------------------- test groups ----------------------------------


def group_infrastructure(bot_id: str):
    print("\n== infrastructure ==")

    def t_health():
        s, d = api("/api/health")
        assert s == 200, f"health returned {s}"
        assert d.get("status") == "ok"
    run("GET /api/health", t_health)

    def t_list_bots():
        s, d = api("/api/bot/")
        assert s == 200
        assert isinstance(d.get("bots"), list)
        assert any(b["id"] == bot_id for b in d["bots"])
    run("GET /api/bot/ lists target bot", t_list_bots)

    def t_bot_config():
        s, d = api(f"/api/bot/{bot_id}/config")
        assert s == 200
        assert d["id"] == bot_id
        assert "identity" in d
        assert "serverAddress" in d and "nickname" in d
        assert "serverPassword" in d, "serverPassword field missing"
    run("GET /api/bot/:id/config returns all fields", t_bot_config)

    def t_404_on_unknown_bot():
        s, _ = api("/api/bot/does-not-exist/config")
        assert s == 404
    run("404 on unknown bot id", t_404_on_unknown_bot)

    def t_quality_shape():
        s, d = api("/api/music/quality")
        assert s == 200
        for p in ("netease", "qq", "bilibili"):
            assert p in d, f"{p} missing from quality response"
    run("GET /api/music/quality shape", t_quality_shape)


def group_auth_status():
    print("\n== auth status per platform ==")

    def t_netease_ok():
        s, d = api("/api/auth/status?platform=netease")
        assert s == 200
        assert d.get("platform") == "netease"
        assert "loggedIn" in d
    run("auth status netease", t_netease_ok)

    def t_qq_ok():
        s, d = api("/api/auth/status?platform=qq")
        assert s == 200
        assert d.get("platform") == "qq"
    run("auth status qq", t_qq_ok)

    def t_bilibili_ok():
        s, d = api("/api/auth/status?platform=bilibili")
        assert s == 200
        assert d.get("platform") == "bilibili"
    run("auth status bilibili", t_bilibili_ok)

    def t_youtube_routed():
        # Regression: /auth/status?platform=youtube used to fall through
        # to NetEase and leak the NetEase user's nickname/avatar.
        s, d = api("/api/auth/status?platform=youtube")
        assert s == 200
        assert d.get("platform") == "youtube", (
            f"youtube auth status leaked to {d.get('platform')}"
        )
    run("auth status youtube routes correctly", t_youtube_routed)

    def t_youtube_cookie_rejected():
        s, d = api(
            "/api/auth/cookie",
            method="POST",
            json_body={"platform": "youtube", "cookie": "fake"},
        )
        assert s == 400, f"youtube cookie should be rejected, got {s}: {d}"
    run("POST /auth/cookie rejects youtube", t_youtube_cookie_rejected)


def group_search():
    print("\n== multi-platform search ==")

    def search(platform: str, query: str = "test"):
        return api(f"/api/music/search?q={query}&platform={platform}&limit=1")

    def t_netease():
        s, d = search("netease")
        assert s == 200
        assert isinstance(d.get("songs"), list)
    run("netease search", t_netease)

    def t_qq():
        s, d = search("qq")
        assert s == 200
        # QQ may return 0 results if no cookie, but shouldn't error
        assert isinstance(d.get("songs"), list)
    run("qq search (empty ok)", t_qq)

    def t_bilibili():
        s, d = search("bilibili")
        assert s == 200
        assert isinstance(d.get("songs"), list)
    run("bilibili search", t_bilibili)

    def t_missing_query():
        s, _ = api("/api/music/search?platform=netease")
        assert s == 400, "missing q should 400"
    run("400 on missing query", t_missing_query)

    _, auth = api("/api/auth/status?platform=youtube")
    youtube_available = isinstance(auth, dict) and auth.get("loggedIn") is True

    if youtube_available:
        def t_youtube():
            s, d = search("youtube", "lofi")
            assert s == 200
            songs = d.get("songs", [])
            assert len(songs) >= 1, "expected at least 1 YouTube result"
            assert songs[0]["platform"] == "youtube"
        run("youtube search (yt-dlp installed)", t_youtube)
    else:
        skip("youtube search", "yt-dlp not installed")


def group_lifecycle(bot_id: str):
    print("\n== connection lifecycle ==")

    def t_stop_from_any_state():
        api(f"/api/bot/{bot_id}/stop", method="POST")
        assert wait_connected(bot_id, False), "bot did not stop"
        b = get_bot(bot_id)
        assert not b["playing"], "playing should be false after stop"
    run("stop from any state \u2192 disconnected+idle", t_stop_from_any_state)

    def t_start_completes_quickly():
        t0 = time.time()
        s, d = api(f"/api/bot/{bot_id}/start", method="POST")
        elapsed = time.time() - t0
        assert s == 200, f"start failed: {d}"
        assert elapsed < 10, f"start took {elapsed:.1f}s (expected <10s)"
        assert wait_connected(bot_id, True)
    run("start completes well under 15s deadline", t_start_completes_quickly)

    def t_identity_persists():
        assert_started(bot_id)
        _, cfg1 = api(f"/api/bot/{bot_id}/config")
        id1 = cfg1["identity"]
        assert id1, "identity empty after first start"
        assert stop_and_wait(bot_id)
        time.sleep(ANTIFLOOD_BREATHER)
        assert_started(bot_id)
        _, cfg2 = api(f"/api/bot/{bot_id}/config")
        assert cfg2["identity"] == id1, (
            f"identity changed across restart: {id1} \u2192 {cfg2['identity']}"
        )
    run("identity preserved across stop/start", t_identity_persists)


def group_playback(bot_id: str):
    print("\n== playback ==")

    # Bring the bot online ONCE for the whole playback group, then only
    # toggle player state (play/pause/stop) between tests. This keeps the
    # TS3 reconnect count for this group at exactly 1.
    assert_started(bot_id)

    def t_play_song():
        s, d = api(
            f"/api/player/{bot_id}/play",
            method="POST",
            json_body={"query": "the mass", "platform": "netease"},
        )
        assert s == 200, f"play failed: {d}"
        time.sleep(1.2)
        b = get_bot(bot_id)
        assert b["playing"] is True, f"not playing after /play: {b}"
        assert b["currentSong"] is not None
    run("play netease song \u2192 playing=true", t_play_song)

    def t_pause_resume():
        # Previous test left a song playing
        api(f"/api/player/{bot_id}/pause", method="POST")
        time.sleep(0.4)
        b = get_bot(bot_id)
        assert b["paused"] is True, f"pause failed: {b}"
        api(f"/api/player/{bot_id}/resume", method="POST")
        time.sleep(0.4)
        b = get_bot(bot_id)
        assert b["paused"] is False and b["playing"] is True, f"resume failed: {b}"
    run("pause \u2192 paused, resume \u2192 playing", t_pause_resume)

    def t_volume_change():
        s, _ = api(
            f"/api/player/{bot_id}/volume",
            method="POST",
            json_body={"volume": 42},
        )
        assert s == 200
        time.sleep(0.2)
        b = get_bot(bot_id)
        assert b["volume"] == 42, f"volume not applied: {b['volume']}"
    run("volume change", t_volume_change)

    def t_mode_cycle():
        for m in ("seq", "loop", "random", "rloop"):
            s, _ = api(
                f"/api/player/{bot_id}/mode", method="POST", json_body={"mode": m}
            )
            assert s == 200
            b = get_bot(bot_id)
            assert b["playMode"] == m, f"mode {m} not applied: {b['playMode']}"
    run("all four play modes apply", t_mode_cycle)

    def t_queue_endpoint():
        s, d = api(f"/api/player/{bot_id}/queue")
        assert s == 200
        assert isinstance(d.get("queue"), list)
        assert "status" in d
    run("GET /player/:id/queue returns queue+status", t_queue_endpoint)

    def t_elapsed_endpoint():
        s, d = api(f"/api/player/{bot_id}/elapsed")
        assert s == 200
        elapsed = d.get("elapsed")
        assert isinstance(elapsed, (int, float)) and elapsed >= 0, (
            f"elapsed should be non-negative number: {elapsed}"
        )
    run("GET /player/:id/elapsed returns finite number", t_elapsed_endpoint)

    def t_add_autoplay_on_idle():
        # This specific test needs an IDLE bot — stop first (but keep
        # connected), then add and confirm auto-play.
        api(f"/api/player/{bot_id}/stop", method="POST")
        time.sleep(0.4)
        b = get_bot(bot_id)
        assert not b["playing"] and b["queueSize"] == 0, f"setup failed: {b}"
        s, d = api(
            f"/api/player/{bot_id}/add",
            method="POST",
            json_body={"query": "the mass", "platform": "netease"},
        )
        assert s == 200
        msg = d.get("message", "") if isinstance(d, dict) else ""
        assert "Now playing" in msg, (
            f"add on idle bot should auto-play, got: {msg!r}"
        )
        time.sleep(0.8)
        b = get_bot(bot_id)
        assert b["playing"] is True, f"not playing after add: {b}"
    run("add on idle bot auto-plays", t_add_autoplay_on_idle)

    # Leave the bot in a clean state for the next group
    api(f"/api/player/{bot_id}/stop", method="POST")


def group_queue_ops(bot_id: str):
    print("\n== queue operations ==")
    assert_started(bot_id)

    def t_clear():
        api(
            f"/api/player/{bot_id}/play",
            method="POST",
            json_body={"query": "the mass", "platform": "netease"},
        )
        time.sleep(0.8)
        api(
            f"/api/player/{bot_id}/add",
            method="POST",
            json_body={"query": "lemon tree", "platform": "netease"},
        )
        time.sleep(0.6)
        b_before = get_bot(bot_id)
        assert b_before["queueSize"] >= 2, f"expected \u22652 songs: {b_before}"
        api(f"/api/player/{bot_id}/clear", method="POST")
        time.sleep(0.4)
        b_after = get_bot(bot_id)
        assert b_after["queueSize"] == 0
    run("clear queue empties it", t_clear)

    def t_play_at_invalid_preserves_playback():
        api(
            f"/api/player/{bot_id}/play",
            method="POST",
            json_body={"query": "the mass", "platform": "netease"},
        )
        time.sleep(1.2)
        assert get_bot(bot_id)["playing"]
        s, _ = api(
            f"/api/player/{bot_id}/play-at",
            method="POST",
            json_body={"index": 9999},
        )
        assert s == 400, f"invalid index should 400, got {s}"
        time.sleep(0.4)
        b = get_bot(bot_id)
        assert b["playing"], "invalid play-at killed the current song"
    run("invalid play-at preserves current playback", t_play_at_invalid_preserves_playback)

    def t_play_at_negative_rejected():
        s, _ = api(
            f"/api/player/{bot_id}/play-at",
            method="POST",
            json_body={"index": -1},
        )
        assert s == 400
    run("play-at with negative index rejected", t_play_at_negative_rejected)

    api(f"/api/player/{bot_id}/stop", method="POST")


def group_input_validation(bot_id: str):
    print("\n== HTTP input validation ==")

    def t_volume_out_of_range():
        for bad in (150, -10, 1000, -1):
            s, _ = api(
                f"/api/player/{bot_id}/volume",
                method="POST",
                json_body={"volume": bad},
            )
            assert s == 400, f"volume={bad} should 400, got {s}"
    run("volume out-of-range rejected (400)", t_volume_out_of_range)

    def t_volume_wrong_type():
        for bad in ("50", None, [50], {"v": 50}):
            s, _ = api(
                f"/api/player/{bot_id}/volume",
                method="POST",
                json_body={"volume": bad},
            )
            assert s == 400, f"volume={bad!r} should 400, got {s}"
    run("volume wrong-type rejected (400)", t_volume_wrong_type)

    def t_volume_missing():
        s, _ = api(
            f"/api/player/{bot_id}/volume", method="POST", json_body={}
        )
        assert s == 400
    run("volume missing rejected (400)", t_volume_missing)

    def t_volume_valid():
        for good in (0, 1, 50, 100):
            s, _ = api(
                f"/api/player/{bot_id}/volume",
                method="POST",
                json_body={"volume": good},
            )
            assert s == 200, f"volume={good} should succeed, got {s}"
            b = get_bot(bot_id)
            assert b["volume"] == good, f"volume not applied: {b['volume']}"
    run("valid volumes apply", t_volume_valid)

    def t_mode_invalid():
        for bad in ("bogus", "", None, 1, "SEQ"):
            s, _ = api(
                f"/api/player/{bot_id}/mode",
                method="POST",
                json_body={"mode": bad},
            )
            assert s == 400, f"mode={bad!r} should 400, got {s}"
    run("mode invalid rejected (400)", t_mode_invalid)

    def t_mode_missing():
        s, _ = api(f"/api/player/{bot_id}/mode", method="POST", json_body={})
        assert s == 400
    run("mode missing rejected (400)", t_mode_missing)


def group_disconnect_corners(bot_id: str):
    print("\n== disconnected-bot corners ==")

    def t_play_rejected():
        assert stop_and_wait(bot_id)
        s, d = api(
            f"/api/player/{bot_id}/play",
            method="POST",
            json_body={"query": "x", "platform": "netease"},
        )
        assert s >= 400
        err = (d.get("error") or "") if isinstance(d, dict) else ""
        assert "not connected" in err.lower(), f"expected 'not connected' error: {d}"
    run("play rejected while disconnected", t_play_rejected)

    def t_add_rejected():
        s, _ = api(
            f"/api/player/{bot_id}/add",
            method="POST",
            json_body={"query": "x", "platform": "netease"},
        )
        assert s >= 400
    run("add rejected while disconnected", t_add_rejected)

    def t_next_rejected():
        s, _ = api(f"/api/player/{bot_id}/next", method="POST")
        assert s >= 400
    run("next rejected while disconnected", t_next_rejected)

    def t_volume_allowed():
        s, _ = api(
            f"/api/player/{bot_id}/volume",
            method="POST",
            json_body={"volume": 60},
        )
        assert s == 200, "volume should work while disconnected"
    run("volume allowed while disconnected", t_volume_allowed)

    def t_mode_allowed():
        s, _ = api(
            f"/api/player/{bot_id}/mode", method="POST", json_body={"mode": "random"}
        )
        assert s == 200, "mode should work while disconnected"
    run("mode allowed while disconnected", t_mode_allowed)

    def t_clear_allowed():
        s, _ = api(f"/api/player/{bot_id}/clear", method="POST")
        assert s == 200, "clear should work while disconnected"
    run("clear allowed while disconnected", t_clear_allowed)

    def t_player_state_clean():
        b = get_bot(bot_id)
        assert not b["playing"] and not b["paused"], f"state leak: {b}"
    run("no player state leak while disconnected", t_player_state_clean)


def group_seek(bot_id: str):
    print("\n== seek validation ==")

    def t_negative():
        s, _ = api(
            f"/api/player/{bot_id}/seek", method="POST", json_body={"position": -5}
        )
        assert s == 400
    run("negative seek rejected", t_negative)

    def t_string():
        s, _ = api(
            f"/api/player/{bot_id}/seek",
            method="POST",
            json_body={"position": "abc"},
        )
        assert s == 400
    run("string seek rejected", t_string)

    def t_nan_literal():
        r = requests.post(
            f"{BASE}/api/player/{bot_id}/seek",
            data='{"position": NaN}',
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        assert r.status_code >= 400, f"NaN literal accepted: {r.status_code}"
    run("NaN literal seek rejected", t_nan_literal)

    def t_valid_seek():
        # Seek needs a live connection + playing song. The disconnect-
        # corners group right before this one left the bot disconnected.
        assert_started(bot_id)
        api(
            f"/api/player/{bot_id}/play",
            method="POST",
            json_body={"query": "the mass", "platform": "netease"},
        )
        time.sleep(1.5)
        s, _ = api(
            f"/api/player/{bot_id}/seek",
            method="POST",
            json_body={"position": 25},
        )
        assert s == 200
        time.sleep(0.5)
        _, d = api(f"/api/player/{bot_id}/elapsed")
        elapsed = d.get("elapsed")
        assert isinstance(elapsed, (int, float)) and 24 <= elapsed < 40, (
            f"elapsed after seek(25) wrong: {elapsed}"
        )
        api(f"/api/player/{bot_id}/stop", method="POST")
    run("valid seek produces finite elapsed", t_valid_seek)


def group_races(bot_id: str):
    print("\n== race conditions ==")

    def t_disconnect_during_connect():
        assert stop_and_wait(bot_id)
        time.sleep(ANTIFLOOD_BREATHER)

        def delayed_stop():
            time.sleep(0.2)
            api(f"/api/bot/{bot_id}/stop", method="POST")

        threading.Thread(target=delayed_stop, daemon=True).start()
        api(f"/api/bot/{bot_id}/start", method="POST")
        time.sleep(2)
        b = get_bot(bot_id)
        assert not (b["connected"] is False and b["playing"] is True), (
            f"inconsistent state: {b}"
        )
    run("disconnect during connect", t_disconnect_during_connect)

    def t_stop_during_url_resolve():
        assert stop_and_wait(bot_id)
        time.sleep(ANTIFLOOD_BREATHER)
        assert_started(bot_id)

        def delayed_stop():
            time.sleep(0.15)
            api(f"/api/bot/{bot_id}/stop", method="POST")

        threading.Thread(target=delayed_stop, daemon=True).start()
        api(
            f"/api/player/{bot_id}/play",
            method="POST",
            json_body={"query": "the mass", "platform": "netease"},
        )
        time.sleep(3)
        b = get_bot(bot_id)
        assert not (b["connected"] is False and b["playing"] is True), (
            f"inconsistent state: {b}"
        )
    run("stop during URL resolve", t_stop_during_url_resolve)

    def t_rapid_volume_change():
        # Volume is a config-only command and works while disconnected,
        # so this test deliberately doesn't call assert_started — we're
        # validating the API's last-write-wins behavior, not the TS
        # transport. That also spares the TS3 anti-flood budget.
        for v in (10, 25, 50, 75, 100, 1):
            s, _ = api(
                f"/api/player/{bot_id}/volume",
                method="POST",
                json_body={"volume": v},
            )
            assert s == 200, f"volume POST failed: {s}"
        time.sleep(0.3)
        b = get_bot(bot_id)
        assert b["volume"] == 1, f"final volume wrong: {b['volume']}"
    run("rapid volume changes converge", t_rapid_volume_change)


def group_websocket(bot_id: str):
    print("\n== websocket broadcasts ==")
    try:
        from websocket import create_connection
    except Exception as e:
        skip("websocket state broadcasts", f"websocket lib unavailable: {e}")
        return

    try:
        ws = create_connection("ws://localhost:3000/ws", timeout=5)
    except Exception as e:
        skip("websocket state broadcasts", f"connect failed: {e}")
        return

    ws.settimeout(0.3)
    messages: list[dict] = []
    stop_reader = threading.Event()

    def reader():
        while not stop_reader.is_set():
            try:
                raw = ws.recv()
                if not raw:
                    break
                try:
                    messages.append(json.loads(raw))
                except Exception:
                    pass
            except Exception:
                # recv() timeout or closed — keep trying until stop_reader
                if stop_reader.is_set():
                    break
                continue

    reader_thread = threading.Thread(target=reader, daemon=True)
    reader_thread.start()

    try:
        def t_init():
            time.sleep(0.6)
            types = [m.get("type") for m in messages]
            assert "init" in types, f"no init message; got: {types}"
        run("init message on connect", t_init)

        def t_state_change_on_play():
            assert_started(bot_id)
            messages.clear()
            api(
                f"/api/player/{bot_id}/play",
                method="POST",
                json_body={"query": "the mass", "platform": "netease"},
            )
            time.sleep(1.5)
            types = [m.get("type") for m in messages]
            assert "stateChange" in types, (
                f"no stateChange after play; got types: {types}"
            )
            api(f"/api/player/{bot_id}/stop", method="POST")
        run("stateChange broadcast on play", t_state_change_on_play)

        def t_bot_disconnected_event():
            assert_started(bot_id)
            messages.clear()
            api(f"/api/bot/{bot_id}/stop", method="POST")
            time.sleep(1.5)
            types = [m.get("type") for m in messages]
            assert "botDisconnected" in types or "stateChange" in types, (
                f"no disconnect event; got: {types}"
            )
        run("botDisconnected event on stop", t_bot_disconnected_event)
    finally:
        stop_reader.set()
        try:
            ws.close()
        except Exception:
            pass


# ----------------------------- main ----------------------------------------


def main() -> int:
    _, data = api("/api/bot/")
    if not isinstance(data, dict) or not data.get("bots"):
        print("[fatal] no bots registered — create one via the WebUI first")
        return 2

    target = data["bots"][0]
    bot_id = target["id"]
    initial_connected = target["connected"]
    initial_volume = target["volume"]
    initial_mode = target["playMode"]

    print(f"[init] target bot  = {bot_id[:8]}  ({target['name']})")
    print(
        f"[init] initial state: connected={initial_connected} "
        f"volume={initial_volume} mode={initial_mode}"
    )

    try:
        # Read-only / no-lifecycle groups first — they don't consume TS3
        # anti-flood budget.
        group_infrastructure(bot_id)
        group_auth_status()
        group_search()

        # Lifecycle-heavy groups — interleave with small breathers so the
        # TS3 server's per-IP reconnect limit doesn't start throttling us.
        group_lifecycle(bot_id)
        time.sleep(ANTIFLOOD_BREATHER)

        group_playback(bot_id)
        time.sleep(ANTIFLOOD_BREATHER)

        group_queue_ops(bot_id)
        time.sleep(ANTIFLOOD_BREATHER)

        group_input_validation(bot_id)
        group_disconnect_corners(bot_id)
        group_seek(bot_id)
        time.sleep(ANTIFLOOD_BREATHER)

        group_races(bot_id)
        # Extra breather before websocket group — races is the heaviest
        # consumer of TS3 reconnect budget (disconnect-during-connect and
        # stop-during-url-resolve each burn one cycle), and the websocket
        # group needs a clean reconnect to observe live state broadcasts.
        time.sleep(ANTIFLOOD_BREATHER * 3)

        group_websocket(bot_id)
    finally:
        # Restore initial state — this runs even if a test raised
        try:
            api(
                f"/api/player/{bot_id}/volume",
                method="POST",
                json_body={"volume": initial_volume},
            )
            api(
                f"/api/player/{bot_id}/mode",
                method="POST",
                json_body={"mode": initial_mode},
            )
            api(f"/api/player/{bot_id}/stop", method="POST")
            if initial_connected:
                start_and_wait(bot_id)
            else:
                stop_and_wait(bot_id)
        except Exception as e:
            print(f"[warn] restore failed: {e}")

    print()
    print("=" * 60)
    print(f"  PASSED:  {passed}")
    print(f"  FAILED:  {failed}")
    print(f"  SKIPPED: {skipped}")
    print("=" * 60)

    if failed > 0:
        print("\nFailed tests:")
        for r in results:
            if r.status in ("FAIL", "ERROR"):
                print(f"  [{r.status}] {r.name}: {r.detail}")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    import sys

    sys.exit(main())
