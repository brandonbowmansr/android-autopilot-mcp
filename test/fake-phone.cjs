// Stateful fake phone for tests (used by fake-adb.cjs when FAKE_STATE points at a JSON file).
// Simulates: a signup form (label-above field, laggy field that drops letters, field that ignores
// select-all, password field), the on-screen keyboard (taps in its area type a "5"), a lock screen,
// a spinner date picker, notifications with codes, keep-awake settings, and duplicate Wi-Fi entries.
const fs = require("fs");

const KB_TOP = 1400;
function defaults() {
  return {
    screen: "form", locked: false, awake: true, kb: false, focus: null, selectAll: false, submitted: false,
    fields: {
      first: { hint: "First name", text: "", b: [40, 200, 1040, 320] },
      email: { hint: "", text: "", b: [40, 460, 1040, 580], lag: true },
      password: { hint: "Password", text: "", b: [40, 640, 1040, 760], password: true },
      city: { hint: "City", text: "Old value", b: [40, 820, 1040, 940], sticky: true },
      bio: { hint: "Bio", text: "", b: [40, 1500, 1040, 1700] },
    },
    picker: { month: 3, day: 15, year: 2000 },
    notifications: [],
    settings: { "global stay_on_while_plugged_in": "0", "system screen_off_timeout": "60000" },
    files: {},
    devices: [["FAKE123", "Pixel_8"]],
    hw: {},
    tapLog: 0,
  };
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const node = (a, kids = "") => {
  const attrs = Object.entries({ index: 0, text: "", "resource-id": "", class: "android.widget.TextView", package: "com.fake.app", "content-desc": "", clickable: "false", enabled: "true", ...a })
    .map(([k, v]) => `${k}="${esc(v)}"`).join(" ");
  return kids ? `<node ${attrs}>${kids}</node>` : `<node ${attrs} />`;
};
const bstr = (b) => `[${b[0]},${b[1]}][${b[2]},${b[3]}]`;

function render(st) {
  let kids = "";
  if (st.screen === "form" && !st.submitted) {
    kids += node({ text: "Create account", bounds: "[40,80][1040,160]" });
    kids += node({ text: "Email address", bounds: "[40,380][600,440]" }); // label above the email field
    for (const [id, f] of Object.entries(st.fields)) {
      if (f.b[1] >= KB_TOP && st.kb) continue; // hidden behind keyboard (not in the active window)
      const shown = f.password ? "•".repeat(f.text.length) : f.text || f.hint;
      kids += node({ text: shown, hint: f.hint, "resource-id": `com.fake.app:id/${id}`, class: "android.widget.EditText", clickable: "true",
        focused: String(st.focus === id), password: String(!!f.password), editable: "true", bounds: bstr(f.b) });
    }
    kids += node({ text: "", "resource-id": "com.fake.app:id/go", class: "android.widget.Button", clickable: "true", bounds: "[40,1760][1040,1880]" },
      node({ text: "Continue", bounds: "[400,1790][700,1850]" }));
  } else if (st.screen === "form") {
    kids += node({ text: "Welcome aboard", bounds: "[40,300][1040,400]" });
  } else if (st.screen === "picker") {
    const col = (x1, x2, vals, id) => node({ class: "android.widget.NumberPicker", "resource-id": `android:id/${id}`, bounds: `[${x1},925][${x2},1375]`, scrollable: "true" },
      node({ text: vals[0], bounds: `[${x1},950][${x2},1050]` }) +
      node({ text: vals[1], class: "android.widget.EditText", "resource-id": "android:id/numberpicker_input", editable: "true", bounds: `[${x1},1100][${x2},1200]` }) +
      node({ text: vals[2], bounds: `[${x1},1250][${x2},1350]` }));
    const p = st.picker;
    const m = (v) => MON[(v + 11) % 12];
    const dd = (v) => String(((v + 30) % 31) + 1).padStart(2, "0");
    kids += node({ text: "Date of birth", bounds: "[40,800][1040,880]" });
    kids += col(100, 360, [m(p.month - 1), m(p.month), m(p.month + 1)], "month");
    kids += col(380, 640, [dd(p.day - 1), dd(p.day), dd(p.day + 1)], "day");
    kids += col(660, 980, [String(p.year - 1), String(p.year), String(p.year + 1)], "year");
    kids += node({ text: "Cancel", class: "android.widget.Button", clickable: "true", bounds: "[100,1500][500,1600]" });
    kids += node({ text: "OK", class: "android.widget.Button", clickable: "true", bounds: "[580,1500][980,1600]" });
  } else if (st.screen === "done") {
    kids += node({ text: `Date chosen ${st.picker.year}-${st.picker.month}-${st.picker.day}`, bounds: "[40,300][1040,400]" });
  }
  return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node({ class: "android.widget.FrameLayout", bounds: "[0,0][1080,2400]" }, kids)}</hierarchy>`;
}

// Undo shell single-quoting and adb's %s-for-space.
function unquote(t) {
  t = t.trim();
  if (t.startsWith("'")) t = t.slice(1, -1).replace(/'\\''/g, "'");
  return t.replace(/%s/g, " ");
}

function typeInto(st, chunk) {
  if (st.locked || !st.awake) return; // lost, like a real locked phone
  const f = st.fields[st.focus];
  if (!f) return;
  if (st.selectAll && !f.sticky) { f.text = ""; }
  st.selectAll = false;
  // A laggy field drops every 3rd character when text arrives in bursts.
  if (f.lag && chunk.length > 1) chunk = [...chunk].filter((_, i) => i % 3 !== 2).join("");
  f.text += chunk;
}

function tap(st, x, y) {
  st.tapLog++;
  if (st.screen === "form") {
    if (st.kb && y >= KB_TOP) { typeInto(st, "5"); return; } // hit a key on the keyboard
    for (const [id, f] of Object.entries(st.fields)) {
      if (x >= f.b[0] && x <= f.b[2] && y >= f.b[1] && y <= f.b[3]) { st.focus = id; st.kb = true; return; }
    }
    if (y >= 1760 && y <= 1880) st.submitted = true;
  } else if (st.screen === "picker") {
    const which = x < 370 ? "month" : x < 650 ? "day" : x < 990 ? "year" : null;
    if (y >= 1500 && y <= 1600 && x >= 580) { st.screen = "done"; return; }
    if (!which || y < 925 || y > 1375) return;
    const d = y < 1100 ? -1 : y > 1200 ? 1 : 0;
    const p = st.picker;
    if (which === "month") p.month = ((p.month - 1 + d + 12) % 12) + 1;
    else if (which === "day") p.day = ((p.day - 1 + d + 31) % 31) + 1;
    else if (p.year + d <= 2026) p.year += d; // year doesn't wrap
  }
}

function key(st, code) {
  const f = st.fields[st.focus];
  if (code === 4) { if (st.kb) st.kb = false; return; }
  if (code === 224) { st.awake = true; return; }
  if (code === 67 && f) { if (st.selectAll && !f.sticky) f.text = ""; else f.text = f.text.slice(0, -1); st.selectAll = false; return; }
  if (code === 62) { typeInto(st, " "); return; }
}

function shellOne(st, c, out) {
  c = c.trim();
  let m;
  if (!c) return;
  if ((m = /^input text (.+)$/.exec(c))) return typeInto(st, unquote(m[1]));
  if ((m = /^input tap (\d+) (\d+)$/.exec(c))) return tap(st, +m[1], +m[2]);
  if ((m = /^input keyevent (.+)$/.exec(c))) { for (const k of m[1].trim().split(/\s+/)) key(st, +k); return; }
  if (/^input keycombination 113 29/.test(c)) { st.selectAll = true; return; }
  if ((m = /^input swipe/.exec(c))) return;
  if (/^dumpsys power/.test(c)) { out.push(`  mWakefulness=${st.awake ? "Awake" : "Asleep"}`); return; }
  if (/^dumpsys window/.test(c)) { out.push(`    mShowingLockscreen=${st.locked} mDreamingLockscreen=false`); if (/mCurrentFocus/.test(c)) out.push("  mCurrentFocus=Window{abc u0 com.fake.app/.Main}"); return; }
  if (/^dumpsys input_method/.test(c)) { out.push(`  mInputShown=${st.kb}`); return; }
  if (/^settings get secure default_input_method/.test(c)) { out.push("com.fake.keyboard/.Ime"); return; }
  if (/^dumpsys notification/.test(c)) {
    for (const n of st.notifications) {
      out.push(`  NotificationRecord(0x0${n.id || 1}: pkg=${n.pkg} user=UserHandle{0} id=1 tag=null importance=4 key=0|${n.pkg}|1|null|10001: Notification(channel=x))`);
      out.push(`    uid=10001 userId=0`, `    when=${n.when}`, `    extras={`, `      android.title=String (${n.title})`, `      android.text=String (${n.text})`, `    }`);
    }
    return;
  }
  if ((m = /^settings put (global|system) (\S+) (\S+)$/.exec(c))) { st.settings[`${m[1]} ${m[2]}`] = m[3]; return; }
  if ((m = /^settings delete (global|system) (\S+)$/.exec(c))) { delete st.settings[`${m[1]} ${m[2]}`]; return; }
  if ((m = /^settings get (global|system) (\S+)$/.exec(c))) { out.push(st.settings[`${m[1]} ${m[2]}`] ?? "null"); return; }
  if ((m = /^echo (.*)$/.exec(c))) {
    let body = m[1];
    const redirect = /^(.*?)\s*>\s*(\S+)$/.exec(body);
    const expand = (t) => t.replace(/\$\(settings get (global|system) (\S+?)\)/g, (_, ns, k) => st.settings[`${ns} ${k}`] ?? "null");
    if (redirect) { st.files[redirect[2]] = unquote(expand(redirect[1])); return; }
    out.push(expand(body)); return;
  }
  if ((m = /^cat (\S+)/.exec(c))) { if (st.files[m[1]] !== undefined) out.push(st.files[m[1]]); return; }
  if ((m = /^rm -f (\S+)$/.exec(c))) { delete st.files[m[1]]; return; }
  if (/^getprop ro.serialno/.test(c)) { out.push(st.hw[st._serial] || st._serial); return; }
  if (/^wm size/.test(c)) { out.push("Physical size: 1080x2400"); return; }
  if (/^ip -f inet/.test(c)) { out.push("    inet 192.168.137.44/24 brd 192.168.137.255 scope global wlan0"); return; }
}

module.exports = function run(args, write) {
  const file = process.env.FAKE_STATE;
  const st = fs.existsSync(file) && fs.statSync(file).size ? { ...defaults(), ...JSON.parse(fs.readFileSync(file, "utf8")) } : defaults();
  let serial = "";
  if (args[0] === "-s") { serial = args[1]; args = args.slice(2); }
  st._serial = serial;
  const [cmd, ...rest] = args;
  const s = rest.join(" ");
  const out = [];
  let handled = true;
  if (cmd === "devices") out.push("List of devices attached", ...st.devices.map(([sr, model]) => `${sr}  device product:x model:${model} device:y transport_id:1`), "");
  else if (cmd === "exec-out" && s.includes("uiautomator")) { write(render(st)); }
  else if (cmd === "shell") {
    // Split on ; and && (good enough for the commands the server sends).
    for (const part of s.split(/;|&&/)) {
      const p = part.replace(/2>\/dev\/null/g, "").replace(/\|.*$/, "");
      shellOne(st, p, out);
    }
  } else if (cmd === "tcpip") out.push(`restarting in TCP mode port: ${rest[0]}`);
  else if (cmd === "connect") { out.push(`connected to ${rest[0]}`); if (!st.devices.some((d) => d[0] === rest[0])) st.devices.push([rest[0], "SM_S948U"]); }
  else if (cmd === "mdns" && st.mdns) out.push("List of discovered mdns services", ...st.mdns);
  else handled = false;
  delete st._serial;
  fs.writeFileSync(file, JSON.stringify(st));
  if (out.length) write(out.join("\n") + "\n");
  return handled;
};
module.exports.defaults = defaults;
