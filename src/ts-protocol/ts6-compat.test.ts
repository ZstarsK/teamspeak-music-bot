import { describe, it, expect } from "vitest";
import { ts6VersionMiddleware } from "./ts6-compat.js";

describe("ts6-compat", () => {
  it("patches clientinit version to 3.6.2", async () => {
    const middleware = ts6VersionMiddleware("3.6.2");
    let captured = "";
    const next = async (cmd: string) => {
      captured = cmd;
    };
    const handler = middleware(next);

    const original =
      "clientinit client_nickname=Bot client_version=3.5.3\\s[Build:\\s1587971024] " +
      "client_platform=Windows client_version_sign=Kvmj7qX6wJCPI5GVT71samfmhz/bvs7M+OTXWB/JWxdQbxDe17xda7dzUWLX7pjvdJTqZmbse1HBmTxThPKvAg== " +
      "client_key_offset=42 hwid=abc123";

    await handler(original);

    expect(captured).toContain("client_version=3.6.2\\s[Build:\\s1695203293]");
    expect(captured).toContain(
      "client_version_sign=4OH3unxjGNBYS5EN4RFNrEo3UJz2Jn5KW1JqMDh3Yy93mSd0IwPm3FBrv8hCJgLuv99y6yBSN7pOmOpFjDaCw=="
    );
    // Other fields preserved
    expect(captured).toContain("client_nickname=Bot");
    expect(captured).toContain("client_key_offset=42");
    expect(captured).toContain("hwid=abc123");
  });

  it("does not modify non-clientinit commands", async () => {
    const middleware = ts6VersionMiddleware("3.6.2");
    let captured = "";
    const handler = middleware(async (cmd) => {
      captured = cmd;
    });

    const original = "sendtextmessage targetmode=2 msg=hello";
    await handler(original);
    expect(captured).toBe(original);
  });

  it("throws for unknown target version", () => {
    expect(() => ts6VersionMiddleware("9.9.9")).toThrow("Unknown version");
  });
});
