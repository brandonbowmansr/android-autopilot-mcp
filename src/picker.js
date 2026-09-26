// Set a date picker straight to a value in one call, instead of tapping a wheel 40 times by hand.
// Handles spinner/wheel pickers (NumberPicker and look-alikes: one column each for month, day, year)
// and Material calendar pickers that offer a text-input mode.
import { AdbError } from "./adb.js";
import * as D from "./device.js";
import { center, findElement } from "./ui.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthIndex = (t) => { const i = MONTHS.indexOf(String(t).trim().toLowerCase().slice(0, 3)); return i < 0 ? null : i + 1; };

const inBox = (b, o) => b && o && b.x1 >= o.x1 - 2 && b.x2 <= o.x2 + 2 && b.y1 >= o.y1 - 2 && b.y2 <= o.y2 + 2;

// Find picker columns: NumberPicker-like nodes, or scrollable columns full of date-ish values.
export function findColumns(nodes) {
  const cols = [];
  nodes.forEach((n, i) => {
    if (!n.bounds) return;
    const isPickerCls = /NumberPicker|Picker$|Wheel|Spinner(?!.*Adapter)/i.test(n.cls) && !/DatePicker|TimePicker/i.test(n.cls);
    if (!isPickerCls && !n.scrollable) return;
    const items = [];
    for (let j = i + 1; j < nodes.length && nodes[j].depth > n.depth; j++) {
      const c = nodes[j];
      const t = (c.text || c.desc || "").trim();
      if (!t || !c.bounds || !c.visible) continue;
      if (!/^(\d{1,4}|[A-Za-z]{3,9}\.?)$/.test(t)) continue;
      items.push({ t, b: c.bounds, editable: c.editable });
    }
    if (!items.length) return;
    if (!isPickerCls && !items.every((x) => /^\d{1,4}$/.test(x.t) || monthIndex(x.t))) return;
    if (cols.some((c) => inBox(n.bounds, c.bounds))) return; // nested inside a column we already have
    cols.push({ bounds: n.bounds, items });
  });
  // Keep only columns side by side on one row (the picker), left to right.
  cols.sort((a, b) => a.bounds.x1 - b.bounds.x1);
  return cols;
}

// The value a column currently shows: its editable child (NumberPicker) or the item nearest its middle.
export function currentOf(col) {
  const ed = col.items.find((x) => x.editable);
  if (ed) return ed;
  const cy = (col.bounds.y1 + col.bounds.y2) / 2;
  return [...col.items].sort((a, b) => Math.abs(center(a.b).y - cy) - Math.abs(center(b.b).y - cy))[0];
}

// Decide which column is year / month / day.
export function classify(cols) {
  const kinds = cols.map((c) => {
    const vals = c.items.map((x) => x.t);
    if (vals.some((v) => monthIndex(v))) return "month";
    if (vals.every((v) => /^\d{4}$/.test(v))) return "year";
    if (vals.some((v) => /^\d{1,2}$/.test(v) && +v > 12)) return "day";
    return "num";
  });
  // Ambiguous numeric columns: fill what's missing, month before day (US order) unless the day is already known.
  const has = (k) => kinds.includes(k);
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== "num") continue;
    if (!has("month")) kinds[i] = "month";
    else if (!has("day")) kinds[i] = "day";
  }
  return kinds;
}

const valueOf = (kind, t) => (kind === "month" ? monthIndex(t) ?? +t : +t);

function itemStep(col) {
  const ys = [...new Set(col.items.map((x) => center(x.b).y))].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < ys.length; i++) step = Math.min(step, ys[i] - ys[i - 1]);
  return Number.isFinite(step) && step > 10 ? step : Math.round((col.bounds.y2 - col.bounds.y1) / 3);
}

async function readColumns(serial) {
  const { nodes } = await D.dumpUi(serial, { mode: "all", retries: 1 });
  return findColumns(nodes);
}

