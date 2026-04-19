import { describe, expect, it } from "vitest";
import { findChannelByName } from "./client.js";

describe("findChannelByName", () => {
  const channels = [
    { id: 1n, parentID: 0n, name: "Lobby" },
    { id: 2n, parentID: 0n, name: "音乐区" },
    { id: 3n, parentID: 2n, name: "音乐厅" },
  ];

  it("matches a channel name after trimming surrounding whitespace", () => {
    expect(findChannelByName(channels, "  音乐厅  ")).toEqual(channels[2]);
  });

  it("matches a channel path for nested channels", () => {
    expect(findChannelByName(channels, "音乐区/音乐厅")).toEqual(channels[2]);
  });

  it("matches channel names case-insensitively", () => {
    expect(findChannelByName(channels, "lobby")).toEqual(channels[0]);
  });
});
