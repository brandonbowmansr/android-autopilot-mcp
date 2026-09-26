// Device-level operations built on adb.
import { adb, listDevices, AdbError } from "./adb.js";
import { parseUiXml, interestingElements, center } from "./ui.js";
import { decodePng, decodeJpeg, resize, annotate, encodeJpeg, fitScale } from "./image.js";
import { getHelper, HelperError } from "./helper.js";

// Run fn(helper) when the on-phone helper is available; otherwise (or on helper failure) run fallback().
async function withHelper(serial, fn, fallback) {
  const h = await getHelper(serial).catch(() => null);
  if (h) {
    try { return await fn(h); }
    catch (e) { if (e instanceof HelperError && e.final) throw e; console.error("[android-control] helper failed, falling back:", e.message); }
  }
  return fallback();
}

const state = { selected: null, perDevice: new Map() };
const dev = (serial) => {
  if (!state.perDevice.has(serial)) state.perDevice.set(serial, { elements: [], shot: null });
  return state.perDevice.get(serial);
};

export function selectDevice(serial) { state.selected = serial; }

// Resolve which device to talk to. Explicit > selected (if still attached) > the only one attached.
let devCache = { at: 0, list: null };
async function devicesCached() {
  if (devCache.list && Date.now() - devCache.at < 3000) return devCache.list;
  const list = await listDevices();
  devCache = { at: Date.now(), list };
  return list;
}
export function invalidateDevices() { devCache = { at: 0, list: null }; }

export async function resolveSerial(serial) {
  let devices = await devicesCached();
  if (serial && !devices.some((d) => d.serial === serial)) { invalidateDevices(); devices = await devicesCached(); }
  const ready = devices.filter((d) => d.state === "device");
  if (serial) {
    const d = devices.find((x) => x.serial === serial);
    if (!d) throw new AdbError(`Device ${serial} not attached. Attached: ${devices.map((x) => `${x.serial} (${x.state})`).join(", ") || "none"}`);
    if (d.state !== "device") throw new AdbError(stateHelp(d));
    return serial;
  }
  if (state.selected && ready.some((d) => d.serial === state.selected)) return state.selected;
  if (ready.length === 1) return ready[0].serial;
  if (ready.length === 0) {
    const bad = devices.find((d) => d.state !== "device");
    if (bad) throw new AdbError(stateHelp(bad));
    throw new AdbError("No Android device connected. Run android_doctor for setup steps (wireless pairing needs no drivers or admin rights).");
  }
  throw new AdbError(`Several devices attached (${ready.map((d) => `${d.serial} ${d.model || ""}`).join("; ")}). Pass serial or call android_select_device.`);
}

function stateHelp(d) {
  if (d.state === "unauthorized") return `Device ${d.serial} is unauthorized: unlock the phone and accept the "Allow USB debugging?" prompt (tick "Always allow").`;
  if (d.state === "offline") return `Device ${d.serial} is offline. Toggle Wireless/USB debugging off and on, or run android_connect again.`;
  return `Device ${d.serial} is in state "${d.state}".`;
}

export const sh = (serial, cmd, opts = {}) => adb(["shell", cmd], { serial, ...opts });

export const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- UI tree ----------
export async function dumpUi(serial, { mode = "useful", retries = 3 } = {}) {
  const fromXml = (xml) => {
    const nodes = parseUiXml(xml);
    const els = interestingElements(nodes, { mode });
    dev(serial).elements = els;
    dev(serial).dumpedAt = Date.now();
    return { nodes, elements: els };
  };
  return withHelper(serial, async (h) => {
    let last;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await h.send("dump", 10000);
        return fromXml(r.slice(r.indexOf(" ") + 1));
      } catch (e) { last = e; if (!(e instanceof HelperError)) throw e; await new Promise((r) => setTimeout(r, 150)); }
    }
    throw last;
  }, async () => {
    const f = "/data/local/tmp/.acm_ui.xml";
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const out = await adb(["exec-out", `uiautomator dump ${f} >/dev/null 2>&1; cat ${f}; rm -f ${f}`], { serial, timeout: 25000 });
        const start = out.indexOf("<?xml") >= 0 ? out.indexOf("<?xml") : out.indexOf("<hierarchy");
        if (start < 0) throw new AdbError(`uiautomator returned no hierarchy: ${out.slice(0, 200)}`);
        return fromXml(out.slice(start));
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    throw new AdbError(`Could not read the UI tree (${lastErr?.message}). Screens with constant animation, games, video, and some Flutter/Unity apps don't expose one: use android_screenshot and coordinate taps instead.`);
  });
}

