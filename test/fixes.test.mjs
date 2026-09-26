// End-to-end checks for the v0.4 fixes, run against the stateful fake phone (test/fake-phone.cjs).
// Each case drives the real bundled server over MCP and then inspects the fake phone's state.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { defaults } = require("./fake-phone.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "acm-test-"));
const STATE = path.join(tmp, "phone.json");
const HOME = path.join(tmp, "home");
const setState = (patch) => { const st = { ...defaults(), ...patch }; fs.writeFileSync(STATE, JSON.stringify(st)); };
const getState = () => JSON.parse(fs.readFileSync(STATE, "utf8"));
const patchState = (f) => { const st = getState(); f(st); fs.writeFileSync(STATE, JSON.stringify(st)); };
setState({});

const t = new StdioClientTransport({
  command: "node", args: [new URL("../bundle/server/index.mjs", import.meta.url).pathname],
  env: { ...process.env, ADB_PATH: new URL("./adb", import.meta.url).pathname, FAKE_STATE: STATE, ANDROID_CONTROL_NO_HELPER: "1", ANDROID_CONTROL_HOME: HOME, ANDROID_CONTROL_NEIGHBORS: "" },
  stderr: "ignore",
});
const c = new Client({ name: "fixes-test", version: "0" });
await c.connect(t);
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { err: !!r.isError, txt: r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n"), img: r.content.find((x) => x.type === "image") };
};
const results = [];
async function check(label, fn) {
  try { await fn(); results.push(["PASS", label]); }
  catch (e) { results.push(["FAIL", label, e.message.split("\n").slice(0, 6).join(" | ")]); }
}
const jpegSize = (b64) => { // read width/height from the JPEG SOF marker
  const b = Buffer.from(b64, "base64");
  for (let i = 2; i < b.length;) { const len = b.readUInt16BE(i + 2); if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xc2) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + len; }
};

// 1. Small screenshots by default
await check("1 screenshot defaults small (<=800 px), large on request", async () => {
  let r = await call("android_screenshot");
  let d = jpegSize(r.img.data);
  assert.ok(Math.max(d.w, d.h) <= 800, `small was ${d.w}x${d.h}`);
  assert.match(r.txt, /small, ~\d+ tokens/);
  r = await call("android_screenshot", { size: "large", annotate: false });
  d = jpegSize(r.img.data);
  assert.ok(Math.max(d.w, d.h) > 1400, `large was ${d.w}x${d.h}`);
});

// 2. observe defaults to the text screen, never an image
await check("2 actions return the text screen by default, no image", async () => {
  const r = await call("android_key", { key: "home" });
  assert.match(r.txt, /Screen now:/); assert.equal(r.img, undefined);
  const n = await call("android_key", { key: "home", observe: "none" });
  assert.doesNotMatch(n.txt, /Screen now:/);
});

// 3/4/5/6. fill_form: label-above field, laggy field (drops letters), sticky field (ignores select-all),
// password, and a field hidden behind the keyboard.
await check("3-6 fill_form fills, verifies, retries, clears, uncovers", async () => {
  setState({});
  const r = await call("android_fill_form", { fields: [
    { field: "First name", value: "Brandon" },
    { field: "Email address", value: "brandon.test@example.com" },
    { field: "Password", value: "Tmp-pass1!", secret: true },
    { field: "City", value: "Woodstock" },
    { field: "Bio", value: "Likes tools" },
  ], submit: "Continue", observe: "none" });
  const st = getState();
  assert.equal(r.err, false, r.txt);
  assert.equal(st.fields.first.text, "Brandon");
  assert.equal(st.fields.email.text, "brandon.test@example.com");
  assert.equal(st.fields.password.text, "Tmp-pass1!");
  assert.equal(st.fields.city.text, "Woodstock");
  assert.equal(st.fields.bio.text, "Likes tools");
  assert.equal(st.submitted, true);
  assert.match(r.txt, /Email address.*fixed on retry/);
  assert.doesNotMatch(r.txt, /Tmp-pass1/);
});

await check("4 android_type reports a mismatch instead of silently passing", async () => {
  setState({});
  const r = await call("android_type", { text: "Email address", value: "abcdefghi", observe: "none" }); // no clear: report, don't retry
  assert.equal(r.err, true, r.txt); assert.match(r.txt, /MISMATCH/);
  const r2 = await call("android_type", { text: "Email address", value: "abcdefghi", clear: true, observe: "none" });
  assert.equal(r2.err, false, r2.txt); assert.match(r2.txt, /verified \(fixed on retry\)/);
  assert.equal(getState().fields.email.text, "abcdefghi");
});

