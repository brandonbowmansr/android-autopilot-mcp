// Read one-time codes (OTP / verification codes) from the phone's notifications.
// Uses `dumpsys notification --noredact`, which the adb shell user is allowed to read.

export function parseNotifications(dump) {
  const out = [];
  const blocks = dump.split(/\n(?=\s*NotificationRecord\()/);
  for (const b of blocks) {
    const head = /NotificationRecord\([^:]*:\s*pkg=([\w.]+)/.exec(b);
    if (!head) continue;
    const field = (k) => {
      const m = new RegExp(`android\\.${k}=\\w+ \\((.*)\\)\\s*$`, "m").exec(b);
      return m ? m[1] : "";
    };
    const when = +(/\bwhen=(\d{12,})/.exec(b)?.[1] || /mCreationTimeMs=(\d{12,})/.exec(b)?.[1] || 0);
    out.push({ pkg: head[1], title: field("title"), text: field("bigText") || field("text"), sub: field("subText"), when });
  }
  return out.sort((a, b) => b.when - a.when);
}

const KEYWORDS = /(code|verif|otp|one[- ]time|passcode|pin\b|security|login|sign[- ]?in|confirm|authenticat)/i;

// Best-looking code in a message, or null. Prefers 6 digits next to words like "code".
export function extractCode(text) {
  if (!text) return null;
  const cands = [];
  const push = (code, idx, bonus = 0) => {
    const near = text.slice(Math.max(0, idx - 40), idx + code.length + 25);
    let s = bonus;
    if (KEYWORDS.test(near)) s += 10;
    if (code.replace(/\D/g, "").length === 6) s += 3;
    if (/(is|:)\s*$/i.test(text.slice(Math.max(0, idx - 6), idx))) s += 2;
    if (/^(19|20)\d\d$/.test(code)) s -= 6; // looks like a year
    const before = text.slice(Math.max(0, idx - 2), idx);
    if (/[+(\d]\s?$/.test(before) || /^[\s-]?\d/.test(text.slice(idx + code.length, idx + code.length + 2))) s -= 8; // part of a phone number
    cands.push({ code: code.replace(/[\s-]/g, ""), s });
  };
  for (const m of text.matchAll(/\b[A-Z]-(\d{4,8})\b/g)) push(m[1], m.index + 2, 2);
  for (const m of text.matchAll(/\b(\d{3})[- ](\d{3})\b/g)) push(m[0], m.index, 1);
  for (const m of text.matchAll(/(?<![\d-])(\d{4,8})(?![\d-])/g)) push(m[1], m.index);
  cands.sort((a, b) => b.s - a.s);
  return cands.length && cands[0].s > -3 ? cands[0].code : null;
}

// Filter + pick. opts: { app, from, contains, maxAgeMs, newerThan }
export function findCode(notifs, { app, from, contains, maxAgeMs = 10 * 60 * 1000, newerThan = 0, now = Date.now() } = {}) {
  const lc = (s) => (s || "").toLowerCase();
  for (const n of notifs) {
    if (app && !lc(n.pkg).includes(lc(app))) continue;
    if (from && !lc(n.title).includes(lc(from)) && !lc(n.sub).includes(lc(from))) continue;
    if (contains && !lc(`${n.title} ${n.text}`).includes(lc(contains))) continue;
    if (n.when && maxAgeMs && now - n.when > maxAgeMs) continue;
    if (newerThan && n.when && n.when < newerThan) continue;
    const code = extractCode(n.text) || extractCode(n.title);
    if (code) return { ...n, code };
  }
  return null;
}
