import { describe, it, expect } from "vitest";
import { patchClientInitVersion } from "./ts6-compat.js";

describe("ts6-compat", () => {
  it("patches clientinit version to 3.6.2", () => {
    const original =
      "clientinit client_nickname=Bot client_version=3.5.3\\s[Build:\\s1587971024] " +
      "client_platform=Windows client_version_sign=Kvmj7qX6wJCPI5GVT71samfmhz/bvs7M+OTXWB/JWxdQbxDe17xda7dzUWLX7pjvdJTqZmbse1HBmTxThPKvAg== " +
      "client_key_offset=42 hwid=abc123";

    const patched = patchClientInitVersion(original);

    expect(patched).toContain("client_version=3.6.2\\s[Build:\\s1695203293]");
    expect(patched).toContain(
      "client_version_sign=4OH3unxjGNBYS5EN4RFNrEo3UJz2Jn5KW1JqMDh3Yy93mSd0IwPm3FBrv8hCJgLuv99y6yBSN7pOmOpFjDaCw=="
    );
    // Other fields preserved
    expect(patched).toContain("client_nickname=Bot");
    expect(patched).toContain("client_key_offset=42");
    expect(patched).toContain("hwid=abc123");
  });
});
