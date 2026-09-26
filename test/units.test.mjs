// Unit checks for the pure parts of v0.4: code extraction, notification parsing, picker detection.
import assert from "node:assert/strict";
import { extractCode, parseNotifications, findCode } from "../src/otp.js";
import { findColumns, classify, currentOf } from "../src/picker.js";
import { parseUiXml } from "../src/ui.js";
import { fillVars, validateRecipe } from "../src/recipes.js";
let n = 0; const ok = (f) => { f(); n++; };
ok(() => assert.equal(extractCode("Your verification code is 482913"), "482913"));
ok(() => assert.equal(extractCode("G-775533 is your Google verification code."), "775533"));
ok(() => assert.equal(extractCode("Use code 123-456 to sign in"), "123456"));
ok(() => assert.equal(extractCode("Call us at 847-555-1234 anytime"), null));
ok(() => assert.equal(extractCode("Your code: 5521. Valid until 2026."), "5521"));
ok(() => assert.equal(extractCode("Meeting moved to Room 12"), null));
// Shape of real `dumpsys notification --noredact` output (Android 13-16).
const dump = `Current Notification Manager state:
  Notification List:
    NotificationRecord(0x0f3a1b2c: pkg=com.samsung.android.messaging user=UserHandle{0} id=1234 tag=null importance=4 key=0|com.samsung.android.messaging|1234|null|10123: Notification(channel=CHANNEL_ID_SMS_MMS shortcut=null contentView=null vibrate=null sound=null defaults=0x0 flags=0x10 color=0x00000000 vis=PRIVATE))
      uid=10123 userId=0
      opPkg=com.samsung.android.messaging
      when=1790000000000
      extras={
        android.title=String (22395)
        android.text=SpannableString (Traba: your login code is 918273)
        android.showWhen=Boolean (true)
      }
    NotificationRecord(0x0aa: pkg=com.android.systemui user=UserHandle{0} id=7 tag=null importance=2 key=0|com.android.systemui|7|null|10001: Notification(channel=BAT))
      when=1790000001000
      extras={
        android.title=String (Battery)
        android.text=String (Charging 80%)
      }`;
const list = parseNotifications(dump);
ok(() => assert.equal(list.length, 2));
ok(() => assert.equal(list[0].pkg, "com.android.systemui"));
ok(() => assert.equal(findCode(list, { contains: "traba", now: 1790000060000 }).code, "918273"));
ok(() => assert.equal(findCode(list, { app: "systemui", now: 1790000060000 }), null));
// Picker detection on a Samsung-style spinner (numeric month).
const node = (t, b, extra = "") => `<node text="${t}" class="android.widget.TextView" bounds="${b}" ${extra}/>`;
const col = (x1, x2, a, b, c) => `<node class="android.widget.NumberPicker" scrollable="true" bounds="[${x1},900][${x2},1400]">${node(a, `[${x1},950][${x2},1050]`)}${node(b, `[${x1},1100][${x2},1200]`, 'class="android.widget.EditText" editable="true"')}${node(c, `[${x1},1250][${x2},1350]`)}</node>`;
const xml = `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">${col(700, 1000, "1999", "2000", "2001")}${col(100, 350, "2", "3", "4")}${col(380, 650, "14", "15", "16")}</node></hierarchy>`;
const cols = findColumns(parseUiXml(xml));
ok(() => assert.equal(cols.length, 3));
ok(() => assert.deepEqual(classify(cols), ["month", "day", "year"]));
ok(() => assert.equal(currentOf(cols[2]).t, "2000"));
ok(() => assert.deepEqual(fillVars({ a: "{{x}}-{{y}}", b: ["{{x}}"] }, { x: 1, y: 2 }), { a: "1-2", b: ["1"] }));
ok(() => assert.throws(() => validateRecipe({ steps: [{ do: "shell" }] })));
console.log(`unit tests: ${n}/${n} pass`);