export function cachedElement(serial, index) {
  const els = dev(serial).elements;
  if (!els.length) throw new AdbError("No element list yet. Call android_ui or android_screenshot first.");
  const e = els.find((x) => x.index === index);
  if (!e) throw new AdbError(`Element ${index} not in the last list (1..${els.length}). The screen may have changed: call android_ui again.`);
  return e;
}

// ---------- screenshots ----------
export async function screenshot(serial, { annotateElements = false, quality = 70 } = {}) {
  const maxEdge = 1568, maxPixels = 1_150_000;
  const shot = await withHelper(serial, async (h) => {
    const [ , devW, devH, w, hgt, b64] = (await h.send(`shot ${maxEdge} ${maxPixels} ${quality}`, 15000)).split(" ");
    return { jpegIn: Buffer.from(b64, "base64"), deviceW: +devW, deviceH: +devH, imgW: +w, imgH: +hgt, scale: +w / +devW };
  }, async () => {
    const png = await adb(["exec-out", "screencap -p"], { serial, binary: true, timeout: 30000 });
    const raw = decodePng(png);
    const scale = fitScale(raw.width, raw.height, maxEdge, maxPixels);
    const img = scale < 1 ? resize(raw, scale) : { width: raw.width, height: raw.height, data: new Uint8Array(raw.data) };
    return { img, deviceW: raw.width, deviceH: raw.height, imgW: img.width, imgH: img.height, scale };
  });
  let elements = null;
  let jpegOut;
  if (annotateElements) {
    let img = shot.img || decodeJpeg(shot.jpegIn);
    try {
      ({ elements } = await dumpUi(serial));
      annotate(img, elements.filter((e) => e.clickable || e.editable || e.scrollable || e.checkable), shot.scale);
    } catch (e) { elements = { error: e.message }; }
    jpegOut = encodeJpeg(img, quality);
  } else {
    jpegOut = shot.jpegIn || encodeJpeg(shot.img, quality);
  }
  dev(serial).shot = { deviceW: shot.deviceW, deviceH: shot.deviceH, scale: shot.scale, imgW: shot.imgW, imgH: shot.imgH };
  return { jpeg: jpegOut, ...dev(serial).shot, elements };
}

// Coordinates Claude reads off a screenshot are in image space; convert to device pixels.
export function toDevice(serial, x, y, coords = "screenshot") {
  const shot = dev(serial).shot;
  if (coords === "device" || !shot) return { x: Math.round(x), y: Math.round(y) };
  return { x: Math.round(x / shot.scale), y: Math.round(y / shot.scale) };
}

// ---------- input ----------
export async function tapPoint(serial, x, y, { longPress = false, durationMs } = {}) {
  await withHelper(serial,
    (h) => h.send(longPress ? `longpress ${x} ${y} ${durationMs || 700}` : `tap ${x} ${y}`),
    () => longPress ? sh(serial, `input swipe ${x} ${y} ${x} ${y} ${durationMs || 700}`) : sh(serial, `input tap ${x} ${y}`));
}

export async function pressKey(serial, code, times = 1) {
  if (typeof code !== "number") return sh(serial, `input keyevent ${Array(times).fill(code).join(" ")}`);
  await withHelper(serial, async (h) => { for (let i = 0; i < times; i++) await h.send(`key ${code}`); },
    () => sh(serial, `input keyevent ${Array(times).fill(code).join(" ")}`));
}

