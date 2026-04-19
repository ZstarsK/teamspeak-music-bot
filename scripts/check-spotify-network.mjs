#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { lookup } from "node:dns/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "config.json");
const spotifyStatePath = path.join(rootDir, "data", "cookies", "spotify.json");
const spotifyLibrespotBaseDir = path.join(rootDir, "data", "spotify-librespot");
const timeoutMs = Number(process.env.SPOTIFY_CHECK_TIMEOUT_MS ?? 8000);

function readJson(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    console.log(`FAIL read ${file}: ${err.message}`);
    return null;
  }
}

function print(ok, label, detail = "") {
  const prefix = ok ? "OK  " : "FAIL";
  console.log(`${prefix} ${label}${detail ? ` - ${detail}` : ""}`);
}

function sanitizeName(input) {
  return String(input ?? "").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
}

function getAccountCachePaths(userId) {
  const accountKey = sanitizeName(userId);
  const baseDir = path.join(spotifyLibrespotBaseDir, "accounts", accountKey);
  return {
    accountKey,
    baseDir,
    audioDir: path.join(baseDir, "audio-cache"),
    systemDir: path.join(baseDir, "system-cache"),
  };
}

function hasFiles(dir) {
  try {
    return existsSync(dir) && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function run(bin, args) {
  return spawnSync(bin, args, { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 1024 * 1024 });
}

async function withTimeout(promise, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promise(controller.signal);
  } catch (err) {
    throw new Error(`${label}: ${err.name === "AbortError" ? "timeout" : err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function testDns(host) {
  try {
    const result = await lookup(host);
    print(true, `dns ${host}`, result.address);
    return true;
  } catch (err) {
    print(false, `dns ${host}`, err.message);
    return false;
  }
}

async function testFetch(label, url, headers = {}) {
  try {
    const res = await withTimeout(
      (signal) => fetch(url, { headers, signal }),
      label,
    );
    print(res.status < 500, label, `${res.status} ${res.statusText}`);
    return res;
  } catch (err) {
    print(false, label, err.message);
    return null;
  }
}

function parseHostPort(entry, defaultPort = 443) {
  const input = String(entry ?? "").replace(/^https?:\/\//, "");
  const [host, rawPort] = input.split(":");
  return { host, port: Number(rawPort ?? defaultPort) };
}

async function testTcp(label, host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      print(true, label, `${host}:${port}`);
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      print(false, label, `${host}:${port} timeout`);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (err) => {
      print(false, label, `${host}:${port} ${err.message}`);
      resolve(false);
    });
  });
}

async function getAccessToken(config, state) {
  const primaryId = state?.primaryId;
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  const account = accounts.find((item) => item.id === primaryId) ?? accounts[0];
  if (!account) return null;
  if (account.expiresAt && account.expiresAt > Date.now() + 60000) {
    return account.accessToken;
  }
  if (!config.spotifyClientId || !config.spotifyClientSecret || !account.refreshToken) {
    return account.accessToken ?? null;
  }
  const basic = Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
  });
  const res = await postFetch("spotify token refresh", "https://accounts.spotify.com/api/token", {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
  }, body);
  if (!res || !res.ok) return account.accessToken ?? null;
  const data = await res.json();
  return data.access_token ?? account.accessToken ?? null;
}

function getPrimaryAccount(state) {
  const primaryId = state?.primaryId;
  const accounts = Array.isArray(state?.accounts) ? state.accounts : [];
  return accounts.find((item) => item.id === primaryId) ?? accounts[0] ?? null;
}

async function postFetch(label, url, headers, body) {
  try {
    const res = await withTimeout(
      (signal) => fetch(url, { method: "POST", headers, body, signal }),
      label,
    );
    print(res.status < 500, label, `${res.status} ${res.statusText}`);
    return res;
  } catch (err) {
    print(false, label, err.message);
    return null;
  }
}

async function main() {
  const config = readJson(configPath) ?? {};
  const spotifyState = readJson(spotifyStatePath);
  const librespot = config.spotifyLibrespotPath || "librespot";
  const cargoLibrespot = process.env.HOME ? path.join(process.env.HOME, ".cargo", "bin", "librespot") : "";
  const authMode = config.spotifyLibrespotAuthMode === "credentials-cache" ? "credentials-cache" : "access-token";
  const primaryAccount = getPrimaryAccount(spotifyState);
  const primaryCache = primaryAccount?.userId ? getAccountCachePaths(primaryAccount.userId) : null;

  console.log(`cwd: ${rootDir}`);
  console.log(`librespot: ${librespot}`);
  console.log(`librespot auth mode: ${authMode}`);
  const pathLookup = run("sh", ["-lc", "command -v librespot || true"]);
  console.log(`PATH librespot: ${(pathLookup.stdout || "").trim() || "(not found)"}`);
  if (cargoLibrespot) {
    console.log(`cargo librespot: ${existsSync(cargoLibrespot) ? cargoLibrespot : "(not found)"}`);
  }
  if (primaryAccount) {
    console.log(`spotify primary account: ${primaryAccount.id} (${primaryAccount.userId})`);
  }
  if (primaryCache) {
    console.log(`spotify credentials cache: ${primaryCache.baseDir}`);
    print(hasFiles(primaryCache.systemDir) || hasFiles(primaryCache.audioDir), "spotify credentials cache present", primaryCache.systemDir);
  }

  for (const host of ["accounts.spotify.com", "api.spotify.com", "apresolve.spotify.com"]) {
    await testDns(host);
    await testTcp(`tcp ${host}:443`, host, 443);
  }

  await testFetch("spotify accounts https", "https://accounts.spotify.com/");
  await testFetch("spotify api https", "https://api.spotify.com/v1/");

  const apresolveRes = await testFetch(
    "spotify apresolve",
    "https://apresolve.spotify.com/?type=accesspoint&type=dealer&type=spclient",
  );
  if (apresolveRes?.ok) {
    try {
      const data = await apresolveRes.json();
      const endpoints = [
        ...(data.ap_list ?? []).slice(0, 3).map((entry) => ["accesspoint", entry]),
        ...(data.dealer ?? []).slice(0, 2).map((entry) => ["dealer", entry]),
        ...(data.spclient ?? []).slice(0, 2).map((entry) => ["spclient", entry]),
      ];
      for (const [kind, entry] of endpoints) {
        const { host, port } = parseHostPort(entry);
        if (host) await testTcp(`tcp spotify ${kind}`, host, port);
      }
    } catch (err) {
      print(false, "parse apresolve", err.message);
    }
  }

  const version = run(librespot, ["--version"]);
  print(version.status === 0, "librespot --version", (version.stdout || version.stderr || "").trim());

  const help = run(librespot, ["--help"]);
  const helpText = `${help.stdout}\n${help.stderr}`;
  for (const flag of ["--backend", "--access-token", "--onevent"]) {
    print(helpText.includes(flag), `librespot supports ${flag}`);
  }

  if (cargoLibrespot && existsSync(cargoLibrespot) && cargoLibrespot !== librespot) {
    const cargoVersion = run(cargoLibrespot, ["--version"]);
    print(cargoVersion.status === 0, "cargo librespot --version", (cargoVersion.stdout || cargoVersion.stderr || "").trim());
  }

  const token = await getAccessToken(config, spotifyState);
  if (!token) {
    print(false, "spotify oauth token", "no saved Spotify account token found");
    return;
  }

  await testFetch("spotify /me", "https://api.spotify.com/v1/me", {
    Authorization: `Bearer ${token}`,
  });
  await testFetch("spotify /me/player/devices", "https://api.spotify.com/v1/me/player/devices", {
    Authorization: `Bearer ${token}`,
  });

  if (process.env.SPOTIFY_LIBRESPOT_PROBE === "1") {
    console.log("Starting optional librespot probe for 12 seconds...");
    const probeArgs = [
      "--name", "TSMusicBot Network Probe",
      "--backend", "pipe",
      "--disable-discovery",
    ];
    if (authMode === "credentials-cache" && primaryCache) {
      probeArgs.push("--cache", primaryCache.audioDir, "--system-cache", primaryCache.systemDir);
    } else {
      probeArgs.push("--access-token", token);
    }
    const probe = run(librespot, probeArgs);
    const output = `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`.trim();
    print(probe.error?.code === "ETIMEDOUT" || probe.status === 0, "librespot probe", output.slice(0, 1000));
  }
}

main().catch((err) => {
  print(false, "spotify network check", err.stack ?? err.message);
  process.exitCode = 1;
});
