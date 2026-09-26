// Connection helpers: remember phones, find them again without a new code, and spot firewall blocks.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { adb, dataDir, findAdb } from "./adb.js";
import { tcpProbe } from "./setup.js";

const IS_WIN = process.platform === "win32";
const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? "" : String(stdout)));
});

// ---------- remembered phones ----------
const knownFile = () => path.join(dataDir(), "known-devices.json");
export function loadKnown() {
  try { return JSON.parse(fs.readFileSync(knownFile(), "utf8")); } catch { return {}; }
}
export function remember(hw, entry) {
  if (!hw) return;
  const k = loadKnown();
  k[hw] = { ...(k[hw] || {}), ...entry, seen: new Date().toISOString() };
  try { fs.mkdirSync(dataDir(), { recursive: true }); fs.writeFileSync(knownFile(), JSON.stringify(k, null, 2)); } catch {}
}

// ---------- neighbors (ARP) ----------
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
export async function neighborIps() {
  if (process.env.ANDROID_CONTROL_NEIGHBORS !== undefined) return process.env.ANDROID_CONTROL_NEIGHBORS.split(",").filter(Boolean);
  const out = IS_WIN ? await run("arp", ["-a"]) : (await run("ip", ["neigh"])) || (await run("arp", ["-an"]));
  const ips = [...out.matchAll(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g)].map((m) => m[1])
    .filter((ip) => isPrivate(ip) && !/\.(0|1|255)$/.test(ip));
  // Windows Mobile Hotspot clients (192.168.137.x) first: that's the usual phone-to-PC path.
  return [...new Set(ips)].sort((a, b) => (b.startsWith("192.168.137.") ? 1 : 0) - (a.startsWith("192.168.137.") ? 1 : 0));
}

// Try remembered addresses, then anything on the local network listening on the classic adb port.
export async function discoverClassic({ port = 5555, limit = 24 } = {}) {
  const known = Object.values(loadKnown()).flatMap((k) => [k.ip && `${k.ip}:${k.classicPort || port}`, k.lastHostPort]).filter(Boolean);
  const cands = [...new Set([...known, ...(await neighborIps()).slice(0, limit).map((ip) => `${ip}:${port}`)])];
  const open = [];
  await Promise.all(cands.map(async (hp) => {
    const [h, p] = hp.split(":");
    if ((await tcpProbe(h, +p, 1200)) === "open") open.push(hp);
  }));
  const done = [];
  for (const hp of open) {
    try {
      const r = await adb(["connect", hp], { timeout: 8000 });
      if (/connected/i.test(r) && !/fail|cannot|unable/i.test(r)) done.push(hp);
    } catch {}
  }
  return done;
}

// Switch a connected phone to classic TCP 5555 so it can be reconnected later without a pairing code.
export async function stayReachable(serial, port = 5555) {
  const ipOut = await adb(["shell", "ip -f inet addr show wlan0 2>/dev/null; ip -f inet addr show 2>/dev/null"], { serial, timeout: 8000 }).catch(() => "");
  const ip = [...ipOut.matchAll(/inet ([\d.]+)/g)].map((m) => m[1]).find((x) => x !== "127.0.0.1" && isPrivate(x));
  if (!ip) return { ok: false, note: "couldn't read the phone's Wi-Fi IP" };
  await adb(["tcpip", String(port)], { serial, timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));
  let r = "";
  for (let i = 0; i < 3 && !/connected to/i.test(r); i++) {
    r = await adb(["connect", `${ip}:${port}`], { timeout: 10000 }).catch((e) => e.message);
    if (!/connected to/i.test(r)) await new Promise((res) => setTimeout(res, 1500));
  }
  return { ok: /connected to/i.test(r), ip, port, note: r.trim() };
}

// ---------- Windows Firewall ----------
// Inbound block rules for adb.exe (Windows adds one when someone clicks Cancel on the firewall prompt).
// Read-only query; works without admin.
export async function firewallBlocks() {
  if (!IS_WIN) return [];
  const adbPath = findAdb().path;
  if (!adbPath) return [];
  const ps = `$p='${adbPath.replace(/'/g, "''")}'; Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | ?{ $_.Program -eq $p } | ` +
    `Get-NetFirewallRule -ErrorAction SilentlyContinue | ?{ $_.Action -eq 'Block' -and $_.Enabled -eq 'True' } | ` +
    `%{ $_.DisplayName + ' | ' + $_.Profile + ' | ' + $_.Direction }`;
  const out = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 20000);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export function firewallAdvice(rules) {
  if (!rules.length) return "";
  return `Windows Firewall has ${rules.length} BLOCK rule(s) for adb.exe:\n${rules.map((r) => "  " + r).join("\n")}\n` +
    "Effect: phones can't be auto-discovered and incoming connections are dropped on those network profiles. " +
    "Outgoing connects (android_connect with IP:port) usually still work. To remove: Windows Security > Firewall > Advanced settings > Inbound Rules, delete the adb rules (needs admin), or ask IT. " +
    "Using the PC's Mobile Hotspot network or USB avoids it.";
}
