#!/usr/bin/env node
// Android Control MCP: drive an Android phone over adb. Self-installs adb, no admin rights needed.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { adb, adbVersion, listDevices, findAdb, ensureAdb, dataDir } from "./adb.js";
import * as D from "./device.js";
import { formatElements, findElement, center } from "./ui.js";
import { detectWindowsPhones, setupGuide, tcpProbe, explainProbe } from "./setup.js";
import { helperStatus } from "./helper.js";

const VERSION = "0.3.1";
const server = new McpServer({ name: "android-control", version: VERSION });

const text = (t) => ({ content: [{ type: "text", text: t }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

function tool(name, description, inputSchema, annotations, fn) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try { return await fn(args || {}); }
    catch (e) { return { isError: true, content: [{ type: "text", text: `Error: ${e.message}` }] }; }
  });
}

const serialArg = { serial: z.string().optional().describe("Device serial from android_devices. Omit when one device is connected.") };
const observeArg = {
  observe: z.enum(["none", "ui", "screenshot"]).optional()
    .describe("After the action, wait briefly and return the new UI element list or an annotated screenshot. Saves a round trip."),
};

async function observeAfter(serial, observe, prefix) {
  if (!observe || observe === "none") return text(prefix);
  await D.settle(serial);
  if (observe === "ui") {
    const { elements } = await D.dumpUi(serial);
    return text(`${prefix}\n\nScreen now:\n${formatElements(elements)}`);
  }
  return shotResult(serial, true, prefix);
}

