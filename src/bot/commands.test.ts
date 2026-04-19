import { describe, it, expect } from "vitest";
import { isAdminCommand, parseCommand } from "./commands.js";

describe("Command Parser", () => {
  it("parses simple command", () => {
    const result = parseCommand("!play 晴天", "!");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("play");
    expect(result!.args).toBe("晴天");
    expect(result!.rawArgs).toEqual(["晴天"]);
  });

  it("parses command with flags", () => {
    const result = parseCommand("!play -q 七里香", "!");
    expect(result!.name).toBe("play");
    expect(result!.flags.has("q")).toBe(true);
    expect(result!.args).toBe("七里香");
  });

  it("returns null for non-command messages", () => {
    expect(parseCommand("hello world", "!")).toBeNull();
    expect(parseCommand("", "!")).toBeNull();
  });

  it("handles custom prefix", () => {
    const result = parseCommand("/play test", "/");
    expect(result!.name).toBe("play");
    expect(result!.args).toBe("test");
  });

  it("resolves aliases", () => {
    const aliases = { p: "play", s: "skip", n: "next" };
    const result = parseCommand("!p 稻香", "!", aliases);
    expect(result!.name).toBe("play");
    expect(result!.args).toBe("稻香");
  });

  it("parses command with no args", () => {
    const result = parseCommand("!pause", "!");
    expect(result!.name).toBe("pause");
    expect(result!.args).toBe("");
    expect(result!.rawArgs).toEqual([]);
  });

  it("parses vol command with number arg", () => {
    const result = parseCommand("!vol 80", "!");
    expect(result!.name).toBe("vol");
    expect(result!.args).toBe("80");
  });

  it("parses mode command", () => {
    const result = parseCommand("!mode loop", "!");
    expect(result!.name).toBe("mode");
    expect(result!.args).toBe("loop");
  });

  it("parses remove command with index", () => {
    const result = parseCommand("!remove 3", "!");
    expect(result!.name).toBe("remove");
    expect(result!.args).toBe("3");
  });

  it("marks duck as an admin command", () => {
    expect(isAdminCommand("duck")).toBe(true);
  });
});
