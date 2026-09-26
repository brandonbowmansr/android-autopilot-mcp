# Android Autopilot MCP

**Hand your Android phone to Claude.** A one-click MCP extension (`.mcpb`) that lets Claude or any MCP agent see and operate a real Android phone while you get on with other work.

Why this one:

- **Zero setup pain:** downloads its own adb on first run. No admin rights, no Android SDK, no PATH edits, no USB drivers over Wi-Fi.
- **Fast:** a tiny on-phone helper (pushed over adb, not an installed app) reads the screen in ~20 ms and taps by text in ~50 ms, versus 2-8 s for plain `uiautomator dump`.
- **Types anything:** Unicode and emoji text, inserted at the cursor.
- **Knows your phone:** detects the brand (USB or Bluetooth) and walks you through that brand's quirks (Samsung Auto Blocker, Xiaomi security toggle, work networks that need a hotspot).

(Shows up in Claude as "Android Phone Control".)

Lets Claude (Cowork, Claude Desktop, Claude Code) see and operate an Android phone over adb:
screenshots with numbered element overlays, the UI tree as a numbered list, tap, type, swipe,
scroll, keys, launching apps, deep links, and raw shell.

**One file to install. No admin rights. No PATH changes. No USB drivers if you use Wi-Fi.**

## Install (Claude Desktop / Cowork)