await check("5 clear falls back to backspaces when select-all is ignored", async () => {
  setState({});
  const r = await call("android_type", { text: "City", value: "Chicago", clear: true, observe: "none" });
  assert.equal(r.err, false, r.txt);
  assert.equal(getState().fields.city.text, "Chicago");
});

await check("6 a tap on the keyboard area is blocked and the keyboard closed", async () => {
  setState({});
  await call("android_tap", { text: "First name", observe: "none" });
  assert.equal(getState().kb, true);
  const r = await call("android_tap", { x: 540, y: 2000, coords: "device", observe: "none" });
  assert.equal(r.err, true); assert.match(r.txt, /on-screen keyboard/);
  const st = getState();
  assert.equal(st.kb, false); assert.equal(st.fields.first.text, "", "a stray key was typed");
});

// 7. Lock guard + keep-awake with restore
await check("7 typing refuses while locked; keep-awake saves and restores settings", async () => {
  setState({ locked: true });
  const r = await call("android_type", { text: "First name", value: "x" });
  assert.equal(r.err, true); assert.match(r.txt, /locked/);
  assert.equal(getState().fields.first.text, "");
  setState({});
  await call("android_keep_awake", { on: true, minutes: 20 });
  let st = getState();
  assert.equal(st.settings["global stay_on_while_plugged_in"], "7");
  assert.equal(st.settings["system screen_off_timeout"], "1200000");
  assert.ok(Object.values(st.files).includes("0 60000"));
  await call("android_keep_awake", { on: true }); // second call must not overwrite the saved originals
  assert.ok(Object.values(getState().files).includes("0 60000"));
  assert.match((await call("android_status")).txt, /keep-awake: ON/);
  const off = await call("android_keep_awake", { on: false });
  st = getState();
  assert.match(off.txt, /Restored/);
  assert.equal(st.settings["global stay_on_while_plugged_in"], "0");
  assert.equal(st.settings["system screen_off_timeout"], "60000");
  assert.equal(Object.keys(st.files).length, 0);
});

// 8. Date picker in one call
await check("8 set_date spins month/day/year and taps OK", async () => {
  setState({ screen: "picker" });
  const r = await call("android_set_date", { date: "1983-10-27", observe: "none" });
  const st = getState();
  assert.equal(r.err, false, r.txt);
  assert.deepEqual(st.picker, { month: 10, day: 27, year: 1983 });
  assert.equal(st.screen, "done");
});

// 9. OTP from notifications
await check("9 get_otp finds the right code and skips phone numbers / stale codes", async () => {
  const now = Date.now();
  setState({ notifications: [
    { pkg: "com.google.android.apps.messaging", title: "+1 555 201 3344", text: "Your Shiftsmart verification code is 482913. Don't share it. Call 847-555-1234 for help.", when: now - 30000 },
    { pkg: "com.google.android.apps.messaging", title: "Bank", text: "Your code is 111222", when: now - 60 * 60 * 1000 },
    { pkg: "com.google.android.gm", title: "Wonolo", text: "Use G-775533 to sign in", when: now - 5000 },
  ] });
  let r = await call("android_get_otp", { contains: "shiftsmart" });
  assert.match(r.txt, /Code: 482913/);
  r = await call("android_get_otp", { app: "gm" });
  assert.match(r.txt, /Code: 775533/);
  r = await call("android_get_otp", { from: "Bank" });
  assert.equal(r.err, true, "an hour-old code should be ignored by default");
});

// 10. Full text
await check("10 long text isn't cut off (inputs show 300 chars; full_text shows all)", async () => {
  const long = "x".repeat(250) + "END-OF-BIO-" + "y".repeat(100);
  setState({}); patchState((st) => { st.fields.first.text = long; });
  let r = await call("android_ui", { query: "first" });
  assert.match(r.txt, /\(\+\d+ chars\)/);
  r = await call("android_ui", { query: "first", full_text: true });
  assert.ok(r.txt.includes(long));
});

