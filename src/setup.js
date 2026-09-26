// Setup helpers: detect the user's phone brand on Windows (USB + Bluetooth), brand-specific
// walkthroughs, and network reachability probes. Everything here runs without admin.
import { execFile } from "node:child_process";
import net from "node:net";

const VENDORS = {
  "04E8": "samsung", "18D1": "google", "22B8": "motorola", "2A70": "oneplus", "2717": "xiaomi",
  "1004": "lg", "0FCE": "sony", "0BB4": "htc", "12D1": "huawei", "19D2": "zte", "05C6": "qualcomm",
  "0E8D": "mediatek", "22D9": "oppo", "2D95": "vivo", "1EBF": "nothing", "2AE5": "fairphone", "17EF": "lenovo",
};
const NAME_HINTS = [
  [/galaxy|samsung|\bSM-[A-Z]/i, "samsung"], [/pixel/i, "google"], [/moto|motorola/i, "motorola"],
  [/oneplus/i, "oneplus"], [/xiaomi|redmi|poco/i, "xiaomi"], [/oppo/i, "oppo"], [/vivo/i, "vivo"],
  [/nothing phone/i, "nothing"], [/sony|xperia/i, "sony"],
];

function ps(script, timeout = 20000) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

// Returns { usb: [{brand, name, status, adbInterface}], bluetooth: [{brand, name}] }. Windows only.
export async function detectWindowsPhones() {
  if (process.platform !== "win32") return { usb: [], bluetooth: [], note: "detection is Windows-only" };
  const out = await ps(
    "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'USB\\VID_*' -or $_.InstanceId -like 'BTHENUM\\DEV_*' } | " +
    "Select-Object Status, Class, FriendlyName, InstanceId | ConvertTo-Json -Compress");
  let rows = [];
  try { rows = JSON.parse(out || "[]"); if (!Array.isArray(rows)) rows = [rows]; } catch { rows = []; }
  const usb = new Map(); const bt = [];
  for (const r of rows) {
    const id = r.InstanceId || ""; const name = r.FriendlyName || "";
    if (id.startsWith("BTHENUM\\DEV_")) {
      const hint = NAME_HINTS.find(([re]) => re.test(name));
      if (hint) bt.push({ brand: hint[1], name });
      continue;
    }
    const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/i.exec(id);
    if (!m) continue;
    const brand = VENDORS[m[1].toUpperCase()];
    if (!brand) continue;
    const key = `${m[1]}:${id.split("\\")[2]?.split("&")[0] || m[2]}`;
    const e = usb.get(key) || { brand, name: "", status: "OK", adbInterface: false, problem: false, vidpid: `${m[1]}:${m[2]}` };
    if (/adb|android composite|android bootloader/i.test(name) || /AndroidUsbDeviceClass/i.test(r.Class || "")) e.adbInterface = true;
    if (r.Status && r.Status !== "OK") { e.problem = true; e.status = r.Status; }
    if (!e.name || /phone|galaxy|pixel|mtp|composite/i.test(name)) e.name = name || e.name;
    usb.set(key, e);
  }
  return { usb: [...usb.values()], bluetooth: [...new Map(bt.map((b) => [b.name, b])).values()] };
}

// TCP reachability: distinguishes "network blocks us" from "phone not listening".
export function tcpProbe(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: +port });
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(timeout, () => done("timeout"));
    s.on("connect", () => done("open"));
    s.on("error", (e) => done(e.code === "ECONNREFUSED" ? "refused" : e.code || "error"));
  });
}

export function explainProbe(host, port, result) {
  if (result === "open") return `${host}:${port} is reachable.`;
  if (result === "refused") return `${host}:${port} answered but refused: the network path is fine, but nothing is listening on that port. Either the port is wrong or it has closed (the pairing dialog was closed, or Wireless debugging was toggled). Ports change every time; re-read them from the phone.`;
  return `${host}:${port} did not answer (${result}). The PC can't reach the phone: usually guest/corporate Wi-Fi client isolation or phone and PC on different networks/VLANs. Options: USB, or put both on one network (e.g. the phone joins the PC's Windows Mobile Hotspot); see android_setup_guide method=hotspot.`;
}

