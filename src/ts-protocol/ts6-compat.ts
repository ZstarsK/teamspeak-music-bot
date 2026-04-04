/**
 * TS6 version used for compatibility. The version_sign is a P-256 ECDSA
 * signature verified by TeamSpeak servers; only officially signed pairs work.
 */
const TS6_VERSION = {
  version: "3.6.2 [Build: 1695203293]",
  platform: "Windows",
  sign: "4OH3unxjGNBYS5EN4RFNrEo3UJz2Jn5KW1JqMDh3Yy93mSd0IwPm3FBrv8hCJgLuv99y6yBSN7pOmOpFjDaCw==",
};

/**
 * Patch a raw `clientinit` command string to use the 3.6.2 version.
 *
 * The @honeybbq/teamspeak-client library hardcodes version 3.5.3 in the
 * handshake and sends it directly via handler.sendPacket(), bypassing the
 * commandMiddleware chain. TS6 servers silently reject 3.5.3 (they never
 * respond with `initserver`), causing an idle timeout.
 *
 * This function is called from a monkey-patched handler.sendPacket() so it
 * intercepts the actual handshake packets.
 */
export function patchClientInitVersion(cmd: string): string {
  cmd = replaceField(cmd, "client_version", TS6_VERSION.version);
  cmd = replaceField(cmd, "client_platform", TS6_VERSION.platform);
  cmd = replaceField(cmd, "client_version_sign", TS6_VERSION.sign);
  return cmd;
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
