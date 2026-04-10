import { describe, it, expect, beforeEach } from "vitest";
import { PlayQueue, type QueuedSong, PlayMode } from "./queue.js";

function makeSong(id: string, name: string = id): QueuedSong {
  return {
    id,
    name,
    artist: "Artist",
    album: "Album",
    platform: "netease",
    url: `https://example.com/${id}.mp3`,
    coverUrl: `https://example.com/${id}.jpg`,
    duration: 240,
  };
}

describe("PlayQueue", () => {
  let queue: PlayQueue;

  beforeEach(() => {
    queue = new PlayQueue();
  });

  it("starts empty", () => {
    expect(queue.isEmpty()).toBe(true);
    expect(queue.current()).toBeNull();
    expect(queue.size()).toBe(0);
  });

  it("adds and retrieves songs", () => {
    queue.add(makeSong("1", "Song A"));
    queue.add(makeSong("2", "Song B"));
    expect(queue.size()).toBe(2);
    expect(queue.list()[0].name).toBe("Song A");
    expect(queue.list()[1].name).toBe("Song B");
  });

  it("plays first song when starting", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.play();
    expect(queue.current()?.id).toBe("1");
  });

  it("advances to next song in sequential mode", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.add(makeSong("3"));
    queue.play();
    expect(queue.current()?.id).toBe("1");
    const next = queue.next();
    expect(next?.id).toBe("2");
    expect(queue.current()?.id).toBe("2");
  });

  it("returns null at end in sequential mode", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("1"));
    queue.play();
    const next = queue.next();
    expect(next).toBeNull();
  });

  it("loops in loop mode", () => {
    queue.setMode(PlayMode.Loop);
    queue.add(makeSong("1"));
    queue.play();
    const next = queue.next();
    expect(next?.id).toBe("1");
  });

  it("goes to previous song", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.play();
    queue.next();
    expect(queue.current()?.id).toBe("2");
    queue.prev();
    expect(queue.current()?.id).toBe("1");
  });

  it("removes song by index", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.add(makeSong("3"));
    queue.remove(1);
    expect(queue.size()).toBe(2);
    expect(queue.list()[1].id).toBe("3");
  });

  it("removing a song before current shifts current index", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.add(makeSong("C"));
    queue.playAt(2); // playing C at index 2
    queue.remove(0); // remove A (before current)
    expect(queue.current()?.id).toBe("C"); // still on C
    expect(queue.getCurrentIndex()).toBe(1);
  });

  it("removing the currently-playing song lets next() advance to the shifted song", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.add(makeSong("C"));
    queue.add(makeSong("D"));
    queue.playAt(2); // playing C
    queue.remove(2); // remove C — D shifts into slot 2
    // Before the fix this returned null (D was silently skipped)
    expect(queue.next()?.id).toBe("D");
  });

  it("removing the only song clears the queue", () => {
    queue.add(makeSong("only"));
    queue.playAt(0);
    queue.remove(0);
    expect(queue.size()).toBe(0);
    expect(queue.current()).toBeNull();
    expect(queue.next()).toBeNull();
  });

  it("removing the last song while playing it advances to null in sequential mode", () => {
    queue.setMode(PlayMode.Sequential);
    queue.add(makeSong("A"));
    queue.add(makeSong("B"));
    queue.playAt(1); // playing B (last)
    queue.remove(1);
    expect(queue.size()).toBe(1);
    // currentIndex moved to 0, so next() should try to advance past the end
    expect(queue.next()).toBeNull();
  });

  it("clears all songs", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.clear();
    expect(queue.isEmpty()).toBe(true);
    expect(queue.current()).toBeNull();
  });

  it("random mode returns a song", () => {
    queue.setMode(PlayMode.Random);
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.add(makeSong("3"));
    queue.play();
    const next = queue.next();
    expect(next).not.toBeNull();
  });

  it("random-loop mode never returns null", () => {
    queue.setMode(PlayMode.RandomLoop);
    queue.add(makeSong("1"));
    queue.play();
    for (let i = 0; i < 10; i++) {
      expect(queue.next()).not.toBeNull();
    }
  });

  it("playAt jumps to specific index", () => {
    queue.add(makeSong("1"));
    queue.add(makeSong("2"));
    queue.add(makeSong("3"));
    queue.playAt(2);
    expect(queue.current()?.id).toBe("3");
  });
});
