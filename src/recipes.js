// Per-app recipes: saved step lists (launch, tap, fill, wait, OTP...) that can be replayed and checked.
// Stored as JSON under <data dir>/recipes. Personal values go in {{vars}} and are passed at run time,
// so nothing sensitive is written to disk.
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./adb.js";

export const STEP_TOOLS = ["launch_app", "open_url", "tap", "type", "fill_form", "key", "scroll", "swipe", "wait_for", "set_date", "get_otp", "ui"];

const dir = () => path.join(dataDir(), "recipes");
const safe = (n) => { if (!/^[\w.-]{1,64}$/.test(n || "")) throw new Error("Recipe names use letters, digits, dot, dash, underscore (max 64)."); return n; };
const file = (n) => path.join(dir(), `${safe(n)}.json`);

export function listRecipes() {
  try {
    return fs.readdirSync(dir()).filter((f) => f.endsWith(".json")).map((f) => {
      try { const r = JSON.parse(fs.readFileSync(path.join(dir(), f), "utf8")); return { name: f.slice(0, -5), description: r.description || "", steps: r.steps?.length || 0, vars: r.vars || [] }; }
      catch { return { name: f.slice(0, -5), description: "(unreadable)", steps: 0, vars: [] }; }
    });
  } catch { return []; }
}

export function loadRecipe(name) {
  try { return JSON.parse(fs.readFileSync(file(name), "utf8")); }
  catch { throw new Error(`No recipe "${name}". android_recipe action=list shows saved ones.`); }
}

export function validateRecipe(r) {
  if (!r || !Array.isArray(r.steps) || !r.steps.length) throw new Error("A recipe needs a non-empty steps array.");
  r.steps.forEach((s, i) => {
    if (!STEP_TOOLS.includes(s.do)) throw new Error(`Step ${i + 1}: "do" must be one of ${STEP_TOOLS.join(", ")}.`);
    if (s.args !== undefined && (typeof s.args !== "object" || Array.isArray(s.args))) throw new Error(`Step ${i + 1}: args must be an object.`);
  });
  const used = new Set(JSON.stringify(r.steps).match(/\{\{(\w+)\}\}/g)?.map((m) => m.slice(2, -2)) || []);
  return [...used];
}

export function saveRecipe(name, recipe) {
  const vars = validateRecipe(recipe);
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(file(name), JSON.stringify({ ...recipe, vars }, null, 2));
  return vars;
}

export function deleteRecipe(name) { fs.rmSync(file(name), { force: true }); }

// Replace {{var}} in every string inside args.
export function fillVars(value, vars) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!(k in vars)) throw new Error(`Missing value for {{${k}}}. Pass it in vars.`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillVars(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillVars(v, vars)]));
  return value;
}