// 11. Duplicate Wi-Fi entries for one phone
await check("11 two connections to one phone are treated as one", async () => {
  setState({ devices: [["192.168.137.44:5555", "SM_S948U"], ["adb-R5CX123-AbCd._adb-tls-connect._tcp", "SM_S948U"]],
    hw: { "192.168.137.44:5555": "R5CX123", "adb-R5CX123-AbCd._adb-tls-connect._tcp": "R5CX123" } });
  await new Promise((res) => setTimeout(res, 3200)); // the server caches the device list for 3 s
  const r = await call("android_status");
  assert.equal(r.err, false, r.txt);
  assert.match((await call("android_devices")).txt, /one phone, 2 connections/);
  setState({ devices: [["A1", "P1"], ["B2", "P2"]], hw: { A1: "A1", B2: "B2" } });
  await new Promise((res) => setTimeout(res, 3200));
  const r2 = await call("android_status");
  assert.equal(r2.err, true); assert.match(r2.txt, /Several phones/);
  setState({});
  await new Promise((res) => setTimeout(res, 3200));
});

// 12. Reconnect without a code: stay_reachable + remembered phones
await check("12 stay_reachable remembers the phone; connect() finds it again", async () => {
  setState({ mdns: [] });
  const r = await call("android_connect", { host_port: "192.168.137.44:41235", stay_reachable: true });
  assert.match(r.txt, /Stays reachable at 192\.168\.137\.44:5555/);
  const known = JSON.parse(fs.readFileSync(path.join(HOME, "known-devices.json"), "utf8"));
  assert.equal(Object.values(known)[0].classicPort, 5555);
  // Point the remembered address at a local listener to prove the no-argument path uses it.
  const srv = net.createServer((s) => s.destroy()); await new Promise((res) => srv.listen(0, "127.0.0.1", res));
  const port = srv.address().port;
  const k = Object.keys(known)[0]; known[k] = { ...known[k], ip: "127.0.0.1", classicPort: port, lastHostPort: `127.0.0.1:${port}` };
  fs.writeFileSync(path.join(HOME, "known-devices.json"), JSON.stringify(known));
  const r2 = await call("android_connect", {});
  srv.close();
  assert.match(r2.txt, new RegExp(`Connected via remembered/nearby phones on port 5555: 127\\.0\\.0\\.1:${port}`));
});

// 13. Recipes
await check("13 recipes save with {{vars}}, replay, pass an OTP between steps, and stop on a failed expectation", async () => {
  setState({ notifications: [{ pkg: "com.google.android.apps.messaging", title: "Fake App", text: "Fake App code: 246810", when: Date.now() - 1000 }] });
  const recipe = { description: "demo signup", steps: [
    { do: "fill_form", args: { fields: [{ field: "First name", value: "{{first}}" }] } },
    { do: "get_otp", args: { contains: "fake app" }, save_as: "otp" },
    { do: "type", args: { text: "City", value: "{{otp}}", clear: true } },
    { do: "tap", args: { text: "Continue" }, expect: "Welcome aboard" },
  ] };
  const s = await call("android_recipe", { action: "save", name: "demo", recipe });
  assert.match(s.txt, /vars: first, otp/);
  assert.match((await call("android_recipe", { action: "list" })).txt, /demo \(4 steps/);
  const r = await call("android_recipe", { action: "run", name: "demo", vars: { first: "Ann" } });
  assert.equal(r.err, false, r.txt);
  const st = getState();
  assert.equal(st.fields.first.text, "Ann"); assert.equal(st.fields.city.text, "246810"); assert.equal(st.submitted, true);
  setState({});
  const bad = await call("android_recipe", { action: "save", name: "bad", recipe: { steps: [{ do: "tap", args: { text: "First name" }, expect: "Nope", timeout_s: 1 }] } });
  assert.equal(bad.err, false);
  const r2 = await call("android_recipe", { action: "run", name: "bad" });
  assert.equal(r2.err, true); assert.match(r2.txt, /stopped after step 1/); assert.match(r2.txt, /Screen now:/);
  const r3 = await call("android_recipe", { action: "run", name: "demo", vars: {} });
  assert.equal(r3.err, true); assert.match(r3.txt, /Missing value for \{\{first\}\}/);
});

await c.close();
fs.rmSync(tmp, { recursive: true, force: true });
for (const [s, l, why] of results) console.log(`${s}  ${l}${why ? `\n      ${why}` : ""}`);
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\nfixes tests: ${results.length - failed}/${results.length} pass`);
process.exit(failed ? 1 : 0);