async function trySetTextMode(serial, target, format) {
  const { elements } = await D.dumpUi(serial);
  const sw = elements.find((e) => e.clickable && /switch to (text )?input|text input mode|keyboard|edit/i.test(`${e.desc} ${e.label} ${e.id}`));
  if (!sw) return null;
  await D.tapPoint(serial, center(sw.bounds).x, center(sw.bounds).y);
  await sleep(500);
  const { elements: els2 } = await D.dumpUi(serial);
  const field = els2.find((e) => e.editable && (e.focused || /date|mm|dd|yy/i.test(`${e.hint} ${e.label}`))) || els2.find((e) => e.editable);
  if (!field) return null;
  const hint = (field.hint || field.label || "").toLowerCase();
  const [y, m, d] = target;
  const p2 = (n) => String(n).padStart(2, "0");
  let txt = format ? format.replace(/yyyy/i, y).replace(/mm/i, p2(m)).replace(/dd/i, p2(d))
    : /dd.mm/.test(hint) ? `${p2(d)}/${p2(m)}/${y}` : /yyyy.mm/.test(hint) ? `${y}/${p2(m)}/${p2(d)}` : `${p2(m)}/${p2(d)}/${y}`;
  await D.tapPoint(serial, center(field.bounds).x, center(field.bounds).y);
  await D.clearField(serial, field);
  await D.typeText(serial, txt);
  return { mode: "text input", typed: txt, hint: field.hint || "" };
}

export async function setDate(serial, isoDate, { confirm = true, format } = {}) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(isoDate.trim());
  if (!m) throw new AdbError(`date must be YYYY-MM-DD, got "${isoDate}"`);
  const target = { year: +m[1], month: +m[2], day: +m[3] };
  let cols = await readColumns(serial);
  const log = [];
  if (cols.length < 2) {
    const t = await trySetTextMode(serial, [target.year, target.month, target.day], format);
    if (!t) throw new AdbError("No date picker found on screen. Open the picker first (tap the date field), or if the field accepts typing, use android_type / android_fill_form with the date text.");
    log.push(`typed ${t.typed} in text-input mode${t.hint ? ` (hint "${t.hint}")` : ""}`);
    return finish(serial, confirm, log, null);
  }
  const kinds = classify(cols);
  for (let ci = 0; ci < cols.length; ci++) {
    const kind = kinds[ci];
    if (!target[kind]) continue;
    let taps = 0, wraps = kind === "month" || kind === "day", last = null;
    for (let guard = 0; guard < 25; guard++) {
      const col = cols[ci];
      const cur = currentOf(col);
      const now = valueOf(kind, cur.t);
      const want = target[kind];
      if (now === want) break;
      if (last === now) wraps = false; // didn't move: this wheel doesn't wrap, go the direct way
      last = now;
      let delta = want - now;
      // Month/day wheels usually wrap around: go the short way.
      const span = !wraps ? 0 : kind === "month" ? 12 : 31;
      if (span && Math.abs(delta) > span / 2) delta = delta > 0 ? delta - span : delta + span;
      const step = itemStep(col);
      const c = center(cur.b);
      const y = delta > 0 ? c.y + step : c.y - step;
      const n = Math.min(Math.abs(delta), 10);
      for (let k = 0; k < n; k++) { await D.tapPoint(serial, c.x, Math.round(y)); await sleep(90); }
      taps += n;
      await sleep(250);
      cols = await readColumns(serial);
      if (!cols[ci]) throw new AdbError("The picker changed shape while scrolling; read the screen and retry.");
    }
    log.push(`${kind}: ${currentOf(cols[ci]).t} (${taps} steps)`);
  }
  // Verify every column.
  const bad = [];
  cols.forEach((col, ci) => { const k = kinds[ci]; if (target[k] && valueOf(k, currentOf(col).t) !== target[k]) bad.push(`${k} shows ${currentOf(col).t}`); });
  if (bad.length) return { ok: false, text: `Picker not fully set: ${bad.join(", ")}. Steps: ${log.join("; ")}` };
  return finish(serial, confirm, log, cols);
}

async function finish(serial, confirm, log, cols) {
  if (confirm) {
    const { elements } = await D.dumpUi(serial);
    const ok = ["OK", "Set", "Done", "Confirm", "Save"].map((t) => findElement(elements, t, { exact: true })).find((h) => h && !h.ambiguous);
    if (ok) { await D.tapPoint(serial, center(ok.best.bounds).x, center(ok.best.bounds).y); log.push(`tapped "${ok.best.label}"`); }
    else log.push("no OK/Set/Done button found; left the picker open");
  }
  return { ok: true, text: `Date set. ${log.join("; ")}` };
}
