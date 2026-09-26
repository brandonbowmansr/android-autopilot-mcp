// Unit checks for tap-by-text matching.
import assert from "node:assert/strict";
import { parseUiXml, interestingElements, findElement } from "../src/ui.js";
const n = (text, b, extra = "") => `<node text="${text}" class="android.widget.Button" clickable="true" enabled="true" bounds="${b}" ${extra}/>`;
const xml = (...kids) => `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2340]">${kids.join("")}</node></hierarchy>`;
const els = (x) => interestingElements(parseUiXml(x));
// Two different "OK" buttons -> ambiguous, no guess.
let r = findElement(els(xml(n("OK", "[0,100][200,200]"), n("OK", "[0,2000][200,2100]"))), "ok");
assert.equal(r.ambiguous?.length, 2);
// One exact + one partial -> exact wins, not ambiguous.
r = findElement(els(xml(n("Search", "[0,100][200,200]"), n("Search settings", "[0,300][200,400]"))), "search");
assert.equal(r.ambiguous, null); assert.equal(r.best.label, "Search");
// Label nested inside its own button -> same target, not ambiguous.
r = findElement(els(xml(`<node class="android.widget.LinearLayout" clickable="true" enabled="true" bounds="[0,100][500,300]"><node text="Send" class="android.widget.TextView" bounds="[10,110][200,200]"/></node>`, n("Cancel", "[0,500][200,600]"))), "send");
assert.equal(r.ambiguous, null);
// Invisible nodes are ignored.
r = findElement(els(xml(n("Pay", "[0,100][200,200]", 'visible-to-user="false"'), n("Pay", "[0,300][200,400]"))), "pay");
assert.equal(r.ambiguous, null); assert.equal(r.best.bounds.y1, 300);
console.log("match tests: 4/4 pass");