// Wait for the screen to settle after an action (real idle signal with the helper, fixed delay without).
// With the helper: give a transition time to start, then poll the (15 ms) screen read until two reads
// in a row match, up to ~2.5 s. Without it: fixed delay.
export async function settle(serial, { maxMs = 2500 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await withHelper(serial, async (h) => {
    const end = Date.now() + maxMs;
    await sleep(300);
    await h.send("idle 150 1200", 5000).catch(() => {});
    let prev = await h.send("dump", 5000).then((r) => r.slice(r.indexOf(" ") + 1)).catch(() => null);
    while (Date.now() < end) {
      await sleep(150);
      const cur = await h.send("dump", 5000).then((r) => r.slice(r.indexOf(" ") + 1)).catch(() => null);
      if (cur !== null && cur === prev) return;
      prev = cur;
    }
  }, () => sleep(700));
}

export async function tapElement(serial, el, opts) {
  const c = center(el.bounds);
  await tapPoint(serial, c.x, c.y, opts);
  return c;
}

export async function swipe(serial, x1, y1, x2, y2, durationMs = 300) {
  await withHelper(serial, (h) => h.send(`swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`, durationMs + 10000),
    () => sh(serial, `input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`));
}

export async function screenSize(serial) {
  const shot = dev(serial).shot;
  if (shot) return { w: shot.deviceW, h: shot.deviceH };
  const out = await sh(serial, "wm size");
  const m = /Override size:\s*(\d+)x(\d+)/.exec(out) || /Physical size:\s*(\d+)x(\d+)/.exec(out);
  if (!m) throw new AdbError(`Could not read screen size: ${out}`);
  return { w: +m[1], h: +m[2] };
}

const ASCII_OK = /^[\x20-\x7e\n\t]*$/;
const b64 = (t) => Buffer.from(t, "utf8").toString("base64");

async function typeTextLegacy(serial, text) {
  if (!ASCII_OK.test(text)) {
    throw new AdbError("Plain adb typing only supports ASCII, and the on-phone helper isn't available (or no text field is focused). Tap the text field first, or remove emoji/accented characters.");
  }
  const lines = text.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/\t/g, " ");
    for (let i = 0; i < line.length; i += 80) {
      const chunk = line.slice(i, i + 80).replace(/ /g, "%s");
      if (chunk) await sh(serial, `input text ${quote(chunk)}`);
    }
    if (li < lines.length - 1) await sh(serial, "input keyevent 66");
  }
}

// With the helper: inserts at the cursor (or over the selection) through accessibility, so any
// Unicode works. Password fields that already hold text fall back to IME typing (their text reads back masked).
export async function typeText(serial, text) {
  const insert = async (h, t) => {
    try { await h.send(`settext insert ${b64(t)}`); }
    catch (e) {
      // A field that just appeared may not accept text yet: retry once before falling back.
      if (!(e instanceof HelperError) || /password/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 400));
      await h.send(`settext insert ${b64(t)}`);
    }
  };
  await withHelper(serial, async (h) => {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await insert(h, lines[i]);
      if (i < lines.length - 1) await h.send("key 66");
    }
  }, () => typeTextLegacy(serial, text));
}

export async function clearField(serial, el) {
  await withHelper(serial, (h) => h.send("settext set"), async () => {
    const n = Math.min(200, Math.max(el?.text?.length || 0, 30));
    await sh(serial, `input keyevent 123 ${Array(n).fill(67).join(" ")}`);
  });
}