async function shotResult(serial, annotate, prefix = "") {
  const s = await D.screenshot(serial, { annotateElements: annotate });
  const lines = [
    prefix,
    `Screenshot ${s.imgW}x${s.imgH} (device ${s.deviceW}x${s.deviceH}, scale ${s.scale.toFixed(3)}). x/y you read off this image can be passed straight to android_tap/android_swipe.`,
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

tool("android_devices", "List connected Android devices and their state.", {}, READ, async () => {
  const devices = await listDevices();
  return text(devices.length ? devices.map((d) => `${d.serial}  ${d.state}  ${d.model || ""}  [${d.transport}]`).join("\n") : "No devices. Run android_doctor for setup steps.");
});

tool("android_pair", "Pair with a phone over Wi-Fi using the code from Developer options > Wireless debugging > Pair device with pairing code.", {
  host_port: z.string().describe("IP:port shown in the pairing dialog, e.g. 192.168.1.23:37123 (differs from the connect port)"),
  code: z.string().describe("6-digit pairing code"),
}, ACT, async ({ host_port, code }) => {
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
  else lines.push(`Ready: ${ready.map((d) => `${d.serial} ${d.model || ""}`).join("; ")}`);
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

tool("android_connect", "Connect to a paired phone over Wi-Fi. Omit host_port to auto-discover paired phones on the network.", {
  host_port: z.string().optional().describe("IP:port from the main Wireless debugging screen, e.g. 192.168.1.23:41235"),
  disconnect: z.boolean().optional().describe("Disconnect instead of connect"),
}, ACT, async ({ host_port, disconnect }) => {
  if (disconnect) return text((await adb(host_port ? ["disconnect", host_port] : ["disconnect"], { timeout: 10000 })).trim());
  if (!host_port) {
    const done = await tryMdnsConnect();
    return text(done.length ? `Connected: ${done.join(", ")}` : "No paired phones discovered. Pass host_port from the Wireless debugging screen, or pair first with android_pair.");
  }
  let out;
  D.invalidateDevices();
  try { out = (await adb(["connect", host_port.trim()], { timeout: 15000 })).trim(); } catch (e) { out = e.message; }
  if (/fail|cannot|unable|refused|timed out/i.test(out)) {
    const [h, p] = host_port.trim().split(":");
    const probe = p ? explainProbe(h, p, await tcpProbe(h, p)) : "";
    return { isError: true, content: [{ type: "text", text: `${out}\n${probe}\nNew phone? Run android_pair first.` }] };
  }
  return text(out);
});

tool("android_tcpip", "Switch a phone that's already connected (USB or Wi-Fi) to classic adb-over-TCP on port 5555, so it can be reached over any IP path (hotspot, VPN, etc.) without re-pairing. Resets when the phone reboots.", {
  ...serialArg, port: z.number().int().optional(),
}, ACT, async ({ serial, port = 5555 }) => {
  const s = await D.resolveSerial(serial);
  const ips = (await D.sh(s, "ip -f inet addr show 2>/dev/null | grep -o 'inet [0-9.]*' | grep -v 127.0.0.1").catch(() => "")).match(/[\d.]+/g) || [];
  const out = (await adb(["tcpip", String(port)], { serial: s, timeout: 15000 })).trim();
  return text(`${out}\nPhone IPs: ${ips.join(", ") || "unknown"}. Next: android_connect host_port=<ip>:${port}. The phone listens on port ${port} until reboot; any other computer would still need its own on-phone approval.`);
});

tool("android_select_device", "Choose which device later calls use when several are connected.", { serial: z.string() }, ACT, async ({ serial }) => {
  await D.resolveSerial(serial); D.selectDevice(serial);
  return text(`Default device set to ${serial}`);
});

tool("android_status", "Phone model, Android version, screen on/off, locked, battery, screen size, and foreground app.", serialArg, READ, async ({ serial }) => {
  const s = await D.resolveSerial(serial);
  const st = await D.status(s);
  return text(`serial: ${s}\nscreen: ${st.screen}  locked: ${st.locked}\nforeground: ${st.foreground || "unknown"}\nfast helper: ${helperStatus(s)}\n${st.summary}`);
});

// ---------- seeing ----------
tool("android_screenshot", "Capture the phone screen. By default draws numbered boxes on tappable elements and returns the matching element list, so you can tap by number.", {
  ...serialArg,
  annotate: z.boolean().optional().describe("Draw numbered element boxes (default true). Set false for a clean image."),
}, READ, async ({ serial, annotate = true }) => shotResult(await D.resolveSerial(serial), annotate));

tool("android_ui", "Read the current screen as a numbered list of elements (text, buttons, inputs, scroll areas). Faster and more precise than a screenshot; use the numbers with android_tap/android_type.", {
  ...serialArg,
  query: z.string().optional().describe("Only show elements whose text/description/id contains this"),
  all: z.boolean().optional().describe("Include every node, not just meaningful ones"),
}, READ, async ({ serial, query, all }) => {
  const s = await D.resolveSerial(serial);
  const { nodes, elements } = await D.dumpUi(s, { mode: all ? "all" : "useful" });
  const pkg = nodes.find((n) => n.pkg)?.pkg;
  const app = pkg ? { component: pkg } : await D.currentApp(s).catch(() => ({}));
  let list = elements;
  if (query) { const q = query.toLowerCase(); list = elements.filter((e) => [e.label, e.text, e.desc, e.id].some((f) => (f || "").toLowerCase().includes(q))); }
  return text(`app: ${app.component || "unknown"}\n${list.length ? formatElements(list) : "(no matching elements)"}`);
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

const targetArgs = {
  element: z.number().int().optional().describe("Element number from the last android_ui / android_screenshot"),
  text: z.string().optional().describe("Tap the element whose text, description or id matches this (fresh lookup)"),
  x: z.number().optional(), y: z.number().optional(), coords: coordsArg,
};

tool("android_tap", "Tap (or long-press) an element by number, by visible text, or by x/y.", {
  ...serialArg, ...targetArgs,
  long_press: z.boolean().optional(), duration_ms: z.number().int().optional().describe("Long-press duration (default 700)"),
  ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  const t = await pickTarget(s, a);
  await D.tapPoint(s, t.pt.x, t.pt.y, { longPress: a.long_press, durationMs: a.duration_ms });
  return observeAfter(s, a.observe, `${a.long_press ? "Long-pressed" : "Tapped"} ${t.why}`);
});

tool("android_type", "Type text into the focused field, or tap a field first (element/text/x,y). Inserts at the cursor. Any Unicode incl. emoji when the on-phone helper is running; plain ASCII otherwise. Newlines press Enter.", {
  ...serialArg,
  value: z.string().describe("Text to type"),
  element: targetArgs.element, text: z.string().optional().describe("Field to tap first, matched by its text/hint/id"),
  x: targetArgs.x, y: targetArgs.y, coords: coordsArg,
  clear: z.boolean().optional().describe("Clear the field before typing"),
  submit: z.boolean().optional().describe("Press Enter after typing"),
  ...observeArg,
}, ACT, async (a) => {
  const s = await D.resolveSerial(a.serial);
  let el = null; let why = "focused field";
  if (a.element !== undefined || a.text || (a.x !== undefined && a.y !== undefined)) {
    const t = await pickTarget(s, a); el = t.el; why = t.why;
    await D.tapPoint(s, t.pt.x, t.pt.y); await sleep(350);
  }
  if (a.clear) await D.clearField(s, el);
  await D.typeText(s, a.value);
  if (a.submit) await D.pressKey(s, 66);
  return observeAfter(s, a.observe, `Typed ${a.value.length} chars into ${why}${a.submit ? " and pressed Enter" : ""}`);
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
  const out = await D.sh(s, a.command, { timeout: (a.timeout_s || 30) * 1000 });
  return text(out.length > 20000 ? out.slice(0, 20000) + `\n... (${out.length - 20000} more chars truncated)` : out || "(no output)");
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[android-control] v${VERSION} ready. data dir: ${dataDir()}`);
