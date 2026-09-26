// Reliable text entry: lock guard, keyboard awareness, verified typing and clearing.
// These wrap the raw input primitives in device.js with a read-back so failures are caught
// in the same call instead of several round trips later.
import { AdbError } from "./adb.js";
import * as D from "./device.js";
import { center } from "./ui.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- lock guard ----------
const lockCache = new Map(); // serial -> { at, st }
export async function screenState(serial, { maxAgeMs = 0 } = {}) {
  const c = lockCache.get(serial);
  if (c && Date.now() - c.at < maxAgeMs) return c.st;
  const out = await D.sh(serial, "dumpsys power | grep -m1 mWakefulness=; dumpsys window | grep -m3 -E 'mDreamingLockscreen|mShowingLockscreen|isKeyguardShowing'", { timeout: 8000 }).catch(() => "");
  const wake = /mWakefulness=(\w+)/.exec(out)?.[1];
  const st = {
    on: wake ? wake === "Awake" : true,
    locked: /(mShowingLockscreen|mDreamingLockscreen|isKeyguardShowing)[=:]\s*true/.test(out),
  };
  lockCache.set(serial, { at: Date.now(), st });
  return st;
}
export function forgetScreenState(serial) { lockCache.delete(serial); }

// Throws instead of letting input vanish into a locked or dark screen.
export async function assertUnlocked(serial) {
  const st = await screenState(serial);
  if (!st.on || st.locked) {
    forgetScreenState(serial);
    throw new AdbError(`Phone is ${!st.on ? "asleep" : "locked"}, so typed text would be lost. Unlock it (android_unlock, or by hand), then retry. android_keep_awake stops it sleeping mid-task.`);
  }
}

// ---------- keyboard awareness ----------
export async function keyboardShown(serial) {
  const out = await D.sh(serial, "dumpsys input_method | grep -m2 -E 'mInputShown|mIsInputViewShown'", { timeout: 8000 }).catch(() => "");
  return /(mInputShown|mIsInputViewShown)=true/.test(out);
}

// Screen area the on-screen keyboard covers, in device pixels, or null when it's hidden.
// Uses the IME window's own nodes when readable; otherwise assumes the bottom 42% (typical phone keyboard).
export async function keyboardRect(serial) {
  if (!(await keyboardShown(serial))) return null;
  const { w, h } = await D.screenSize(serial);
  try {
    const ime = (await D.sh(serial, "settings get secure default_input_method", { timeout: 5000 })).trim().split("/")[0];
    if (ime) {
      const { nodes } = await D.dumpUi(serial, { mode: "all", windows: "all" });
      const b = nodes.filter((n) => n.pkg === ime && n.bounds).map((n) => n.bounds);
      if (b.length) {
        const y1 = Math.min(...b.map((x) => x.y1));
        if (y1 > h * 0.25 && y1 < h) return { x1: 0, y1, x2: w, y2: h, source: ime };
      }
    }
  } catch {}
  return { x1: 0, y1: Math.round(h * 0.58), x2: w, y2: h, source: "estimate" };
}

const inside = (p, r) => r && p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;

export async function hideKeyboard(serial) {
  if (!(await keyboardShown(serial))) return false;
  await D.pressKey(serial, 4); // Back closes the keyboard only, when it's showing.
  await sleep(350);
  D.devState(serial).kbMaybeUp = false;
  return true;
}

// Called before a tap. If the keyboard may be up and the point sits under it, hide the keyboard and,
// when we know which element was meant, find it again at its new position.
export async function guardTap(serial, target, { allowKeyboard = false, refind } = {}) {
  const ds = D.devState(serial);
  if (allowKeyboard || !ds.kbMaybeUp) return target;
  const { h } = await D.screenSize(serial);
  if (target.pt.y < h * 0.4) return target; // keyboards never reach the top 40%
  const kb = await keyboardRect(serial);
  if (!kb) { ds.kbMaybeUp = false; return target; }
  if (!inside(target.pt, kb)) return target;
  await hideKeyboard(serial);
  if (!refind) {
    throw new AdbError(`(${target.pt.x},${target.pt.y}) is on the on-screen keyboard, so the tap would have typed a key. I closed the keyboard; the layout has shifted, so read the screen again (android_ui) and retry. Pass allow_keyboard=true to really tap the keyboard.`);
  }
  const again = await refind();
  if (!again) throw new AdbError(`The element was under the keyboard. I closed the keyboard but can't find it again: read the screen (android_ui) and retry.`);
  return { ...again, why: `${again.why} (closed the keyboard first; it was covering the target)` };
}

// ---------- reading a field back ----------
const MASK = /^[•*●·•●]+$/;