export const KEYS = {
  back: 4, home: 3, recents: 187, app_switch: 187, enter: 66, delete: 67, backspace: 67, forward_delete: 112,
  tab: 61, escape: 111, space: 62, power: 26, wakeup: 224, sleep: 223, volume_up: 24, volume_down: 25,
  mute: 164, menu: 82, search: 84, camera: 27, play_pause: 85, next: 87, previous: 88,
  dpad_up: 19, dpad_down: 20, dpad_left: 21, dpad_right: 22, dpad_center: 23, move_home: 122, move_end: 123,
  page_up: 92, page_down: 93, brightness_up: 221, brightness_down: 220, screenshot: 120,
};
export const SHELL_KEYS = {
  notifications: "cmd statusbar expand-notifications",
  quick_settings: "cmd statusbar expand-settings",
  collapse_shade: "cmd statusbar collapse",
};

// ---------- apps ----------
export async function listPackages(serial, { thirdPartyOnly = false } = {}) {
  const out = await sh(serial, `pm list packages${thirdPartyOnly ? " -3" : ""}`);
  return out.split(/\r?\n/).map((l) => l.replace(/^package:/, "").trim()).filter(Boolean).sort();
}

export async function resolvePackage(serial, nameOrPkg) {
  const q = nameOrPkg.trim().toLowerCase();
  const all = await listPackages(serial);
  if (all.includes(nameOrPkg.trim())) return { pkg: nameOrPkg.trim(), candidates: [] };
  const tokens = q.split(/[\s._-]+/).filter(Boolean);
  const scored = all.map((p) => {
    const parts = p.toLowerCase().split(".");
    let s = 0;
    for (const t of tokens) {
      if (parts.includes(t)) s += 10;
      else if (parts.some((x) => x.startsWith(t))) s += 6;
      else if (p.toLowerCase().includes(t)) s += 3;
      else s -= 5;
    }
    if (/^(com\.android|android|com\.google\.android\.(gms|gsf)|com\.qualcomm|vendor)/.test(p)) s -= 2;
    return { p, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.p.length - b.p.length);
  return { pkg: scored[0]?.p || null, candidates: scored.slice(0, 6).map((x) => x.p) };
}

// After launching, wait (up to timeoutMs) until the app is actually in front, so an immediate
// observe doesn't return the previous screen. Returns true when it came to the front.
export async function waitForPackage(serial, pkg, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const { nodes } = await dumpUi(serial, { retries: 1 });
      if (nodes.some((n) => n.pkg === pkg)) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export async function launchPackage(serial, pkg, { restart = false } = {}) {
  if (restart) await sh(serial, `am force-stop ${quote(pkg)}`);
  const out = await sh(serial, `monkey -p ${quote(pkg)} -c android.intent.category.LAUNCHER 1`);
  if (/No activities found|monkey aborted/i.test(out)) throw new AdbError(`${pkg} has no launchable activity.`);
}

export async function currentApp(serial) {
  const out = await sh(serial, "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' | head -n 4");
  const m = /mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^}\s]+)\}/.exec(out) || /ActivityRecord\{[^ ]+ [^ ]+ ([^}\s]+)/.exec(out);
  const comp = m ? m[1] : null;
  return { component: comp, package: comp ? comp.split("/")[0] : null, raw: out.trim() };
}

export async function status(serial) {
  const out = await sh(serial,
    "echo MODEL=$(getprop ro.product.manufacturer) $(getprop ro.product.model); echo ANDROID=$(getprop ro.build.version.release) SDK=$(getprop ro.build.version.sdk); " +
    "dumpsys power | grep -m1 -E 'mWakefulness='; dumpsys window | grep -m2 -E 'mDreamingLockscreen|mShowingLockscreen|isKeyguardShowing'; " +
    "dumpsys battery | grep -m2 -E ' level:|AC powered|USB powered'; wm size | tail -n 1; wm density | tail -n 1");
  const app = await currentApp(serial).catch(() => ({}));
  const wake = /mWakefulness=(\w+)/.exec(out)?.[1];
  const locked = /(mShowingLockscreen|mDreamingLockscreen|isKeyguardShowing)[=:]\s*true/.test(out);
  return { summary: out.trim(), screen: wake === "Awake" ? "on" : wake ? "off" : "unknown", locked, foreground: app.component };
}
