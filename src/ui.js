// Parse `uiautomator dump` XML into a flat, numbered element list Claude can act on.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescape = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e] ?? m;
});

export function parseUiXml(xml) {
  const nodes = [];
  const re = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  const stack = [];
  let m;
  while ((m = re.exec(xml))) {
    if (m[0] === "</node>") { stack.pop(); continue; }
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = unescape(a[2]);
    const b = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.bounds || "");
    const node = {
      text: attrs.text || "",
      desc: attrs["content-desc"] || "",
      id: attrs["resource-id"] || "",
      cls: (attrs.class || "").replace(/^android\.(widget|view)\./, ""),
      pkg: attrs.package || "",
      clickable: attrs.clickable === "true" || attrs["long-clickable"] === "true",
      checkable: attrs.checkable === "true",
      checked: attrs.checked === "true",
      enabled: attrs.enabled !== "false",
      focused: attrs.focused === "true",
      scrollable: attrs.scrollable === "true",
      editable: attrs.editable === "true" || /EditText|AutoCompleteTextView/.test(attrs.class || "") || attrs.password === "true",
      password: attrs.password === "true",
      selected: attrs.selected === "true",
      visible: attrs["visible-to-user"] !== "false",
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
      depth: stack.length,
      parent: stack.length ? stack[stack.length - 1] : -1,
    };
    nodes.push(node);
    if (m[2] !== "/") stack.push(nodes.length - 1);
  }
  return nodes;
}

const area = (b) => (b ? Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1) : 0);

// Label for an unlabeled clickable container: first text found among its descendants.
function inheritLabel(nodes, idx) {
  for (let j = idx + 1; j < nodes.length && nodes[j].depth > nodes[idx].depth; j++) {
    const n = nodes[j];
    if (n.text || n.desc) return n.text || n.desc;
  }
  return "";
}

// Keep what a person would consider an element: actionable things plus visible text.
export function interestingElements(nodes, { mode = "useful" } = {}) {
  const out = [];
  nodes.forEach((n, i) => {
    if (!n.bounds || area(n.bounds) === 0 || !n.visible) return;
    const actionable = n.clickable || n.editable || n.scrollable || n.checkable;
    const hasLabel = n.text || n.desc;
    if (mode === "all" || actionable || hasLabel) {
      out.push({ ...n, label: n.text || n.desc || (n.clickable || n.editable || n.checkable ? inheritLabel(nodes, i) : ""), raw: i });
    }
  });
  // Drop text-only children fully covered by an actionable parent carrying the same label (noise).
  if (mode !== "all") {
    const keep = out.filter((e) => {
      if (e.clickable || e.editable || e.scrollable || e.checkable) return true;
      let p = e.parent;
      while (p >= 0) {
        const pn = nodes[p];
        if ((pn.clickable || pn.editable) && (inheritLabel(nodes, p) === e.label || pn.desc === e.label)) return false;
        p = pn.parent;
      }
      return true;
    });
    return keep.map((e, k) => ({ ...e, index: k + 1 }));
  }
  return out.map((e, k) => ({ ...e, index: k + 1 }));
}

export const center = (b) => ({ x: Math.round((b.x1 + b.x2) / 2), y: Math.round((b.y1 + b.y2) / 2) });

export function formatElements(els, { limit = 250 } = {}) {
  const lines = els.slice(0, limit).map((e) => {
    const flags = [
      e.clickable && "tap", e.editable && "input", e.scrollable && "scroll", e.checkable && (e.checked ? "checked" : "unchecked"),
      e.focused && "focused", e.selected && "selected", !e.enabled && "disabled", e.password && "password",
    ].filter(Boolean).join(",");
    const id = e.id ? ` id=${e.id.replace(/^[\w.]+:id\//, "")}` : "";
    const lbl = e.label ? ` "${e.label.replace(/\s+/g, " ").slice(0, 80)}"` : "";
    const desc = e.desc && e.desc !== e.label ? ` desc="${e.desc.slice(0, 60)}"` : "";
    return `[${e.index}] ${e.cls}${lbl}${desc}${id}${flags ? " {" + flags + "}" : ""}`;
  });
  if (els.length > limit) lines.push(`... ${els.length - limit} more (use query to narrow)`);
  return lines.join("\n");
}

// True when one box sits inside the other (a label inside its own button counts as the same target).
function overlaps(a, b) {
  const inside = (p, q) => p.x1 >= q.x1 && p.y1 >= q.y1 && p.x2 <= q.x2 && p.y2 <= q.y2;
  return inside(a, b) || inside(b, a);
}

const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();

// Find best match for a text query across label/text/desc/resource-id.
export function findElement(els, query, { exact = false } = {}) {
  const q = norm(query);
  if (!q) return null;
  const scored = [];
  for (const e of els) {
    const fields = [e.label, e.text, e.desc, e.id.replace(/^[\w.]+:id\//, "")].map(norm);
    let s = 0;
    if (fields.some((f) => f === q)) s = 100;
    else if (!exact && fields.some((f) => f.startsWith(q))) s = 70;
    else if (!exact && fields.some((f) => f.includes(q))) s = 50;
    if (!s) continue;
    if (e.clickable || e.editable) s += 10;
    if (!e.enabled) s -= 20;
    scored.push({ e, s });
  }
  scored.sort((a, b) => b.s - a.s || area(a.e.bounds) - area(b.e.bounds));
  if (!scored.length) return null;
  const top = scored[0].s;
  // Several equally good matches that are different targets: don't guess.
  const ties = scored.filter((x) => x.s === top);
  const distinct = ties.filter((x, i) => !ties.slice(0, i).some((y) => overlaps(x.e.bounds, y.e.bounds)));
  return { best: scored[0].e, count: scored.length, ambiguous: distinct.length > 1 ? distinct.map((x) => x.e) : null, others: scored.slice(1, 4).map((x) => x.e) };
}