// The editable element that is focused now, or the one at the same place as `el`.
export async function readField(serial, el) {
  const { elements } = await D.dumpUi(serial, { retries: 1 });
  const eds = elements.filter((e) => e.editable);
  let hit = eds.find((e) => e.focused);
  if (el?.bounds && (!hit || !overlap(hit.bounds, el.bounds))) {
    const c = center(el.bounds);
    hit = eds.find((e) => e.bounds && c.x >= e.bounds.x1 && c.x <= e.bounds.x2 && c.y >= e.bounds.y1 && c.y <= e.bounds.y2) || hit;
  }
  return hit || null;
}
const overlap = (a, b) => a && b && a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

// Compare what the field shows with what we meant to put there.
export function checkValue(field, expected) {
  if (!field) return { ok: null, note: "no input field found to read back" };
  const got = field.value ?? "";
  if (field.password || (got && MASK.test(got))) {
    if (!got) return { ok: expected === "", got: "", note: "password field (empty)" };
    if (MASK.test(got)) return { ok: got.length === expected.length, got: `${got.length} hidden chars`, note: "password field: only the length can be checked" };
  }
  const norm = (s) => s.replace(/\r/g, "");
  return { ok: norm(got) === norm(expected), got };
}

// ---------- clearing ----------
export async function clearVerified(serial, el) {
  const steps = [];
  await D.clearField(serial, el); steps.push("select-all/clear");
  let f = await readField(serial, el);
  if (!f || !f.value) return { ok: true, steps };
  // React Native and some custom fields ignore a programmatic clear; fall back to real keys.
  await D.sh(serial, "input keycombination 113 29 2>/dev/null; input keyevent 67").catch(() => {}); steps.push("ctrl+a, delete");
  f = await readField(serial, el);
  if (!f || !f.value) return { ok: true, steps };
  const n = Math.min(300, f.value.length + 5);
  await D.sh(serial, `input keyevent 123 ${Array(n).fill(67).join(" ")}`); steps.push(`end + ${n} backspaces`);
  f = await readField(serial, el);
  return { ok: !f || !f.value, steps, left: f?.value };
}

// ---------- typing ----------
// method: "auto" = fast path (helper insert, or adb text), "keys" = one character at a time through
// the keyboard with a pause (for laggy React Native / Flutter fields that drop characters).
export async function typeKeys(serial, text, delayMs = 60) {
  if (!/^[\x20-\x7e\n]*$/.test(text)) throw new AdbError("method=keys only handles plain ASCII. Use method=auto for other characters.");
  for (const ch of text) {
    if (ch === "\n") await D.sh(serial, "input keyevent 66");
    else if (ch === " ") await D.sh(serial, "input keyevent 62");
    else await D.sh(serial, `input text ${D.quote(ch)}`);
    if (delayMs) await sleep(delayMs);
  }
}

// Type into a field and check the result. On a mismatch: clear, retry slowly, check again.
// Returns { ok, got, attempts, note }. `replace`=true means the field should end up holding exactly `value`.
export async function typeVerified(serial, value, { el = null, replace = false, method = "auto", delayMs = 60, verify = true } = {}) {
  const before = verify && !replace ? await readField(serial, el).catch(() => null) : null;
  const attempts = [];
  const doType = async (m) => {
    if (m === "keys") await typeKeys(serial, value, delayMs);
    else await D.typeText(serial, value);
    attempts.push(m);
  };
  await doType(method);
  D.devState(serial).kbMaybeUp = true;
  if (!verify || value.includes("\n")) return { ok: null, attempts, note: verify ? "not verified (text has line breaks / Enter)" : "not verified" };
  await sleep(250);
  let f = await readField(serial, el);
  // When appending into a field that already had text (and no clear), only the new part is ours.
  const expected = replace || !before?.value || before.password ? value : null;
  const judge = (fld) => expected !== null ? checkValue(fld, expected)
    : { ok: (fld?.value || "").includes(value), got: fld?.value, note: "checked that the field contains the typed text" };
  let r = judge(f);
  if (r.ok !== false || !replace) return { ...r, attempts };
  // Retry: clear, then type one character at a time.
  const c = await clearVerified(serial, f || el);
  if (!c.ok) return { ok: false, got: c.left, attempts, note: `couldn't clear the field for a retry (tried ${c.steps.join(", ")})` };
  if (/^[\x20-\x7e]*$/.test(value)) await doType("keys"); else await doType("auto");
  await sleep(300);
  f = await readField(serial, el);
  r = checkValue(f, value);
  return { ...r, attempts, note: r.ok ? "fixed on retry" : r.note };
}
