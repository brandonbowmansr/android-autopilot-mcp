#!/usr/bin/env node
// Android Control MCP: drive an Android phone over adb. Self-installs adb, no admin rights needed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { adb, adbVersion, listDevices, findAdb, ensureAdb, dataDir } from "./adb.js";
import * as D from "./device.js";
import { formatElements, findElement, center } from "./ui.js";
import { detectWindowsPhones, setupGuide, tcpProbe, explainProbe } from "./setup.js";
import { helperStatus, stopHelper } from "./helper.js";
import * as F from "./fields.js";
import { parseNotifications, findCode } from "./otp.js";
import { setDate } from "./picker.js";
import { remember, discoverClassic, stayReachable, firewallBlocks, firewallAdvice } from "./connect.js";
import * as R from "./recipes.js";

const VERSION = "0.4.0";
const server = new McpServer({ name: "android-control", version: VERSION });

const text = (t) => ({ content: [{ type: "text", text: t }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

const handlers = new Map(); // tool name -> handler, so recipes can replay tools
function tool(name, description, inputSchema, annotations, fn) {
  const run = async (args) => {
    try { return await fn(args || {}); }
    catch (e) { return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  };
  handlers.set(name, run);
  server.registerTool(name, { description, inputSchema, annotations }, run);
}

const serialArg = { serial: z.string().optional().describe("Device serial from android_devices. Omit when one device is connected.") };
const observeArg = {
  observe: z.enum(["none", "ui", "screenshot"]).optional()
    .describe("What to return after the action. Default \"ui\": the new screen as a text element list (cheap, saves a round trip). \"none\" skips it; \"screenshot\" (small image) only when the text list isn't enough."),
};

async function observeAfter(serial, observe = "ui", prefix) {
  if (observe === "none") return text(prefix);
  await D.settle(serial);
  if (observe === "ui") {
    const { elements } = await D.dumpUi(serial);
    return text(`${prefix}\n\nScreen now:\n${formatElements(elements)}`);
  }
  return shotResult(serial, true, prefix, "small");
}

async function shotResult(serial, annotate, prefix = "", size = "small") {
  const s = await D.screenshot(serial, { annotateElements: annotate, maxEdge: D.SHOT_SIZES[size] || D.SHOT_SIZES.small });
  const lines = [
    prefix,
    `Screenshot ${s.imgW}x${s.imgH} (${size}, ~${Math.round((s.imgW * s.imgH) / 750)} tokens; device ${s.deviceW}x${s.deviceH}, scale ${s.scale.toFixed(3)}). x/y you read off this image can be passed straight to android_tap/android_swipe.`,
  ];
  if (annotate && Array.isArray(s.elements)) lines.push(`Numbered boxes = tappable elements. Full list (tap with element=N):\n${formatElements(s.elements)}`);
  else if (annotate && s.elements?.error) lines.push(`(No element overlay: ${s.elements.error})`);
  return { content: [{ type: "image", data: Buffer.from(s.jpeg).toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: lines.filter(Boolean).join("\n") }] };
}

// ---------- setup / connection ----------
const SETUP = `Phone setup (one time, no PC admin rights or USB drivers needed with Wi-Fi):
1. Phone: Settings > About phone > tap "Build number" 7 times to enable Developer options.
2. Settings > System > Developer options > turn on "Wireless debugging" (Android 11+). Phone and PC must be on the same network and able to reach each other.
3. Tap "Wireless debugging" > "Pair device with pairing code". Give Claude the IP:port and 6-digit code shown; Claude calls android_pair.
4. If it doesn't auto-connect, give Claude the IP:port on the main Wireless debugging screen; Claude calls android_connect.
USB alternative: turn on "USB debugging", plug in, accept the prompt on the phone. Some brands (Samsung, etc.) need an OEM USB driver on Windows, which may need admin; Wi-Fi avoids that.`;

async function phoneHints() {
  const det = await detectWindowsPhones().catch(() => ({ usb: [], bluetooth: [] }));
  const lines = [];
  for (const u of det.usb) {
    lines.push(`USB: ${u.name || u.brand} [${u.brand}, ${u.vidpid}] ` +
      (u.problem ? `DRIVER PROBLEM (${u.status})` : u.adbInterface ? "ADB interface present" : "no ADB interface (USB debugging off, prompt not accepted, or missing driver)"));
  }
  for (const b of det.bluetooth) lines.push(`Bluetooth-paired: ${b.name} [${b.brand}] (brand hint only; adb can't run over Bluetooth)`);
  const brand = det.usb[0]?.brand || det.bluetooth[0]?.brand || "";
  return { lines, brand, det };
}

tool("android_doctor", "Check/install adb (auto-downloads Google platform-tools on first run, no admin), detect the user's phone brand on Windows (USB and Bluetooth), list devices, and give brand-specific setup steps. Run this first if anything fails.", {}, READ, async () => {
  const before = findAdb();
  const out = [];
  if (!before.path) out.push(`adb not found (checked: ${before.tried.join("; ")}). Downloading platform-tools into ${dataDir()} ...`);
  const bin = await ensureAdb();
  out.push(`adb: ${bin} (${before.source || "freshly installed"})`, `version: ${await adbVersion()}`);
  const devices = await listDevices();
  out.push(devices.length ? `devices:\n${devices.map((d) => `  ${d.serial}  ${d.state}  ${d.model || ""}  [${d.transport}]`).join("\n")}` : "devices: none connected");
  if (!devices.some((d) => d.state === "device")) {
    const h = await phoneHints();
    if (h.lines.length) out.push("", "Phones Windows can see:", ...h.lines.map((l) => "  " + l));
    const usbNoAdb = h.det.usb.find((u) => !u.adbInterface);
    const method = usbNoAdb ? "usb" : "wifi";
    out.push("", setupGuide(h.brand, method), "",
      h.brand ? `(Brand detected: ${h.brand}. If that's wrong, ask the user which phone they have and call android_setup_guide.)`
              : "(Phone brand unknown: ask the user which phone they have, then call android_setup_guide with brand.)",
      "Other methods: android_setup_guide method=usb | wifi | hotspot (hotspot = when phone and PC are on different/isolated networks).");
    const fw = firewallAdvice(await firewallBlocks().catch(() => []));
    if (fw) out.push("", fw);
  }
  return text(out.join("\n"));
});

tool("android_setup_guide", "Step-by-step phone setup for a specific brand and connection method, including USB driver notes (some brands need an OEM driver that requires admin). Ask the user their phone brand if android_doctor couldn't detect it.", {
  brand: z.string().optional().describe("samsung, google/pixel, motorola, oneplus, oppo, xiaomi/redmi/poco, or other. Omit to auto-detect on Windows."),
  method: z.enum(["wifi", "usb", "hotspot"]).optional().describe("wifi (default; no drivers), usb (may need OEM driver), hotspot (phone joins PC's Mobile Hotspot when networks are isolated)"),
}, READ, async ({ brand, method = "wifi" }) => {
  let b = brand;
  if (!b) b = (await phoneHints()).brand;
  return text(setupGuide(b, method));
});

tool("android_devices", "List connected Android devices and their state. Two connections to the same phone (IP:port and its discovery name) are shown as one phone.", {}, READ, async () => {
  const devices = await listDevices();
  if (!devices.length) return text("No devices. Run android_connect (finds remembered phones), or android_doctor for setup steps.");
  const groups = await D.groupPhysical(devices);
  return text(groups.map((g) => g.length === 1 ? `${g[0].serial}  ${g[0].state}  ${g[0].model || ""}  [${g[0].transport}]`
    : `${g[0].model || "phone"} (one phone, ${g.length} connections; any works, no need to pick):\n${g.map((d) => `  ${d.serial}  ${d.state}  [${d.transport}]`).join("\n")}`).join("\n"));
});

async function rememberConnected(stayOn, hint) {
  D.invalidateDevices();
  const ready = (await listDevices()).filter((d) => d.state === "device" && d.transport === "wifi");
  const notes = [];
  for (const d of ready) {
    const hw = await D.hardwareSerial(d.serial);
    const ip = /^([\d.]+):(\d+)$/.exec(d.serial);
    remember(hw, { model: d.model, ...(ip ? { ip: ip[1], lastHostPort: d.serial } : {}) });
    if (stayOn && (!hint || d.serial === hint || !ip)) {
      const r = await stayReachable(d.serial).catch((e) => ({ ok: false, note: e.message }));
      if (r.ok) { remember(hw, { ip: r.ip, classicPort: r.port, lastHostPort: `${r.ip}:${r.port}` }); notes.push(`Stays reachable at ${r.ip}:${r.port} until the phone reboots: android_connect with no arguments will find it (the phone may ask once to allow this computer).`); }
      else notes.push(`Couldn't switch to port 5555: ${r.note}`);
      break;
    }
  }
  return notes;
}

tool("android_pair", "Pair with a phone over Wi-Fi using the code from Developer options > Wireless debugging > Pair device with pairing code.", {
  host_port: z.string().describe("IP:port shown in the pairing dialog, e.g. 192.168.1.23:37123 (differs from the connect port)"),
  code: z.string().describe("6-digit pairing code"),
  stay_reachable: z.boolean().optional().describe("After connecting, switch the phone to port 5555 so later sessions reconnect with no code (until the phone reboots). Default false."),
}, ACT, async ({ host_port, code, stay_reachable }) => {
  let out;
  try { out = await adb(["pair", host_port.trim(), code.trim()], { timeout: 30000 }); }
  catch (e) { out = e.message; }
  if (!/success/i.test(out)) {
    const [h, p] = host_port.trim().split(":");
    const probe = p ? explainProbe(h, p, await tcpProbe(h, p)) : "";
    return { isError: true, content: [{ type: "text", text: `Pairing did not succeed: ${out.trim()}\n${probe}\nPairing codes expire when the dialog closes; reopen it for a fresh code.` }] };
  }
  const lines = [out.trim()];
  for (let i = 0; i < 4; i++) {
    await sleep(1500);
    const connected = await tryMdnsConnect();
    if (connected.length) { lines.push(`Connected: ${connected.join(", ")}`); break; }
  }
  D.invalidateDevices();
  const ready = (await listDevices()).filter((d) => d.state === "device");
  if (!ready.length) lines.push("Paired, but not connected yet. Send the IP:port from the main Wireless debugging screen and call android_connect.");
  else { lines.push(`Ready: ${ready.map((d) => `${d.serial} ${d.model || ""}`).join("; ")}`); lines.push(...await rememberConnected(stay_reachable)); }
  return text(lines.join("\n"));
});

async function tryMdnsConnect() {
  let out = "";
  try { out = await adb(["mdns", "services"], { timeout: 10000 }); } catch { return []; }
  const targets = [...out.matchAll(/_adb-tls-connect\._tcp\.?\s+([\d.]+:\d+)/g)].map((m) => m[1]);
  const done = [];
  for (const t of [...new Set(targets)]) {
    try { const r = await adb(["connect", t], { timeout: 10000 }); if (/connected/i.test(r) && !/fail|cannot|unable/i.test(r)) done.push(t); } catch {}
  }
  return done;
}

tool("android_connect", "Connect to a paired phone over Wi-Fi. Omit host_port to find it automatically: network discovery, then remembered phones and port 5555 on the local network (e.g. the PC's hotspot).", {
  host_port: z.string().optional().describe("IP:port from the main Wireless debugging screen, e.g. 192.168.1.23:41235"),
  disconnect: z.boolean().optional().describe("Disconnect instead of connect"),
  stay_reachable: z.boolean().optional().describe("After connecting, switch the phone to port 5555 so later sessions reconnect with no code or port (until the phone reboots). Default false."),
}, ACT, async ({ host_port, disconnect, stay_reachable }) => {
  if (disconnect) return text((await adb(host_port ? ["disconnect", host_port] : ["disconnect"], { timeout: 10000 })).trim());
  if (!host_port) {
    let done = await tryMdnsConnect();
    let how = "network discovery";
    if (!done.length) { done = await discoverClassic(); how = "remembered/nearby phones on port 5555"; }
    if (done.length) return text([`Connected via ${how}: ${done.join(", ")}`, ...await rememberConnected(stay_reachable)].join("\n"));
    const fw = firewallAdvice(await firewallBlocks().catch(() => []));
    return text(["No phone found. Send the IP:port from the phone's Wireless debugging screen (it changes each time Wireless debugging restarts), or pair first with android_pair.",
      "Tip: connect once with stay_reachable=true and later sessions reconnect with no arguments.", fw].filter(Boolean).join("\n"));
  }
  let out;
  D.invalidateDevices();
  try { out = (await adb(["connect", host_port.trim()], { timeout: 15000 })).trim(); } catch (e) { out = e.message; }
  if (/fail|cannot|unable|refused|timed out/i.test(out)) {
    const [h, p] = host_port.trim().split(":");
    const probe = p ? explainProbe(h, p, await tcpProbe(h, p)) : "";
    return { isError: true, content: [{ type: "text", text: `${out}\n${probe}\nNew phone? Run android_pair first.` }] };
  }
  return text([out, ...await rememberConnected(stay_reachable, host_port.trim())].join("\n"));
});

tool("android_tcpip", "Switch a phone that's already connected (USB or Wi-Fi) to classic adb-over-TCP on port 5555, so it can be reached over any IP path (hotspot, VPN, etc.) without re-pairing. Resets when the phone reboots.", {
  ...serialArg, port: z.number().int().optional(),
}, ACT, async ({ serial, port = 5555 }) => {
  const s = await D.resolveSerial(serial);
  const ips = (await D.sh(s, "ip -f inet addr show 2>/dev/null | grep -o 'inet [0-9.]*' | grep -v 127.0.0.1").catch(() => "")).match(/[\d.]+/g) || [];
  const out = (await adb(["tcpip", String(port)], { serial: s, timeout: 15000 })).trim();
  const ip = ips.find((x) => /^(10\.|192\.168\.|172\.)/.test(x));
  if (ip) remember(await D.hardwareSerial(s), { ip, classicPort: port, lastHostPort: `${ip}:${port}` });
  return text(`${out}\nPhone IPs: ${ips.join(", ") || "unknown"}. Next: android_connect host_port=<ip>:${port}. The phone listens on port ${port} until reboot; any other computer would still need its own on-phone approval.`);
});

tool("android_select_device", "Choose which device later calls use when several are connected.", { serial: z.string() }, ACT, async ({ serial }) => {
  await D.resolveSerial(serial); D.selectDevice(serial);
  return text(`Default device set to ${serial}`);
});

tool("android_status", "Phone model, Android version, screen on/off, locked, battery, screen size, and foreground app.", serialArg, READ, async ({ serial }) => {
  const s = await D.resolveSerial(serial);
  const st = await D.status(s);
  const awake = (await D.sh(s, `cat ${AWAKE_FILE} 2>/dev/null`).catch(() => "")).trim();
  return text(`serial: ${s}\nscreen: ${st.screen}  locked: ${st.locked}\nforeground: ${st.foreground || "unknown"}\nfast helper: ${helperStatus(s)}\nkeep-awake: ${awake ? "ON (android_keep_awake on=false restores)" : "off"}\n${st.summary}`);
});

// ---------- seeing ----------
tool("android_screenshot", "Capture the phone screen as an image. Costs far more than android_ui: use it only when the text list is empty or unclear (games, maps, webviews, images, checking layout). Draws numbered boxes on tappable elements by default.", {
  ...serialArg,
  annotate: z.boolean().optional().describe("Draw numbered element boxes (default true). Set false for a clean image."),
  size: z.enum(["small", "medium", "large"]).optional().describe("small (default, ~800px tall, ~400 tokens), medium (~1200px, ~850 tokens), large (~1568px, ~1500 tokens). Go bigger only to read small print."),
}, READ, async ({ serial, annotate = true, size = "small" }) => shotResult(await D.resolveSerial(serial), annotate, "", size));

tool("android_ui", "Read the current screen as a numbered list of elements (text, buttons, inputs, scroll areas). Faster and more precise than a screenshot; use the numbers with android_tap/android_type.", {
  ...serialArg,
  query: z.string().optional().describe("Only show elements whose text/description/id contains this"),
  all: z.boolean().optional().describe("Include every node, not just meaningful ones"),
  full_text: z.boolean().optional().describe("Show long text in full instead of cutting it at 80 chars (input fields already show 300)"),
}, READ, async ({ serial, query, all, full_text }) => {
  const s = await D.resolveSerial(serial);
  const { nodes, elements } = await D.dumpUi(s, { mode: all ? "all" : "useful" });
  const pkg = nodes.find((n) => n.pkg)?.pkg;
  const app = pkg ? { component: pkg } : await D.currentApp(s).catch(() => ({}));
  let list = elements;
  if (query) { const q = query.toLowerCase(); list = elements.filter((e) => [e.label, e.text, e.desc, e.id].some((f) => (f || "").toLowerCase().includes(q))); }
  return text(`app: ${app.component || "unknown"}\n${list.length ? formatElements(list, { maxLen: full_text ? Infinity : 80 }) : "(no matching elements)"}`);
});

// ---------- acting ----------
const coordsArg = z.enum(["screenshot", "device"]).optional().describe("x/y are screenshot-image pixels (default, after android_screenshot) or raw device pixels");

async function pickTarget(s, { element, text: t, x, y, coords }) {
  if (element !== undefined) { const e = D.cachedElement(s, element); return { pt: center(e.bounds), el: e, why: `element ${element} "${e.label}"` }; }
  if (t) {
    const { elements } = await D.dumpUi(s);
    const hit = findElement(elements, t);
    if (!hit) throw new Error(`No element matching "${t}". Call android_ui to see what's on screen.`);
    if (hit.ambiguous) {
      const where = (e) => { const c = center(e.bounds); return `${c.y < 800 ? "top" : c.y > 1600 ? "bottom" : "middle"}${c.x < 360 ? "-left" : c.x > 720 ? "-right" : ""}`; };
      throw new Error(`"${t}" matches ${hit.ambiguous.length} different elements equally well, so I didn't guess:\n` +
        hit.ambiguous.slice(0, 8).map((e) => `  [${e.index}] ${e.cls} "${e.label}"${e.id ? " id=" + e.id.replace(/^[\w.]+:id\//, "") : ""} (${where(e)})`).join("\n") +
        "\nTap one by element number, or use more specific text.");
    }
    const note = hit.count > 1 ? ` (best of ${hit.count} matches)` : "";
    return { pt: center(hit.best.bounds), el: hit.best, why: `"${hit.best.label || t}"${note}` };
  }
  if (x !== undefined && y !== undefined) { const pt = D.toDevice(s, x, y, coords); return { pt, why: `(${x},${y}) -> device (${pt.x},${pt.y})` }; }
  throw new Error("Give element (number from android_ui/android_screenshot), text, or x+y.");
}

// Pick the target, then make sure the on-screen keyboard isn't covering it.
async function tapTarget(s, a) {
  const t = await pickTarget(s, a);
  const refind = t.el ? async () => {
    if (a.text) return pickTarget(s, { text: a.text });
    const { elements } = await D.dumpUi(s);
    const e = elements.find((x) => x.id === t.el.id && x.label === t.el.label && x.cls === t.el.cls) || (t.el.label && elements.find((x) => x.label === t.el.label));
    return e ? { pt: center(e.bounds), el: e, why: `element [${e.index}] "${e.label}"` } : null;
  } : null;
  return F.guardTap(s, t, { allowKeyboard: a.allow_keyboard, refind });
}

const targetArgs = {
  element: z.number().int().optional().describe("Element number from the last android_ui / android_screenshot"),
  text: z.string().optional().describe("Tap the element whose text, description or id matches this (fresh lookup)"),
  x: z.number().optional(), y: z.number().optional(), coords: coordsArg,
  allow_keyboard: z.boolean().optional().describe("Allow tapping a point on the on-screen keyboard (normally blocked, since it types a stray key)"),
};

tool("android_tap", "Tap (or long-press) an element by number, by visible text, or by x/y.", {
  ...serialArg, ...targetArgs,
  long_press: z.boolean().optional(), duration_ms: z.number().int().optional().describe("Long-press duration (default 700)"),
  ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  const t = await tapTarget(s, a);
  await D.tapPoint(s, t.pt.x, t.pt.y, { longPress: a.long_press, durationMs: a.duration_ms });
  if (t.el?.editable || !t.el) D.devState(s).kbMaybeUp = true; // a field (or an unknown point) may have opened the keyboard
  return observeAfter(s, a.observe, `${a.long_press ? "Long-pressed" : "Tapped"} ${t.why}`);
});

tool("android_type", "Type text into the focused field, or tap a field first (element/text/x,y). Inserts at the cursor. Reads the field back afterwards and reports a mismatch; with clear=true it retries once, slowly, if the field doesn't match. Refuses while the phone is locked. Any Unicode incl. emoji when the on-phone helper is running; plain ASCII otherwise. Newlines press Enter.", {
  ...serialArg,
  value: z.string().describe("Text to type"),
  element: targetArgs.element, text: z.string().optional().describe("Field to tap first, matched by its text/hint/id"),
  x: targetArgs.x, y: targetArgs.y, coords: coordsArg,
  clear: z.boolean().optional().describe("Clear the field first (checked: falls back to select-all + delete, then backspaces)"),
  submit: z.boolean().optional().describe("Press Enter after typing"),
  method: z.enum(["auto", "keys"]).optional().describe("auto (default, fast) or keys: one character at a time through the keyboard, for laggy apps that drop letters (ASCII only)"),
  key_delay_ms: z.number().int().min(0).max(1000).optional().describe("Pause between characters for method=keys (default 60)"),
  verify: z.boolean().optional().describe("Read the field back after typing (default true)"),
  secret: z.boolean().optional().describe("Don't echo the value back in the result (passwords)"),
  ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  await F.assertUnlocked(s);
  let el = null; let why = "focused field";
  if (a.element !== undefined || a.text || (a.x !== undefined && a.y !== undefined)) {
    let t;
    if (a.text && a.element === undefined) { // prefer the input field itself, even when the text is its label
      const f = resolveField((await D.dumpUi(s)).elements, a.text);
      if (f) t = await F.guardTap(s, { pt: center(f.bounds), el: f, why: `field "${a.text}"` }, {
        refind: async () => { const g = resolveField((await D.dumpUi(s)).elements, a.text); return g ? { pt: center(g.bounds), el: g, why: `field "${a.text}"` } : null; } });
    }
    if (!t) t = await tapTarget(s, a);
    el = t.el; why = t.why;
    await D.tapPoint(s, t.pt.x, t.pt.y); await sleep(350);
    if (el?.editable) D.devState(s).kbMaybeUp = true;
  }
  let clearNote = "";
  if (a.clear) { const c = await F.clearVerified(s, el); if (!c.ok) clearNote = ` WARNING: field still held "${c.left}" after clearing.`; }
  const r = await F.typeVerified(s, a.value, { el, replace: !!a.clear, method: a.method, delayMs: a.key_delay_ms ?? 60, verify: a.verify !== false });
  if (a.submit) await D.pressKey(s, 66);
  const shown = (v) => (a.secret ? `${(v || "").length} chars` : `"${v}"`);
  const check = r.ok === true ? `verified${r.note ? ` (${r.note})` : ""}` : r.ok === false ? `MISMATCH: field shows ${shown(r.got)}${r.note ? ` (${r.note})` : ""}` : r.note || "not verified";
  const res = await observeAfter(s, a.observe, `Typed ${a.value.length} chars into ${why}${a.submit ? " and pressed Enter" : ""}: ${check}.${clearNote}${r.attempts.length > 1 ? ` Attempts: ${r.attempts.join(" -> ")}.` : ""}`);
  if (r.ok === false) res.isError = true;
  return res;
});

tool("android_swipe", "Swipe from one point to another (x/y in screenshot pixels by default).", {
  ...serialArg, x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
  duration_ms: z.number().int().optional().describe("Default 300; longer = slower drag"), coords: coordsArg, ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  const p1 = D.toDevice(s, a.x1, a.y1, a.coords), p2 = D.toDevice(s, a.x2, a.y2, a.coords);
  await D.swipe(s, p1.x, p1.y, p2.x, p2.y, a.duration_ms || 300);
  return observeAfter(s, a.observe, `Swiped (${p1.x},${p1.y}) -> (${p2.x},${p2.y})`);
});

tool("android_scroll", "Scroll the screen or a scrollable element. direction = where you want to move the view (down = see content further down).", {
  ...serialArg, direction: z.enum(["up", "down", "left", "right"]),
  element: z.number().int().optional().describe("Scrollable element number; default whole screen"),
  amount: z.number().min(0.1).max(1).optional().describe("Fraction of the area to scroll (default 0.6)"),
  ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  let b;
  if (a.element !== undefined) b = D.cachedElement(s, a.element).bounds;
  else { const { w, h } = await D.screenSize(s); b = { x1: 0, y1: Math.round(h * 0.15), x2: w, y2: Math.round(h * 0.85) }; }
  const f = a.amount || 0.6; const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
  const dx = ((b.x2 - b.x1) * f) / 2, dy = ((b.y2 - b.y1) * f) / 2;
  const v = { down: [cx, cy + dy, cx, cy - dy], up: [cx, cy - dy, cx, cy + dy], right: [cx + dx, cy, cx - dx, cy], left: [cx - dx, cy, cx + dx, cy] }[a.direction].map(Math.round);
  await D.swipe(s, ...v, 400);
  return observeAfter(s, a.observe, `Scrolled ${a.direction}`);
});

tool("android_key", `Press a key or system button. Names: ${[...Object.keys(D.KEYS), ...Object.keys(D.SHELL_KEYS)].join(", ")}; or a numeric Android keycode.`, {
  ...serialArg, key: z.string(), times: z.number().int().min(1).max(50).optional(), ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  const k = a.key.toLowerCase().replace(/[\s-]/g, "_");
  if (D.SHELL_KEYS[k]) await D.sh(s, D.SHELL_KEYS[k]);
  else {
    const code = D.KEYS[k] ?? (/^\d+$/.test(k) ? +k : /^keycode_\w+$/i.test(a.key) ? a.key.toUpperCase() : null);
    if (code === null) throw new Error(`Unknown key "${a.key}".`);
    await D.pressKey(s, code, a.times || 1);
  }
  return observeAfter(s, a.observe, `Pressed ${a.key}${a.times > 1 ? ` x${a.times}` : ""}`);
});

tool("android_unlock", "Wake the screen and swipe up past the lock screen. Optionally enter a PIN/password (sent in plain text over adb; only if you're comfortable with that).", {
  ...serialArg, pin: z.string().optional(), ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  await D.sh(s, "input keyevent 224"); await sleep(400);
  const { w, h } = await D.screenSize(s);
  await D.swipe(s, Math.round(w / 2), Math.round(h * 0.85), Math.round(w / 2), Math.round(h * 0.3), 250);
  if (a.pin) { await sleep(600); await D.typeText(s, a.pin); await D.sh(s, "input keyevent 66"); }
  await sleep(500);
  F.forgetScreenState(s);
  const st = await D.status(s);
  return observeAfter(s, a.observe, `Screen ${st.screen}, locked: ${st.locked}${st.locked && !a.pin ? " (a PIN/pattern is set: unlock by hand or pass pin)" : ""}`);
});

// ---------- apps ----------
tool("android_launch_app", "Open an app by package name or by a name fragment (e.g. 'outlook', 'teams', 'chrome'). Apps normally resume where they were left; restart=true opens the app fresh at its main screen.", {
  ...serialArg, app: z.string(),
  restart: z.boolean().optional().describe("Force-stop first so the app opens at its main screen (unsaved in-app state is lost)"),
  ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  const { pkg, candidates } = await D.resolvePackage(s, a.app);
  if (!pkg) throw new Error(`No installed package matches "${a.app}". Use android_list_apps to search.`);
  await D.launchPackage(s, pkg, { restart: a.restart });
  const front = await D.waitForPackage(s, pkg);
  const alt = candidates.filter((c) => c !== pkg).slice(0, 3);
  return observeAfter(s, a.observe, `Launched ${pkg}${front ? "" : " (not in front after 4 s: it may be showing a permission prompt or still loading)"}${alt.length ? ` (other matches: ${alt.join(", ")})` : ""}`);
});

tool("android_list_apps", "List installed app packages, optionally filtered.", {
  ...serialArg, query: z.string().optional(), include_system: z.boolean().optional().describe("Include system packages (default: user-installed only)"),
}, READ, async (a) => {
  const s = await D.resolveSerial(a.serial);
  let pk = await D.listPackages(s, { thirdPartyOnly: !a.include_system && !a.query });
  if (a.query) { const q = a.query.toLowerCase(); pk = pk.filter((p) => p.toLowerCase().includes(q)); }
  return text(pk.length ? pk.join("\n") : "(none)");
});

tool("android_open_url", "Open a URL or deep link (https:, tel:, mailto:, geo:, app schemes) on the phone.", {
  ...serialArg, url: z.string(), ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  const out = await D.sh(s, `am start -a android.intent.action.VIEW -d ${D.quote(a.url)}`);
  if (/Error/i.test(out)) throw new Error(out.trim());
  return observeAfter(s, a.observe, `Opened ${a.url}`);
});

tool("android_wait_for", "Wait until an element with this text appears (or disappears). Polls the UI tree; max 45 s.", {
  ...serialArg, text: z.string(), gone: z.boolean().optional(), timeout_s: z.number().min(1).max(45).optional(),
}, READ, async (a) => {
  const s = await D.resolveSerial(a.serial);
  const end = Date.now() + (a.timeout_s || 15) * 1000;
  while (Date.now() < end) {
    try {
      const { elements } = await D.dumpUi(s, { retries: 1 });
      const hit = findElement(elements, a.text);
      if (!!hit !== !!a.gone) return text(a.gone ? `"${a.text}" is gone` : `Found [${hit.best.index}] "${hit.best.label}"\n\n${formatElements(elements)}`);
    } catch {}
    await sleep(300);
  }
  return { isError: true, content: [{ type: "text", text: `Timed out waiting for "${a.text}" to ${a.gone ? "disappear" : "appear"}` }] };
});

tool("android_shell", "Run a raw adb shell command on the phone (advanced: am, pm, settings, dumpsys, input, etc.).", {
  ...serialArg, command: z.string(), timeout_s: z.number().min(1).max(55).optional(),
}, { readOnlyHint: false, destructiveHint: true, openWorldHint: false }, async (a) => {
  const s = await D.resolveSerial(a.serial);
  if (/uiautomator/.test(a.command)) stopHelper(s); // it needs the UiAutomation slot the helper holds
  const out = await D.sh(s, a.command, { timeout: (a.timeout_s || 30) * 1000 });
  return text(out.length > 20000 ? out.slice(0, 20000) + `\n... (${out.length - 20000} more chars truncated)` : out || "(no output)");
});

// ---------- forms, dates, codes ----------
// Find an input field by its label/hint/id. If the text belongs to a label next to the field rather than
// the field itself, use the nearest input below or right of that label.
function resolveField(elements, q) {
  const eds = elements.filter((e) => e.editable);
  const direct = findElement(eds, q);
  if (direct && !direct.ambiguous) return direct.best;
  if (direct?.ambiguous) throw new Error(`"${q}" matches ${direct.ambiguous.length} input fields: ${direct.ambiguous.map((e) => `[${e.index}] ${e.hint || e.label}`).join(", ")}. Use a more specific name or element number.`);
  const lab = findElement(elements.filter((e) => !e.editable), q);
  if (!lab) return null;
  const lb = lab.best.bounds;
  const near = eds.map((e) => {
    const b = e.bounds;
    const below = b.y1 >= lb.y1 - 10 && b.y1 - lb.y2 < 320 && b.x1 < lb.x2 + 40 && b.x2 > lb.x1 - 40;
    const right = Math.abs((b.y1 + b.y2) / 2 - (lb.y1 + lb.y2) / 2) < 60 && b.x1 >= lb.x2 - 10;
    return { e, d: below ? b.y1 - lb.y2 : right ? b.x1 - lb.x2 + 1000 : Infinity };
  }).filter((x) => Number.isFinite(x.d)).sort((a, b) => a.d - b.d);
  return near[0]?.e || null;
}

tool("android_fill_form", "Fill several input fields in one call. For each field: find it (by label, hint, id or element number), tap it, clear it, type the value, read it back, and retry once slowly if it doesn't match. Scrolls to find fields that are off screen and closes the keyboard if it covers one. Optionally taps a submit button at the end. Refuses while the phone is locked.", {
  ...serialArg,
  fields: z.array(z.object({
    field: z.string().optional().describe("Label, hint or id of the input (e.g. \"Email\", \"First name\")"),
    element: z.number().int().optional().describe("Element number from the last android_ui instead of a name"),
    value: z.string(),
    clear: z.boolean().optional().describe("Clear first (default true)"),
    method: z.enum(["auto", "keys"]).optional().describe("keys = one character at a time, for laggy fields"),
    secret: z.boolean().optional().describe("Don't echo this value in the result"),
  })).min(1).max(30),
  submit: z.string().optional().describe("Text of a button to tap after all fields match (e.g. \"Continue\"). Skipped if any field failed."),
  ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  await F.assertUnlocked(s);
  const start = D.devState(s).elements.map((e) => ({ ...e })); // element numbers refer to the list the caller saw
  const rows = []; let allOk = true;
  for (const f of a.fields) {
    const name = f.field || `element ${f.element}`;
    const shown = (v) => (f.secret ? `${(v || "").length} chars` : `"${v}"`);
    try {
      const locate = async () => {
        const { elements } = await D.dumpUi(s);
        if (f.element !== undefined) {
          const was = start.find((e) => e.index === f.element);
          if (!was) throw new Error(`element ${f.element} isn't in the last list`);
          return elements.find((e) => e.editable && e.id === was.id && e.hint === was.hint && (!was.id || Math.abs(e.bounds.y1 - was.bounds.y1) < 400))
            || elements.find((e) => e.editable && e.bounds.x1 === was.bounds.x1 && e.bounds.y1 === was.bounds.y1) || null;
        }
        return resolveField(elements, f.field);
      };
      let el = await locate();
      for (let i = 0; !el && i < 3; i++) { // off screen: close the keyboard, scroll down, look again
        await F.hideKeyboard(s);
        const { w, h } = await D.screenSize(s);
        await D.swipe(s, Math.round(w / 2), Math.round(h * 0.7), Math.round(w / 2), Math.round(h * 0.35), 350);
        await sleep(400);
        el = await locate();
      }
      if (!el) throw new Error("not found on screen");
      const t = await F.guardTap(s, { pt: center(el.bounds), el, why: name }, {
        refind: async () => { const e2 = await locate(); return e2 ? { pt: center(e2.bounds), el: e2, why: name } : null; },
      });
      el = t.el;
      await D.tapPoint(s, t.pt.x, t.pt.y); await sleep(300);
      D.devState(s).kbMaybeUp = true;
      if (f.clear !== false) { const c = await F.clearVerified(s, el); if (!c.ok) throw new Error(`couldn't clear it (still "${c.left}")`); }
      const r = await F.typeVerified(s, f.value, { el, replace: f.clear !== false, method: f.method });
      if (r.ok === false) { allOk = false; rows.push(`FAIL ${name}: shows ${shown(r.got)}${r.note ? ` (${r.note})` : ""}`); }
      else rows.push(`ok   ${name}${f.secret ? "" : ` = "${f.value}"`}${r.ok === null ? ` (${r.note})` : r.note ? ` (${r.note})` : ""}`);
    } catch (e) { allOk = false; rows.push(`FAIL ${name}: ${e.message}`); }
  }
  if (a.submit) {
    if (!allOk) rows.push(`Did not tap "${a.submit}" because a field failed.`);
    else {
      await F.hideKeyboard(s);
      const { elements } = await D.dumpUi(s);
      const hit = findElement(elements, a.submit);
      if (!hit || hit.ambiguous) { allOk = false; rows.push(`FAIL submit: ${hit ? "several buttons match" : "no button"} "${a.submit}"`); }
      else { await D.tapPoint(s, center(hit.best.bounds).x, center(hit.best.bounds).y); rows.push(`Tapped "${hit.best.label}"`); }
    }
  }
  const res = await observeAfter(s, a.observe, `${allOk ? "All fields filled and verified." : "Some fields need attention."}\n${rows.join("\n")}`);
  if (!allOk) res.isError = true;
  return res;
});

tool("android_set_date", "Set the date picker that's open on screen to a date in one call: spinner/wheel pickers (month, day, year columns) or calendar pickers with a text-input mode. Checks the result, then taps OK/Set/Done.", {
  ...serialArg,
  date: z.string().describe("YYYY-MM-DD"),
  confirm: z.boolean().optional().describe("Tap OK/Set/Done afterwards (default true)"),
  format: z.string().optional().describe("For text-input pickers: how to type it, e.g. MM/DD/YYYY (default: guessed from the field's hint)"),
  ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  await F.assertUnlocked(s);
  const r = await setDate(s, a.date, { confirm: a.confirm !== false, format: a.format });
  const res = await observeAfter(s, a.observe, r.text);
  if (!r.ok) res.isError = true;
  return res;
});

tool("android_get_otp", "Read the latest verification / one-time code from the phone's notifications (SMS, email, app pushes). Filter by app, sender or text; optionally wait for a new one to arrive.", {
  ...serialArg,
  app: z.string().optional().describe("Package or part of it, e.g. \"messaging\", \"gmail\", \"shiftsmart\""),
  from: z.string().optional().describe("Sender / notification title contains this"),
  contains: z.string().optional().describe("Message text contains this, e.g. the app's name"),
  max_age_s: z.number().int().min(10).max(86400).optional().describe("Ignore codes older than this (default 600)"),
  wait_s: z.number().int().min(0).max(120).optional().describe("Wait up to this long for a code that arrives after this call (default 0 = just read)"),
}, READ, async (a) => {
  const s = await D.resolveSerial(a.serial);
  const startedAt = Date.now() - 5000;
  const end = Date.now() + (a.wait_s || 0) * 1000;
  const opts = { app: a.app, from: a.from, contains: a.contains, maxAgeMs: (a.max_age_s || 600) * 1000, newerThan: a.wait_s ? startedAt : 0 };
  let baseline = null; // when waiting: codes already showing at the start don't count (some phones omit timestamps)
  for (;;) {
    const dump = await D.sh(s, "dumpsys notification --noredact", { timeout: 20000 });
    let list = parseNotifications(dump);
    const keyOf = (n) => `${n.pkg}|${n.title}|${n.text}`;
    if (a.wait_s) {
      if (!baseline) baseline = new Set(list.filter((n) => !n.when).map(keyOf));
      list = list.filter((n) => n.when || !baseline.has(keyOf(n)));
    }
    const hit = findCode(list, opts);
    if (hit) {
      const age = hit.when ? `${Math.round((Date.now() - hit.when) / 1000)} s ago` : "time unknown";
      return text(`Code: ${hit.code}\nfrom: ${hit.pkg}${hit.title ? ` "${hit.title}"` : ""} (${age})\nmessage: ${hit.text.slice(0, 160)}`);
    }
    if (Date.now() >= end) break;
    await sleep(2000);
  }
  return { isError: true, content: [{ type: "text", text: `No matching code in notifications${a.wait_s ? ` after waiting ${a.wait_s} s` : ""}. Codes sent to a number the phone can't receive (no signal, VoIP number) won't show up; check filters too.` }] };
});

// ---------- keep awake ----------
const AWAKE_FILE = "/data/local/tmp/acm-keep-awake.txt";
async function restoreAwake(s) {
  const saved = (await D.sh(s, `cat ${AWAKE_FILE} 2>/dev/null`).catch(() => "")).trim();
  if (!saved) return null;
  const [stay, timeout] = saved.split(/\s+/);
  const put = (ns, k, v) => (v && v !== "null" ? `settings put ${ns} ${k} ${v}` : `settings delete ${ns} ${k}`);
  await D.sh(s, `${put("global", "stay_on_while_plugged_in", stay)}; ${put("system", "screen_off_timeout", timeout)}; rm -f ${AWAKE_FILE}`);
  return { stay, timeout };
}
const awakeSerials = new Set();
process.on("exit", () => { // best-effort restore if the server stops while keep-awake is on
  const bin = findAdb().path; if (!bin) return;
  for (const s of awakeSerials) {
    try {
      execFileSync(bin, ["-s", s, "shell", `f=${AWAKE_FILE}; [ -f $f ] && set -- $(cat $f) && { [ "$1" = null ] && settings delete global stay_on_while_plugged_in || settings put global stay_on_while_plugged_in $1; [ "$2" = null ] && settings delete system screen_off_timeout || settings put system screen_off_timeout $2; rm -f $f; }`], { timeout: 5000, windowsHide: true });
    } catch {}
  }
});

tool("android_keep_awake", "Keep the phone's screen from sleeping during a task (so typing isn't lost to the lock screen), and put the original settings back afterwards. The originals are saved on the phone, so on=false restores them even from a later session; they're also restored if this server stops.", {
  ...serialArg,
  on: z.boolean().describe("true = keep awake, false = restore the phone's own settings"),
  minutes: z.number().int().min(1).max(240).optional().describe("Screen timeout while on (default 30). Staying on while charging is also enabled."),
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  if (!a.on) {
    const r = await restoreAwake(s); awakeSerials.delete(s);
    return text(r ? `Restored: stay-on-while-charging=${r.stay}, screen timeout=${r.timeout} ms.` : "Keep-awake wasn't on; nothing to restore.");
  }
  const has = (await D.sh(s, `cat ${AWAKE_FILE} 2>/dev/null`).catch(() => "")).trim();
  if (!has) {
    const cur = await D.sh(s, "echo $(settings get global stay_on_while_plugged_in) $(settings get system screen_off_timeout)");
    await D.sh(s, `echo ${D.quote(cur.trim())} > ${AWAKE_FILE}`);
  }
  const ms = (a.minutes || 30) * 60000;
  await D.sh(s, `settings put global stay_on_while_plugged_in 7; settings put system screen_off_timeout ${ms}; input keyevent 224`);
  awakeSerials.add(s); F.forgetScreenState(s);
  return text(`Keep-awake on: screen timeout ${a.minutes || 30} min, stays on while charging. Originals saved on the phone${has ? " (from the earlier keep-awake)" : ""}. Call android_keep_awake on=false when done.`);
});

// ---------- recipes ----------
tool("android_recipe", "Saved step lists for apps you use often (sign in, fill a profile, grab a code), replayed in one call with checks between steps. Actions: list, show, save, run, delete. Put personal values in {{vars}} and pass them at run time; never save passwords or IDs inside a recipe.", {
  action: z.enum(["list", "show", "save", "run", "delete"]),
  name: z.string().optional(),
  recipe: z.object({
    description: z.string().optional(),
    steps: z.array(z.object({
      do: z.enum(R.STEP_TOOLS).describe("Tool to run, without the android_ prefix"),
      args: z.record(z.string(), z.any()).optional(),
      expect: z.string().optional().describe("Text that must appear on screen after this step"),
      timeout_s: z.number().min(1).max(45).optional().describe("How long to wait for expect (default 10)"),
      save_as: z.string().optional().describe("get_otp only: store the code in this var for later steps"),
    })).min(1).max(60),
  }).optional().describe("For save"),
  vars: z.record(z.string(), z.string()).optional().describe("For run: values for {{placeholders}}"),
  serial: serialArg.serial,
}, ACT, async (a) => {
  if (a.action === "list") {
    const l = R.listRecipes();
    return text(l.length ? l.map((r) => `${r.name} (${r.steps} steps${r.vars.length ? `, vars: ${r.vars.join(", ")}` : ""})${r.description ? ` - ${r.description}` : ""}`).join("\n") : "No recipes saved yet.");
  }
  if (!a.name) throw new Error("name is required");
  if (a.action === "show") return text(JSON.stringify(R.loadRecipe(a.name), null, 2));
  if (a.action === "delete") { R.deleteRecipe(a.name); return text(`Deleted ${a.name}.`); }
  if (a.action === "save") {
    if (!a.recipe) throw new Error("recipe is required for save");
    const vars = R.saveRecipe(a.name, a.recipe);
    return text(`Saved ${a.name} (${a.recipe.steps.length} steps${vars.length ? `, vars: ${vars.join(", ")}` : ""}).`);
  }
  const rec = R.loadRecipe(a.name);
  const vars = { ...(a.vars || {}) };
  const log = [];
  for (let i = 0; i < rec.steps.length; i++) {
    const st = rec.steps[i];
    const args = { ...R.fillVars(st.args || {}, vars), ...(a.serial ? { serial: a.serial } : {}) };
    if (!["ui", "wait_for", "get_otp"].includes(st.do)) args.observe = "none";
    const r = await handlers.get(`android_${st.do}`)(args);
    const out = r.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").replace(/\s+/g, " ");
    if (r.isError) {
      log.push(`${i + 1}. ${st.do}: FAILED - ${out.slice(0, 300)}`);
      const s = await D.resolveSerial(a.serial);
      const { elements } = await D.dumpUi(s).catch(() => ({ elements: [] }));
      return { isError: true, content: [{ type: "text", text: `Recipe ${a.name} stopped at step ${i + 1} of ${rec.steps.length}.\n${log.join("\n")}\n\nScreen now:\n${formatElements(elements)}` }] };
    }
    if (st.save_as) { const m = /Code: (\S+)/.exec(out); if (m) vars[st.save_as] = m[1]; }
    let line = `${i + 1}. ${st.do}: ok`;
    if (st.expect) {
      const w = await handlers.get("android_wait_for")({ serial: a.serial, text: R.fillVars(st.expect, vars), timeout_s: st.timeout_s || 10 });
      if (w.isError) {
        log.push(`${line}, but "${st.expect}" never appeared`);
        const s = await D.resolveSerial(a.serial);
        const { elements } = await D.dumpUi(s).catch(() => ({ elements: [] }));
        return { isError: true, content: [{ type: "text", text: `Recipe ${a.name} stopped after step ${i + 1}: expected "${st.expect}" on screen.\n${log.join("\n")}\n\nScreen now:\n${formatElements(elements)}` }] };
      }
      line += `, saw "${st.expect}"`;
    }
    log.push(line);
  }
  return text(`Recipe ${a.name} finished (${rec.steps.length} steps).\n${log.join("\n")}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[android-control] v${VERSION} ready. data dir: ${dataDir()}`);
