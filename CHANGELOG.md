# Changelog

## 0.4.0 (2026-09-26)

Cheaper and more reliable, based on a long real-world session.

- **Smaller screenshots by default.** `size=small|medium|large`; small is ~400 tokens instead of ~1,500.
- **Actions return the text screen by default** (`observe` defaults to `ui`), so no extra round trip and no habit screenshots.
- **`android_fill_form`**: fill a whole form in one call; each field is found by label/hint/id (including a label sitting above the field), cleared, typed, read back and retried slowly once. Optional submit button.
- **Verified typing**: `android_type` reads the field back and reports a mismatch; with `clear=true` it retries one character at a time. `method=keys` for laggy React Native / Flutter fields.
- **Reliable clear**: programmatic clear, then select-all + delete, then backspaces, checking after each.
- **Keyboard guard**: taps that would hit the on-screen keyboard close the keyboard and re-find the target instead of typing a stray key.
- **Lock guard + `android_keep_awake`**: typing refuses while locked; keep-awake saves the phone's settings on the phone and restores them.
- **`android_set_date`**: sets wheel/spinner date pickers (or calendar pickers in text mode) in one call and verifies.
- **`android_get_otp`**: latest verification code from notifications, filtered by app/sender/text, with optional waiting.
- **Full text**: input fields show 300 chars and `android_ui full_text=true` shows everything; `uiautomator` fallbacks no longer collide with the helper.
- **One phone, two connections** (IP:port + discovery name) is treated as one device.
- **Reconnect without a code**: remembered phones, port-5555 discovery on the local network (e.g. the PC's hotspot), `stay_reachable=true`, and `android_doctor` reports Windows Firewall rules that block adb.
- **`android_recipe`**: save and replay per-app step lists with `{{vars}}`, checks between steps, and OTP passing.
- Tests: a stateful simulated phone (`test/fake-phone.cjs`) with end-to-end checks for each fix.

## 0.3.1 (2026-09-24)

First public release.
