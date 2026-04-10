"""Stress-test two bots playing music concurrently on the same TS server.

Creates two temporary bots (or reuses existing named ones), starts them,
plays music on both, and polls /api/bot/ every 2 seconds to detect when
(if) either bot disconnects or stops playing. Cleans up on exit.

Usage:
    python scripts/test_multibot.py --minutes 3
    python scripts/test_multibot.py --minutes 10 --host 127.0.0.1 --port 9987
"""
import argparse
import sys
import time
from dataclasses import dataclass

import requests

API = "http://localhost:3000"
POLL_INTERVAL = 2.0
TEST_BOT_NAMES = ("mbtest1", "mbtest2")
TEST_BOT_NICKS = ("MBTest1", "MBTest2")
QUERIES = ("the mass", "lofi")  # one different song per bot


@dataclass
class BotSnapshot:
    t: float
    connected: bool
    playing: bool
    song: str | None


def api_get(path: str):
    r = requests.get(f"{API}{path}", timeout=5)
    r.raise_for_status()
    return r.json()


def api_post(path: str, json=None):
    r = requests.post(f"{API}{path}", json=json, timeout=15)
    r.raise_for_status()
    return r.json()


def api_delete(path: str):
    r = requests.delete(f"{API}{path}", timeout=10)
    r.raise_for_status()
    return r.json()


def cleanup_existing(names: tuple[str, ...]) -> None:
    bots = api_get("/api/bot/")["bots"]
    for b in bots:
        if b["name"] in names:
            try:
                api_post(f"/api/player/{b['id']}/stop")
            except Exception:
                pass
            try:
                api_delete(f"/api/bot/{b['id']}")
                print(f"[cleanup] removed existing bot {b['name']} ({b['id']})")
            except Exception as e:
                print(f"[cleanup] failed to remove {b['name']}: {e}")


def create_bot(name: str, nickname: str, host: str, port: int) -> str:
    res = api_post(
        "/api/bot/",
        json={
            "name": name,
            "serverAddress": host,
            "serverPort": port,
            "nickname": nickname,
            "autoStart": False,
        },
    )
    bot_id = res["id"]
    print(f"[create] {name} -> {bot_id}")
    return bot_id


def start_bot(bot_id: str) -> None:
    api_post(f"/api/bot/{bot_id}/start")


def play(bot_id: str, query: str) -> None:
    api_post(f"/api/player/{bot_id}/play", json={"query": query, "platform": "netease"})


def snapshot(bot_id: str, t0: float) -> BotSnapshot:
    bots = api_get("/api/bot/")["bots"]
    b = next((x for x in bots if x["id"] == bot_id), None)
    if not b:
        return BotSnapshot(time.time() - t0, False, False, None)
    song = b["currentSong"]["name"] if b.get("currentSong") else None
    return BotSnapshot(time.time() - t0, b["connected"], b["playing"], song)


def run(minutes: float, host: str, port: int) -> int:
    print(f"[setup] duration={minutes}min host={host}:{port}")

    cleanup_existing(TEST_BOT_NAMES)

    bot_ids = [
        create_bot(TEST_BOT_NAMES[0], TEST_BOT_NICKS[0], host, port),
        create_bot(TEST_BOT_NAMES[1], TEST_BOT_NICKS[1], host, port),
    ]

    # Start both, allowing a small stagger to avoid handshake collision
    for i, bid in enumerate(bot_ids):
        start_bot(bid)
        print(f"[start] bot{i+1} started")
        time.sleep(1.5)

    # Wait until both are connected (or bail after 15s)
    deadline = time.time() + 15
    while time.time() < deadline:
        bots = {b["id"]: b for b in api_get("/api/bot/")["bots"]}
        if all(bots[b]["connected"] for b in bot_ids):
            print("[start] both bots connected")
            break
        time.sleep(0.5)
    else:
        print("[fatal] bots did not both come online in 15s")
        cleanup_existing(TEST_BOT_NAMES)
        return 2

    # Kick off playback on both
    for i, bid in enumerate(bot_ids):
        play(bid, QUERIES[i])
        print(f"[play] bot{i+1} -> {QUERIES[i]!r}")

    t0 = time.time()
    end = t0 + minutes * 60
    first_drop: dict[str, float] = {}
    last_state: dict[str, BotSnapshot] = {}

    print(f"[monitor] polling every {POLL_INTERVAL}s for {minutes} min...")
    print(f"{'time':>7}  {'bot1':<40}  {'bot2':<40}")

    def fmt(snap: BotSnapshot) -> str:
        flag = ("C" if snap.connected else "-") + ("P" if snap.playing else "-")
        song = (snap.song or "").replace("\n", " ")[:30]
        return f"{flag} {song}"

    try:
        while time.time() < end:
            snaps = [snapshot(bid, t0) for bid in bot_ids]
            elapsed = int(time.time() - t0)
            row = f"{elapsed:>6}s  {fmt(snaps[0]):<40}  {fmt(snaps[1]):<40}"
            # Only print when state changes or every 10s
            changed = False
            for bid, s in zip(bot_ids, snaps):
                prev = last_state.get(bid)
                if (prev is None
                        or prev.connected != s.connected
                        or prev.playing != s.playing
                        or prev.song != s.song):
                    changed = True
                last_state[bid] = s
                if not s.connected and bid not in first_drop:
                    first_drop[bid] = s.t
            if changed or elapsed % 10 == 0:
                print(row)

            # If both stopped playing but are still connected, re-queue the same song
            for i, (bid, s) in enumerate(zip(bot_ids, snaps)):
                if s.connected and not s.playing:
                    try:
                        play(bid, QUERIES[i])
                    except Exception as e:
                        print(f"[warn] re-play bot{i+1} failed: {e}")

            time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        print("\n[abort] interrupted")

    # Summary
    total = time.time() - t0
    print()
    print("=" * 60)
    print(f"Total observed time: {total:.1f}s")
    for i, bid in enumerate(bot_ids):
        drop = first_drop.get(bid)
        if drop is None:
            print(f"  bot{i+1} ({TEST_BOT_NICKS[i]}): stayed connected the whole run")
        else:
            print(f"  bot{i+1} ({TEST_BOT_NICKS[i]}): FIRST DISCONNECT at t+{drop:.1f}s")
    print("=" * 60)

    # Cleanup
    cleanup_existing(TEST_BOT_NAMES)
    print("[cleanup] done")

    return 0 if not first_drop else 1


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--minutes", type=float, default=3.0)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=9987)
    args = p.parse_args()
    try:
        return run(args.minutes, args.host, args.port)
    except requests.HTTPError as e:
        print(f"[http-error] {e} body={e.response.text[:200] if e.response else ''}")
        return 3


if __name__ == "__main__":
    sys.exit(main())