const BRAND = {
  samsung: {
    label: "Samsung Galaxy (One UI)",
    devOptions: "Settings > About phone > Software information > tap \"Build number\" 7 times (enter your PIN). Developer options appears at the bottom of Settings, under About phone. BEFORE going further: Settings > Security and privacy > Auto Blocker > Off. It's on by default on newer Galaxy phones, and while it's on, Wireless debugging and USB debugging say \"Blocked by Auto Blocker\". Don't confuse this with Accessibility > TalkBack > Developer settings, which is a different menu that search often lands on.",
    usbDriver: "Samsung needs its own USB driver for adb on Windows. Plug the phone in first and wait a minute: Windows Update often installs it automatically, with no admin. Then check with android_doctor. If the phone still shows no ADB interface, the fix is the \"Samsung Android USB Driver for Windows\" from developer.samsung.com. Its installer needs admin rights, so ask IT or use Wi-Fi instead.",
    quirks: "Galaxy phones may show an \"Allow access to phone data?\" prompt when plugged in; that's MTP and separate from the \"Allow USB debugging?\" prompt, which is the one that matters. Turning Auto Blocker back on later disables debugging again.",
  },
  google: {
    label: "Google Pixel",
    devOptions: "Settings > About phone > tap \"Build number\" 7 times. Then Settings > System > Developer options.",
    usbDriver: "Pixels usually work with the driver Windows installs automatically (no admin). If android_doctor sees the phone but no ADB interface, the fix is the Google USB Driver from developer.android.com. Installing it needs admin rights.",
    quirks: "",
  },
  motorola: {
    label: "Motorola",
    devOptions: "Settings > About phone > tap \"Build number\" 7 times. Then Settings > System > Developer options.",
    usbDriver: "Windows usually auto-installs it. If not, use the Motorola Device Manager, which needs admin.",
    quirks: "",
  },
  oneplus: {
    label: "OnePlus / OPPO (OxygenOS / ColorOS)",
    devOptions: "Settings > About device > Version > tap \"Build number\" 7 times. Then Settings > System settings/Additional settings > Developer options.",
    usbDriver: "Usually auto-installed by Windows. If not, the OEM driver installer needs admin.",
    quirks: "If taps or typing fail with a permission error, turn on \"Disable permission monitoring\" in Developer options.",
  },
  xiaomi: {
    label: "Xiaomi / Redmi / POCO (HyperOS / MIUI)",
    devOptions: "Settings > About phone > tap \"OS version\" (or \"MIUI version\") 7 times. Developer options is under Settings > Additional settings.",
    usbDriver: "Usually auto-installed by Windows. If not, the OEM driver needs admin.",
    quirks: "REQUIRED: also turn on \"USB debugging (Security settings)\". Without it, tap and type are silently rejected (INJECT_EVENTS error). It needs a Mi account and sometimes a SIM card.",
  },
  generic: {
    label: "Android phone",
    devOptions: "Settings > About phone > find \"Build number\" (sometimes under Software information or Version) and tap it 7 times. Developer options then appears under Settings > System or at the bottom of Settings.",
    usbDriver: "Plug in and check android_doctor. Most phones get a driver from Windows automatically. If there's no ADB interface, the fix is the phone maker's USB driver, which usually needs admin rights. Wi-Fi avoids this.",
    quirks: "",
  },
};
for (const b of ["oppo", "realme"]) BRAND[b] = BRAND.oneplus;
for (const b of ["redmi", "poco"]) BRAND[b] = BRAND.xiaomi;
BRAND.pixel = BRAND.google;
BRAND.galaxy = BRAND.samsung;

export function setupGuide(brandIn = "", method = "wifi") {
  const key = (brandIn || "").toLowerCase().trim().split(/\s+/)[0];
  const b = BRAND[key] || BRAND.generic;
  const common = [`# ${b.label}: connect via ${method}`, "", `1. Enable Developer options: ${b.devOptions}`];
  if (method === "usb") {
    return [...common,
      "2. Developer options > turn on USB debugging.",
      "3. Plug into the PC with a data-capable cable (charge-only cables are common and look identical).",
      "4. Unlock the phone and accept \"Allow USB debugging?\" (tick Always allow).",
      `5. Driver: ${b.usbDriver}`,
      "6. Tell Claude to run android_doctor. It reports whether Windows sees the phone and whether the ADB interface loaded.",
      b.quirks && `Note: ${b.quirks}`].filter(Boolean).join("\n");
  }
  if (method === "hotspot") {
    return [...common,
      "Use this when the phone and PC are on different or isolated networks (guest Wi-Fi, separate VLANs) and USB isn't an option.",
      "2. PC: Settings > Network & internet > Mobile hotspot > turn it on (needs a Wi-Fi adapter; no admin unless IT disabled it by policy). Note the network name and password.",
      "3. Phone: join that Wi-Fi network. Phone and PC are now on the same private subnet (usually 192.168.137.x).",
      "4. Phone: Developer options > Wireless debugging > on. Then Pair device with pairing code and give Claude the IP:port and code.",
      "IT caution: a Mobile Hotspot shares the PC's wired connection over Wi-Fi, which effectively puts the phone on the company network. Many IT policies forbid that even when dev work is fine. Turn it on only while you're using it, or ask IT.",
      b.quirks && `Note: ${b.quirks}`].filter(Boolean).join("\n");
  }
  return [...common,
    "2. Put the phone on Wi-Fi that the PC can reach. Same network is best; guest Wi-Fi usually isolates devices.",
    "3. Developer options > Wireless debugging > on (Android 11+). Allow it on this network.",
    "4. Tap Wireless debugging > Pair device with pairing code. Give Claude the IP:port and the 6-digit code; Claude runs android_pair.",
    "5. If it doesn't auto-connect, give Claude the IP:port from the main Wireless debugging screen (it differs from the pairing port).",
    "If pairing times out, the network is probably isolating devices: try method=usb or method=hotspot.",
    b.quirks && `Note: ${b.quirks}`].filter(Boolean).join("\n");
}