1. Download the latest `android-control-<version>.mcpb` from [Releases](https://github.com/brandonbowmansr/android-autopilot-mcp/releases/latest). Double-click it, or go to Settings > Extensions > Install Extension and pick the file.
2. Leave both settings blank (they're only overrides).
3. Start a **new** conversation and ask: "run android_doctor".
   - First run downloads Google's platform-tools (~7 MB) into `%LOCALAPPDATA%\android-control-mcp\`.
     It uses Node fetch first, then PowerShell with the Windows system proxy as a fallback.
   - If both are blocked, download `platform-tools-latest-windows.zip` in a browser, extract it,
     and put the folder path in the extension's "adb location" setting.

## Phone setup (one time)

Just ask Claude to run `android_doctor`. On Windows it detects the phone brand from USB or Bluetooth pairing, and returns that brand's steps: menu paths, the USB driver situation, and quirks such as Xiaomi's extra security toggle or Samsung's Auto Blocker. If it can't tell the brand, Claude asks you and calls `android_setup_guide brand=<x> method=wifi|usb|hotspot`.

Generic version:

1. Settings > About phone > tap **Build number** 7 times.
2. Developer options > turn on **Wireless debugging** (Android 11+).
3. Tap Wireless debugging > **Pair device with pairing code**. Tell Claude the IP:port and the 6-digit code.
4. Claude pairs, then auto-connects. If it doesn't, tell it the IP:port on the main Wireless debugging screen.

### Choosing a connection

| Situation | Method | Admin? |
|---|---|---|
| Phone and PC on the same reachable network | `wifi` (Wireless debugging) | no |
| Networks isolated (guest Wi-Fi, separate VLANs), PC has a Wi-Fi adapter | `hotspot`: phone joins the PC's Windows Mobile Hotspot, then Wireless debugging | no, unless IT disabled Mobile Hotspot. **Check IT policy**: it shares the wired LAN over Wi-Fi |
| No usable network | `usb` | Pixel/Moto/OnePlus usually no. Samsung usually needs Samsung's driver: Windows Update may auto-install it; the manual installer needs admin |

`android_pair` and `android_connect` probe the phone's port when they fail and say which case you're in: *unreachable* means the network is blocking you; *refused* means wrong or closed port.
`android_tcpip` switches an already connected phone to classic TCP port 5555, so it can then be reached over any IP route.

Not possible: **adb over Bluetooth** (adb has no Bluetooth transport). Bluetooth PAN tethering technically gives an IP link that `android_tcpip` could use, but at ~1-2 Mbit/s every screenshot takes many seconds, so it isn't supported.
**Phone on cellular while the PC is on the LAN** needs a relay: a VPN mesh like Tailscale (its Windows install needs admin) or an SSH tunnel through a server both sides can reach. Either one effectively opens a path into the company network, so it's an IT conversation, not a setting.

## How Claude uses it

- `android_ui` reads the screen as a numbered text list. It's the default way to look: fast and cheap. Input fields show their value and hint separately; `full_text=true` shows long text uncut.
- `android_screenshot` returns a small JPEG (about 400 tokens; `size=medium|large` for fine print) with
  numbered boxes on tappable elements, plus the matching list. Then `android_tap element=7`.
- Action tools return the new screen as text by default (`observe: "ui"`), so there's no extra round trip. `observe: "none"` skips it; `"screenshot"` returns a small image.
- `android_fill_form` fills a whole form in one call and checks every field; `android_type` checks its field too.
- Coordinates Claude reads off a screenshot can go straight to `android_tap`/`android_swipe`;
  the server converts them to device pixels.

## Tools

| Tool | What it does |
|---|---|
| android_doctor | find/install adb, detect phone brand (Windows), list devices, setup steps |
| android_setup_guide | brand-specific steps for wifi / usb / hotspot |
| android_pair / android_connect | Wi-Fi pairing and connection. `android_connect` with no arguments tries network discovery, then remembered phones and port 5555 on the local network. `stay_reachable=true` keeps the phone reachable without a new code until it reboots |
| android_tcpip | switch a connected phone to classic adb-over-TCP :5555 |
| android_devices / android_select_device | list devices (two connections to one phone count as one), pick default |
| android_status | model, Android version, screen on/locked, battery, foreground app |
| android_screenshot / android_ui | see the screen |
| android_tap / android_type / android_swipe / android_scroll / android_key | act. Taps that would land on the on-screen keyboard are caught; typing is read back and refused while the phone is locked |
| android_fill_form | fill several fields (by label, hint or id), verify each, retry slowly once, then tap submit |
| android_set_date | set an open date picker (wheel/spinner or calendar text mode) in one call |
| android_get_otp | read the latest verification code from notifications, optionally waiting for it |
| android_keep_awake | stop the screen sleeping mid-task; restores the phone's own settings afterwards |
| android_recipe | save and replay step lists for apps you use often, with {{vars}} for personal values |
| android_unlock | wake + swipe up (optional PIN) |
| android_launch_app / android_list_apps / android_open_url | apps and deep links |
| android_wait_for | wait for text to appear or disappear |
| android_shell | raw `adb shell` |

## Why it's fast

On first use the server copies a 7 KB helper (`helper/src/acm/Helper.java`) to the phone's `/data/local/tmp` and runs it with debugging permissions. It isn't an app install, and nothing shows in your app list. The helper keeps Android's accessibility connection open, so it doesn't pay the 2-8 s that `uiautomator dump` spends on every call starting up and waiting for the screen to go idle.

Measured on a Galaxy S26 Ultra (Android 16) over Wi-Fi:

| | plain adb | with helper |
|---|---|---|
| Read the screen (on the phone) | 2-8 s | ~15 ms |
| Read the screen (end to end, tool call) | 2-8 s | ~0.2 s |
| Screenshot | 2.5-3 s | ~0.2 s (0.4 s with numbered boxes) |
| Wait-for-text poll | ~2.5 s per check | ~0.1 s per check |

The helper also types any Unicode (emoji, accents) at the cursor through accessibility. After an action it watches the screen until it stops changing instead of sleeping a fixed time, so `observe` returns the screen you actually landed on.
It exits after 60 s without commands. Android allows only one automation connection at a time, so it doesn't block other tools (Appium, `uiautomator`) for long.
If it can't run on a phone, everything falls back to plain adb automatically. Set `ANDROID_CONTROL_NO_HELPER=1` to turn it off.

## Behaviors worth knowing

- **Tap-by-text won't guess.** If several different elements match equally well (three "Page" dots, two "OK" buttons), you get the numbered candidates back instead of a tap on the wrong one.
- **Typing checks itself.** After typing, the field is read back. With `clear=true` (and always in `android_fill_form`) a mismatch is retried once, one character at a time (`method=keys`), which is what laggy React Native / Flutter fields need. Password fields can only be checked by length.
- **Keyboard guard.** If a tap would land on the on-screen keyboard (a classic source of stray "5"s), the tool closes the keyboard and re-finds the element, or, for raw coordinates, stops and asks for a fresh read. `allow_keyboard=true` overrides.
- **Lock guard.** Typing, forms and date setting refuse to run while the phone is locked or asleep, instead of losing the text. `android_keep_awake` prevents it.
- **`stay_reachable` opens adb port 5555** on the phone until it reboots. Another computer still needs you to approve it on the phone, but only turn it on for networks you trust (e.g. your PC's own hotspot).
- **Recipes live on your computer** (`<data dir>/recipes/*.json`). Values you pass in `vars` are not saved.
- **Apps resume where they were left.** Use `android_launch_app restart=true` to open one fresh at its main screen. The tool waits until the app is actually in front before returning.

## Known limits (honest list)

- **Typing without the helper is ASCII only** (`adb input text` limitation). With the helper, any text works at the cursor. Password fields that already contain text are typed through the keyboard (ASCII) because their contents read back masked.
- **Secure screens capture black**: banking and payment apps, DRM video, and some password screens (FLAG_SECURE).
- **No UI tree** for games, video, and some Flutter/Unity apps. It falls back to screenshots and coordinate taps.
- **Wi-Fi debugging needs the phone and PC to reach each other.** Guest or corporate Wi-Fi with client isolation, or a PC on a different VLAN, will block it. Wireless debugging also turns itself off when the phone changes networks or reboots, so you re-pair or reconnect.
- **The lock screen with a PIN** can't be bypassed; unlock by hand or pass the PIN (it's sent over adb in plain text).
- **App launch by name** matches package names (e.g. "outlook" -> com.microsoft.office.outlook), not display labels.

## License

MIT (see `LICENSE`). Bundled third-party code is listed in `THIRD_PARTY_NOTICES.md`; all of it is MIT, BSD-3-Clause or ISC.
adb itself is **not** redistributed: it's downloaded from Google on first run and falls under the Android SDK License Agreement.
This project is not affiliated with Google or Anthropic.

## Build from source

```
npm install
npm test        # builds; runs unit tests, the smoke test, and end-to-end fix tests against a simulated phone (Linux/macOS/WSL)
npm run pack    # -> android-control-<version>.mcpb
```

The phone helper is prebuilt and embedded in `src/helper-jar.js`. To rebuild it you need a JDK and Google's r8.jar:
`R8_JAR=/path/to/r8.jar ./helper/build.sh` (compiles against the small API stubs in `helper/stubs/`, then dexes with D8).

Source: `src/` (adb.js = locate/self-install/exec, device.js = device ops, ui.js = UI tree, image.js = screenshot pipeline, index.js = MCP tools).
Runtime deps are pure JS (MCP SDK, zod, pngjs, jpeg-js, fflate) and bundled into one file. No native modules, so nothing to compile on install.
