import type { CommandMiddleware } from "@honeybbq/teamspeak-client";

/**
 * Known-compatible client versions with their signatures.
 *
 * The version_sign is a P-256 ECDSA signature over the version string,
 * verified by TeamSpeak servers. Only officially signed versions work.
 */
const KNOWN_VERSIONS: Record<
  string,
  { version: string; platform: string; sign: string }
> = {
  // TS3 client 3.5.3 (default in @honeybbq/teamspeak-client)
  "3.5.3": {
    version: "3.5.3 [Build: 1587971024]",
    platform: "Windows",
    sign: "Kvmj7qX6wJCPI5GVT71samfmhz/bvs7M+OTXWB/JWxdQbxDe17xda7dzUWLX7pjvdJTqZmbse1HBmTxThPKvAg==",
  },
  // TS3 client 3.6.2 (used by NeteaseTSBot, known to work with TS6 servers)
  "3.6.2": {
    version: "3.6.2 [Build: 1695203293]",
    platform: "Windows",
    sign: "4OH3unxjGNBYS5EN4RFNrEo3UJz2Jn5KW1JqMDh3Yy93mSd0IwPm3FBrv8hCJgLuv99y6yBSN7pOmOpFjDaCw==",
  },
};

/**
 * Command middleware that upgrades the client_version in `clientinit` to
 * a newer version known to work with TS6 servers.
 *
 * TS6 servers may reject connections from older client versions. The default
 * library sends version 3.5.3; this middleware patches it to 3.6.2 which is
 * the version NeteaseTSBot uses successfully with TS6.
 *
 * The version_sign must match the version string — it's a server-verified
 * ECDSA signature, so we can only use known-valid pairs.
 */
export function ts6VersionMiddleware(
  targetVersion = "3.6.2",
): CommandMiddleware {
  const vInfo = KNOWN_VERSIONS[targetVersion];
  if (!vInfo) {
    throw new Error(`Unknown version ${targetVersion}. Known: ${Object.keys(KNOWN_VERSIONS).join(", ")}`);
  }

  return (next) => async (cmd) => {
    // Only intercept clientinit commands
    if (cmd.startsWith("clientinit ")) {
      cmd = replaceField(cmd, "client_version", vInfo.version);
      cmd = replaceField(cmd, "client_platform", vInfo.platform);
      cmd = replaceField(cmd, "client_version_sign", vInfo.sign);
    }
    return next(cmd);
  };
}

/**
 * Replace an escaped field value in a TS3 command string.
 * Fields are in the format: key=escaped_value (space-separated)
 */
function replaceField(cmd: string, key: string, value: string): string {
  // Escape the value using TS3 escaping rules
  const escaped = escapeTS3(value);
  const regex = new RegExp(`${key}=\\S*`);
  if (regex.test(cmd)) {
    return cmd.replace(regex, `${key}=${escaped}`);
  }
  return cmd;
}

function escapeTS3(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\//g, "\\/")
    .replace(/ /g, "\\s")
    .replace(/\|/g, "\\p")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}
