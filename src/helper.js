// Client for the on-phone helper (helper/src/acm/Helper.java).
// One persistent `adb shell` per device runs the helper via app_process with shell permissions:
// no app install. It keeps a UiAutomation connection open, so screen reads take ~15 ms instead of
// seconds. Any failure falls back to the plain adb commands in device.js.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adb, ensureAdb } from "./adb.js";
import { HELPER_JAR_B64, HELPER_JAR_HASH } from "./helper-jar.js";

const log = (...a) => console.error("[android-control/helper]", ...a);
const REMOTE = `/data/local/tmp/acm-helper-${HELPER_JAR_HASH}.jar`;
const IDLE_EXIT_MS = 60000;
const sessions = new Map(); // serial -> Session
const disabled = new Map(); // serial -> reason (after repeated start failures)
const failCount = new Map();

class Session {
  constructor(serial) { this.serial = serial; this.proc = null; this.buf = ""; this.waiters = []; this.queue = Promise.resolve(); this.dead = false; }

  async start() {
    const bin = await ensureAdb();
    await pushJar(this.serial);
    const cmd = `CLASSPATH=${REMOTE} exec app_process /system/bin acm.Helper ${IDLE_EXIT_MS}`;
    this.proc = spawn(bin, ["-s", this.serial, "shell", "-T", cmd], { windowsHide: true });
    this.proc.stdout.on("data", (d) => this.onData(d));
    this.proc.stderr.on("data", (d) => log(this.serial, String(d).trim()));
    this.proc.on("close", () => this.kill("helper exited"));
    this.proc.on("error", (e) => this.kill(e.message));
    const ready = await this.next(15000);
    if (!ready.startsWith("OK ready")) { this.kill(ready); throw new Error(`helper did not start: ${ready}`); }
    log(this.serial, ready);
  }

  onData(d) {
    this.buf += d.toString("utf8");
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line.startsWith("BYE")) { this.kill("idle exit"); continue; }
      const w = this.waiters.shift();
      if (w) w.resolve(line);
    }
  }

  next(timeout) {
    return new Promise((resolve, reject) => {
      const w = { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); this.kill("timeout"); reject(new Error("helper timed out")); }, timeout);
      this.waiters.push(w);
    });
  }

  // Commands are serialized: one in flight per device.
  send(line, timeout = 15000) {
    const run = async () => {
      if (this.dead) throw new Error("helper not running");
      this.proc.stdin.write(line + "\n");
      const resp = await this.next(timeout);
      if (resp.startsWith("ERR ")) throw new HelperError(resp.slice(4));
      return resp.startsWith("OK") ? resp.slice(3) : resp;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  kill(reason) {
    if (this.dead) return;
    this.dead = true;
    for (const w of this.waiters.splice(0)) w.reject(new Error(`helper stopped: ${reason}`));
    try { this.proc?.stdin.end("quit\n"); } catch {}
    setTimeout(() => { try { this.proc?.kill(); } catch {} }, 500);
    if (sessions.get(this.serial) === this) sessions.delete(this.serial);
  }
}

export class HelperError extends Error {}

async function pushJar(serial) {
  const exists = await adb(["shell", `[ -f ${REMOTE} ] && echo yes || echo no`], { serial, timeout: 10000 }).catch(() => "no");
  if (exists.trim() === "yes") return;
  const tmp = path.join(os.tmpdir(), `acm-helper-${HELPER_JAR_HASH}.jar`);
  fs.writeFileSync(tmp, Buffer.from(HELPER_JAR_B64, "base64"));
  await adb(["push", tmp, REMOTE], { serial, timeout: 30000 });
  // Remove older helper versions.
  await adb(["shell", `for f in /data/local/tmp/acm-helper-*.jar; do [ "$f" != ${REMOTE} ] && rm -f "$f"; done; true`], { serial, timeout: 10000 }).catch(() => {});
}

// Returns a live session, starting one if needed; null if the helper can't run on this device.
export async function getHelper(serial) {
  if (process.env.ANDROID_CONTROL_NO_HELPER === "1") return null;
  if (disabled.has(serial)) return null;
  let s = sessions.get(serial);
  if (s && !s.dead) return s;
  s = new Session(serial);
  sessions.set(serial, s);
  try {
    await s.start();
    failCount.delete(serial);
    return s;
  } catch (e) {
    s.kill(e.message);
    const fails = (failCount.get(serial) || 0) + 1;
    failCount.set(serial, fails);
    log(serial, "start failed:", e.message);
    if (fails >= 2) disabled.set(serial, e.message);
    return null;
  }
}

export function helperStatus(serial) {
  if (process.env.ANDROID_CONTROL_NO_HELPER === "1") return "disabled by ANDROID_CONTROL_NO_HELPER=1";
  if (disabled.has(serial)) return `unavailable (${disabled.get(serial)}); using plain adb`;
  const s = sessions.get(serial);
  return s && !s.dead ? "running" : "not started (starts on first use)";
}

export function stopHelper(serial) { const s = sessions.get(serial); if (s) s.kill("stopped for uiautomator"); }
export function helperRunning(serial) { const s = sessions.get(serial); return !!(s && !s.dead); }

export function stopAllHelpers() { for (const s of sessions.values()) s.kill("shutdown"); }
process.on("exit", stopAllHelpers);
