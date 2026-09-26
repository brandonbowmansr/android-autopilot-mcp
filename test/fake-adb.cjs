#!/usr/bin/env node
// Minimal adb stand-in for tests. Logs every call to $FAKE_ADB_LOG.
const fs = require("fs"); const path = require("path");
const { PNG } = require(path.join(__dirname, "..", "node_modules", "pngjs"));
let args = process.argv.slice(2);
if (process.env.FAKE_ADB_LOG) fs.appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(args) + "\n");
if (args[0] === "-s") args = args.slice(2);
const [cmd, ...rest] = args; const s = rest.join(" ");
const out = (t) => process.stdout.write(t);
const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,0][1080,2400]">
<node index="0" text="Search &amp; find" resource-id="com.example:id/search" class="android.widget.EditText" package="com.example" content-desc="" clickable="true" enabled="true" focused="false" bounds="[40,120][1040,240]" />
<node index="1" text="" resource-id="com.example:id/send" class="android.widget.Button" package="com.example" content-desc="" clickable="true" enabled="true" bounds="[800,300][1040,420]">
  <node index="0" text="Send" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[820,320][1020,400]" />
</node>
<node index="2" text="" resource-id="com.example:id/list" class="androidx.recyclerview.widget.RecyclerView" package="com.example" content-desc="" clickable="false" scrollable="true" enabled="true" bounds="[0,500][1080,2200]">
  <node index="0" text="Inbox" resource-id="" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[40,520][500,600]" />
</node>
<node index="3" text="" resource-id="" class="android.widget.ImageButton" package="com.example" content-desc="Settings" clickable="true" enabled="true" bounds="[900,2250][1040,2380]" />
</node></hierarchy>`;
if (cmd === "version") out("Android Debug Bridge version 1.0.41\nVersion 36.0.0-fake\n");
else if (cmd === "devices") out("List of devices attached\nFAKE123  device product:x model:Pixel_8 device:shiba transport_id:1\n\n");
else if (cmd === "pair" && rest[1] === "000000") { out("Failed: Wrong password or connection was dropped.\n"); process.exit(1); }
else if (cmd === "tcpip") out("restarting in TCP mode port: " + rest[0] + "\n");
else if (cmd === "pair") out("Successfully paired to " + rest[0] + " [guid=adb-X]\n");
else if (cmd === "mdns") out("List of discovered mdns services\nadb-FAKE-abc\t_adb-tls-connect._tcp\t192.168.1.50:41235\n");
else if (cmd === "connect") out("connected to " + rest[0] + "\n");
else if (cmd === "exec-out" && s.startsWith("screencap")) {
  const png = new PNG({ width: 1080, height: 2400 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 30; png.data[i+1] = 120; png.data[i+2] = 200; png.data[i+3] = 255; }
  process.stdout.write(PNG.sync.write(png));
}
else if (cmd === "exec-out" && s.includes("uiautomator")) out(XML);
else if (cmd === "shell") {
  if (s.startsWith("wm size")) out("Physical size: 1080x2400\n");
  else if (s.startsWith("pm list packages")) out("package:com.android.settings\npackage:com.microsoft.office.outlook\npackage:com.microsoft.teams\npackage:com.android.chrome\n");
  else if (s.includes("dumpsys window") && s.includes("mCurrentFocus")) out("  mCurrentFocus=Window{abc u0 com.example/com.example.Main}\n");
  else if (s.startsWith("echo MODEL")) out("MODEL=Google Pixel 8\nANDROID=15 SDK=35\n  mWakefulness=Awake\n    mShowingLockscreen=false\n  level: 80\nPhysical size: 1080x2400\nPhysical density: 420\n");
  else if (s.startsWith("ip -f inet")) out("inet 192.168.137.44\n");
  else if (s.startsWith("monkey")) out("Events injected: 1\n");
  else if (s.startsWith("am start")) out("Starting: Intent { act=android.intent.action.VIEW }\n");
  else out("");
}
else { process.stderr.write("fake adb: unknown " + args.join(" ") + "\n"); process.exit(1); }
