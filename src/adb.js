// adb location, self-install (no admin), and command execution.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";

const log = (...a) => console.error("[android-control]", ...a);
const IS_WIN = process.platform === "win32";
const EXE = IS_WIN ? "adb.exe" : "adb";

export function dataDir() {
  if (process.env.ANDROID_CONTROL_HOME) return process.env.ANDROID_CONTROL_HOME;
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "android-control-mcp");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "android-control-mcp");
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "android-control-mcp");
}

function platformZipUrl() {
  const p = IS_WIN ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return `https://dl.google.com/android/repository/platform-tools-latest-${p}.zip`;
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const clean = (v) => (v && !String(v).includes("${") ? String(v).trim() : "");

// Order: explicit setting -> our managed copy -> ANDROID_HOME/SDK_ROOT -> PATH.
export function findAdb() {
  const tried = [];
  const explicit = clean(process.env.ADB_PATH);
  if (explicit) {
    const cand = fs.existsSync(explicit) && fs.statSync(explicit).isDirectory() ? path.join(explicit, EXE) : explicit;
    tried.push(cand);
    if (isFile(cand)) return { path: cand, source: "ADB_PATH setting", tried };
  }
  const managed = path.join(dataDir(), "platform-tools", EXE);
  tried.push(managed);
  if (isFile(managed)) return { path: managed, source: "managed install", tried };
  for (const v of ["ANDROID_HOME", "ANDROID_SDK_ROOT"]) {
    const root = clean(process.env[v]);
    if (!root) continue;
    const c = path.join(root, "platform-tools", EXE);
    tried.push(c);
    if (isFile(c)) return { path: c, source: v, tried };
  }
  if (IS_WIN && process.env.LOCALAPPDATA) {
    const c = path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "platform-tools", EXE);
    tried.push(c);
    if (isFile(c)) return { path: c, source: "Android Studio default SDK", tried };
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const c = path.join(dir.replace(/^"|"$/g, ""), EXE);
    if (isFile(c)) { tried.push(c); return { path: c, source: "PATH", tried }; }
  }
  return { path: null, source: null, tried };
}

async function downloadWithFetch(url) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// PowerShell uses the Windows system proxy, which Node's fetch ignores. Corporate-network fallback.
function downloadWithPowerShell(url, outFile) {
  return new Promise((resolve, reject) => {
    const cmd = `$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ` +
      `$wc = New-Object Net.WebClient; $wc.Proxy = [Net.WebRequest]::GetSystemWebProxy(); $wc.Proxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials; ` +
      `$wc.DownloadFile('${url.replace(/'/g, "''")}', '${outFile.replace(/'/g, "''")}')`;
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd],
      { timeout: 180000, windowsHide: true }, (err, _o, stderr) => {
        if (err) return reject(new Error(`PowerShell download failed: ${stderr || err.message}`));
        resolve(fs.readFileSync(outFile));
      });
  });
}

let installing = null;
export function installPlatformTools() {
  if (!installing) installing = doInstall().finally(() => { installing = null; });
  return installing;
}

async function doInstall() {
  const base = dataDir();
  fs.mkdirSync(base, { recursive: true });
  const url = clean(process.env.ANDROID_CONTROL_PLATFORM_TOOLS_URL) || platformZipUrl();
  const zipPath = path.join(base, "platform-tools.zip");
  log("downloading", url);
  let buf; const errors = [];
  try { buf = await downloadWithFetch(url); } catch (e) { errors.push(`fetch: ${e.message}`); }
  if (!buf && IS_WIN) {
    try { buf = await downloadWithPowerShell(url, zipPath); } catch (e) { errors.push(e.message); }
  }
  if (!buf) throw new Error(`Could not download Android platform-tools from ${url}. ${errors.join(" | ")}. ` +
    `Fix: download that zip in a browser, extract it, and set the "adb location" setting to the extracted platform-tools folder.`);
  const files = unzipSync(new Uint8Array(buf));
  const staging = path.join(base, `platform-tools.tmp-${process.pid}`);
  fs.rmSync(staging, { recursive: true, force: true });
  for (const [name, data] of Object.entries(files)) {
    const out = path.join(staging, name);
    if (!out.startsWith(staging)) continue; // zip-slip guard
    if (name.endsWith("/")) { fs.mkdirSync(out, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data);
    if (!IS_WIN) fs.chmodSync(out, 0o755);
  }
  const final = path.join(base, "platform-tools");
  const extracted = path.join(staging, "platform-tools");
  if (!isFile(path.join(extracted, EXE))) throw new Error("Downloaded zip did not contain platform-tools/" + EXE);
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(extracted, final);
  fs.rmSync(staging, { recursive: true, force: true });
  try { fs.rmSync(zipPath, { force: true }); } catch {}
  log("installed platform-tools to", final);
  return path.join(final, EXE);
}

let cachedAdb = null;
export async function ensureAdb() {
  if (cachedAdb && isFile(cachedAdb)) return cachedAdb;
  const found = findAdb();
  cachedAdb = found.path || (await installPlatformTools());
  return cachedAdb;
}

export class AdbError extends Error {
  constructor(msg, { stdout = "", stderr = "", code } = {}) { super(msg); this.stdout = stdout; this.stderr = stderr; this.code = code; }
}

// Run adb with args. Returns stdout (string, or Buffer when binary=true).
export async function adb(args, { serial, timeout = 30000, binary = false, input } = {}) {
  const bin = await ensureAdb();
  const full = serial ? ["-s", serial, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, full, { windowsHide: true });
    const out = []; const err = [];
    let killed = false;
    const t = setTimeout(() => { killed = true; child.kill(); }, timeout);
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", (e) => { clearTimeout(t); reject(new AdbError(`failed to start adb: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(t);
      const stdout = Buffer.concat(out); const stderr = Buffer.concat(err).toString("utf8");
      if (killed) return reject(new AdbError(`adb ${args.join(" ")} timed out after ${timeout} ms`, { stderr }));
      if (code !== 0) return reject(new AdbError(`adb ${args.slice(0, 3).join(" ")} failed (exit ${code}): ${(stderr || stdout.toString("utf8")).trim()}`, { stdout: stdout.toString("utf8"), stderr, code }));
      resolve(binary ? stdout : stdout.toString("utf8"));
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

export async function adbVersion() {
  const out = await adb(["version"], { timeout: 15000 });
  return out.split(/\r?\n/).slice(0, 2).join(" | ");
}

export async function listDevices() {
  const out = await adb(["devices", "-l"], { timeout: 20000 });
  return out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [serial, state, ...rest] = l.split(/\s+/);
    const info = Object.fromEntries(rest.map((kv) => kv.split(":")).filter((p) => p.length === 2));
    return { serial, state, model: info.model, device: info.device, transport: serial.includes(":") || serial.includes("._adb-tls-") ? "wifi" : "usb" };
  });
}
