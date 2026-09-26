package acm;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;

/**
 * On-phone helper for android-control-mcp. Runs via app_process with shell permissions
 * (no app install). Keeps one UiAutomation connection open so reading the screen, injecting
 * input and taking screenshots don't pay JVM start-up + idle-wait costs on every call.
 *
 * Protocol: one command per stdin line, one response per stdout line: "OK ..." or "ERR ...".
 */
public final class Helper {
    static final int SOURCE_TOUCHSCREEN = 0x00001002;
    static final int SOURCE_KEYBOARD = 0x00000101;
    static final int FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES = 1;
    static final int FLAG_INCLUDE_NOT_IMPORTANT_VIEWS = 2;
    static final int FLAG_REPORT_VIEW_IDS = 16;
    static final int FLAG_RETRIEVE_INTERACTIVE_WINDOWS = 64;
    static final int ACTION_SET_TEXT = 0x00200000;
    static final String ARG_SET_TEXT = "ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE";
    static final int ACTION_SET_SELECTION = 0x00020000;
    static final String ARG_SEL_START = "ACTION_ARGUMENT_SELECTION_START_INT";
    static final String ARG_SEL_END = "ACTION_ARGUMENT_SELECTION_END_INT";
    static final int FOCUS_INPUT = 1;

    static final String VERSION = "2";
    static UiAutomation ua;
    static PrintStream out;
    static volatile long lastCmd = SystemClock.uptimeMillis();

    public static void main(String[] args) throws Exception {
        out = new PrintStream(new java.io.FileOutputStream(java.io.FileDescriptor.out), true, "UTF-8");
        long t0 = SystemClock.uptimeMillis();
        try {
            connect();
        } catch (Throwable t) {
            out.println("ERR connect " + oneLine(t));
            return;
        }
        out.println("OK ready " + (SystemClock.uptimeMillis() - t0) + "ms v" + VERSION);
        // Only one UiAutomation connection can exist system-wide, so give it up when idle.
        final long idleExitMs = args.length > 0 ? Long.parseLong(args[0]) : 60000;
        Thread watchdog = new Thread() {
            public void run() {
                while (true) {
                    try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                    if (SystemClock.uptimeMillis() - lastCmd > idleExitMs) {
                        try { ua.disconnect(); } catch (Throwable ignored) {}
                        out.println("BYE idle");
                        System.exit(0);
                    }
                }
            }
        };
        watchdog.setDaemon(true);
        watchdog.start();
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            lastCmd = SystemClock.uptimeMillis();
            line = line.trim();
            if (line.isEmpty()) continue;
            if (line.equals("quit")) break;
            String resp;
            try {
                resp = handle(line);
            } catch (Throwable t) {
                resp = "ERR " + oneLine(t);
            }
            out.println(resp);
            lastCmd = SystemClock.uptimeMillis();
        }
        try { ua.disconnect(); } catch (Throwable ignored) {}
        System.exit(0);
    }

    static void connect() throws Exception {
        HandlerThread ht = new HandlerThread("acm-uiautomation");
        ht.start();
        Looper looper = ht.getLooper();
        Object conn = Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor().newInstance();
        UiAutomation u = null;
        StringBuilder seen = new StringBuilder();
        for (Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
            Class<?>[] p = c.getParameterTypes();
            seen.append(c.toString()).append("; ");
            if (p.length == 2 && p[0].getName().equals("android.os.Looper")) {
                c.setAccessible(true);
                u = (UiAutomation) c.newInstance(looper, conn);
                break;
            }
        }
        if (u == null) {
            for (Constructor<?> c : UiAutomation.class.getDeclaredConstructors()) {
                Class<?>[] p = c.getParameterTypes();
                if (p.length == 2 && p[0].getName().equals("android.content.Context")) {
                    c.setAccessible(true);
                    u = (UiAutomation) c.newInstance(systemContext(), conn);
                    break;
                }
            }
        }
        if (u == null) throw new IllegalStateException("no usable UiAutomation constructor: " + seen);
        Method m;
        try {
            m = UiAutomation.class.getDeclaredMethod("connect", int.class);
            m.setAccessible(true);
            m.invoke(u, FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);
        } catch (NoSuchMethodException e) {
            m = UiAutomation.class.getDeclaredMethod("connect");
            m.setAccessible(true);
            m.invoke(u);
        }
        AccessibilityServiceInfo info = u.getServiceInfo();
        info.flags |= FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | FLAG_REPORT_VIEW_IDS | FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        u.setServiceInfo(info);
        ua = u;
    }

    static Object systemContext() throws Exception {
        Class<?> at = Class.forName("android.app.ActivityThread");
        Object thread = at.getDeclaredMethod("systemMain").invoke(null);
        return at.getDeclaredMethod("getSystemContext").invoke(thread);
    }

    static String handle(String line) throws Exception {
        String[] a = line.split(" ");
        switch (a[0]) {
            case "ping":
                return "OK pong";
            case "dump": {
                long t = SystemClock.uptimeMillis();
                StringBuilder sb = new StringBuilder(32768);
                sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">");
                boolean all = a.length > 1 && a[1].equals("all");
                if (all) {
                    List<AccessibilityWindowInfo> ws = ua.getWindows();
                    for (AccessibilityWindowInfo w : ws) {
                        AccessibilityNodeInfo r = w.getRoot();
                        if (r != null) dumpNode(r, sb, 0);
                    }
                } else {
                    AccessibilityNodeInfo root = null;
                    for (int i = 0; i < 5 && root == null; i++) {
                        root = ua.getRootInActiveWindow();
                        if (root == null) Thread.sleep(50);
                    }
                    if (root == null) return "ERR no active window";
                    dumpNode(root, sb, 0);
                }
                sb.append("</hierarchy>");
                return "OK " + (SystemClock.uptimeMillis() - t) + " " + sb;
            }
            case "tap":
                tap(f(a[1]), f(a[2]), 0);
                return "OK";
            case "longpress":
                tap(f(a[1]), f(a[2]), a.length > 3 ? Long.parseLong(a[3]) : 700);
                return "OK";
            case "swipe":
                swipe(f(a[1]), f(a[2]), f(a[3]), f(a[4]), a.length > 5 ? Long.parseLong(a[5]) : 300);
                return "OK";
            case "key": {
                int code = Integer.parseInt(a[1]);
                long now = SystemClock.uptimeMillis();
                KeyEvent down = new KeyEvent(now, now, 0, code, 0);
                KeyEvent up = new KeyEvent(now, now, 1, code, 0);
                down.setSource(SOURCE_KEYBOARD); up.setSource(SOURCE_KEYBOARD);
                ua.injectInputEvent(down, true);
                ua.injectInputEvent(up, true);
                return "OK";
            }
            case "settext": {
                // settext <set|insert|append> <base64 utf-8>
                //   set    = replace the whole field
                //   insert = put text at the cursor / over the selection (normal typing)
                //   append = add at the end
                String mode = a[1];
                String txt = a.length > 2 ? new String(Base64.getDecoder().decode(a[2]), StandardCharsets.UTF_8) : "";
                AccessibilityNodeInfo root = ua.getRootInActiveWindow();
                AccessibilityNodeInfo f = root == null ? null : root.findFocus(FOCUS_INPUT);
                if (f == null) return "ERR no focused input field";
                String cur = currentText(f);
                if (f.isPassword() && !cur.isEmpty() && !mode.equals("set")) {
                    // Password text reads back masked; rewriting it would corrupt the value. Let the caller type via the IME.
                    return "ERR password field already has text";
                }
                int caret;
                String nt;
                if (mode.equals("set")) {
                    nt = txt; caret = txt.length();
                } else if (mode.equals("append")) {
                    nt = cur + txt; caret = nt.length();
                } else {
                    int s = f.getTextSelectionStart(), e = f.getTextSelectionEnd();
                    if (s < 0 || s > cur.length()) s = cur.length();
                    if (e < s || e > cur.length()) e = s;
                    nt = cur.substring(0, s) + txt + cur.substring(e);
                    caret = s + txt.length();
                }
                Bundle b = new Bundle();
                b.putCharSequence(ARG_SET_TEXT, nt);
                if (!f.performAction(ACTION_SET_TEXT, b)) return "ERR field rejected text";
                f.refresh();
                Bundle sel = new Bundle();
                sel.putInt(ARG_SEL_START, caret);
                sel.putInt(ARG_SEL_END, caret);
                f.performAction(ACTION_SET_SELECTION, sel);
                return "OK " + caret;
            }
            case "shot": {
                // shot <maxEdge> <maxPixels> <quality>
                long t = SystemClock.uptimeMillis();
                int maxEdge = Integer.parseInt(a[1]);
                long maxPx = Long.parseLong(a[2]);
                int q = Integer.parseInt(a[3]);
                Bitmap bmp = ua.takeScreenshot();
                if (bmp == null) return "ERR screenshot unavailable (secure screen?)";
                int w = bmp.getWidth(), h = bmp.getHeight();
                double s = Math.min(1.0, Math.min((double) maxEdge / Math.max(w, h), Math.sqrt((double) maxPx / ((double) w * h))));
                Bitmap scaled = s < 1.0 ? Bitmap.createScaledBitmap(bmp, (int) Math.round(w * s), (int) Math.round(h * s), true) : bmp;
                ByteArrayOutputStream bo = new ByteArrayOutputStream(200000);
                scaled.compress(Bitmap.CompressFormat.JPEG, q, bo);
                int sw = scaled.getWidth(), sh = scaled.getHeight();
                if (scaled != bmp) scaled.recycle();
                bmp.recycle();
                return "OK " + (SystemClock.uptimeMillis() - t) + " " + w + " " + h + " " + sw + " " + sh + " " + Base64.getEncoder().encodeToString(bo.toByteArray());
            }
            case "idle": {
                long idle = a.length > 1 ? Long.parseLong(a[1]) : 300;
                long max = a.length > 2 ? Long.parseLong(a[2]) : 3000;
                long t = SystemClock.uptimeMillis();
                try { ua.waitForIdle(idle, max); return "OK idle " + (SystemClock.uptimeMillis() - t); }
                catch (java.util.concurrent.TimeoutException e) { return "OK busy " + (SystemClock.uptimeMillis() - t); }
            }
            default:
                return "ERR unknown command " + a[0];
        }
    }

    static float f(String s) { return Float.parseFloat(s); }

    // Field text without the placeholder hint that some fields report as their text when empty.
    static String currentText(AccessibilityNodeInfo n) {
        CharSequence cur = n.getText();
        if (cur == null) return "";
        if (n.isShowingHintText()) return "";
        CharSequence hint = n.getHintText();
        if (hint != null && cur.toString().equals(hint.toString())) return "";
        return cur.toString();
    }

    static void tap(float x, float y, long holdMs) throws Exception {
        long down = SystemClock.uptimeMillis();
        inject(MotionEvent.obtain(down, down, 0, x, y, 0));
        if (holdMs > 0) Thread.sleep(holdMs);
        inject(MotionEvent.obtain(down, SystemClock.uptimeMillis(), 1, x, y, 0));
    }

    static void swipe(float x1, float y1, float x2, float y2, long ms) throws Exception {
        long down = SystemClock.uptimeMillis();
        inject(MotionEvent.obtain(down, down, 0, x1, y1, 0));
        int steps = (int) Math.max(5, ms / 16);
        for (int i = 1; i <= steps; i++) {
            float t = (float) i / steps;
            Thread.sleep(Math.max(1, ms / steps));
            inject(MotionEvent.obtain(down, SystemClock.uptimeMillis(), 2, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 0));
        }
        inject(MotionEvent.obtain(down, SystemClock.uptimeMillis(), 1, x2, y2, 0));
    }

    static void inject(MotionEvent e) {
        e.setSource(SOURCE_TOUCHSCREEN);
        ua.injectInputEvent(e, true);
        e.recycle();
    }

    static final Rect R = new Rect();

    static void dumpNode(AccessibilityNodeInfo n, StringBuilder sb, int index) {
        n.getBoundsInScreen(R);
        sb.append("<node index=\"").append(index).append('"');
        attr(sb, "text", n.getText());
        attr(sb, "resource-id", n.getViewIdResourceName());
        attr(sb, "class", n.getClassName());
        attr(sb, "package", n.getPackageName());
        attr(sb, "content-desc", n.getContentDescription());
        attr(sb, "hint", n.getHintText());
        bool(sb, "checkable", n.isCheckable()); bool(sb, "checked", n.isChecked());
        bool(sb, "clickable", n.isClickable()); bool(sb, "enabled", n.isEnabled());
        bool(sb, "focusable", n.isFocusable()); bool(sb, "focused", n.isFocused());
        bool(sb, "scrollable", n.isScrollable()); bool(sb, "long-clickable", n.isLongClickable());
        bool(sb, "password", n.isPassword()); bool(sb, "selected", n.isSelected());
        bool(sb, "editable", n.isEditable()); bool(sb, "visible-to-user", n.isVisibleToUser());
        sb.append(" bounds=\"[").append(R.left).append(',').append(R.top).append("][").append(R.right).append(',').append(R.bottom).append("]\"");
        int c = n.getChildCount();
        if (c == 0) { sb.append("/>"); return; }
        sb.append('>');
        for (int i = 0; i < c; i++) {
            AccessibilityNodeInfo ch = n.getChild(i);
            if (ch != null) dumpNode(ch, sb, i);
        }
        sb.append("</node>");
    }

    static void bool(StringBuilder sb, String k, boolean v) { sb.append(' ').append(k).append("=\"").append(v).append('"'); }

    static void attr(StringBuilder sb, String k, CharSequence v) {
        sb.append(' ').append(k).append("=\"");
        if (v != null) {
            for (int i = 0; i < v.length(); i++) {
                char ch = v.charAt(i);
                switch (ch) {
                    case '&': sb.append("&amp;"); break;
                    case '<': sb.append("&lt;"); break;
                    case '>': sb.append("&gt;"); break;
                    case '"': sb.append("&quot;"); break;
                    case '\n': sb.append("&#10;"); break;
                    case '\r': sb.append("&#13;"); break;
                    default: sb.append(ch);
                }
            }
        }
        sb.append('"');
    }

    static String oneLine(Throwable t) {
        Throwable c = t;
        while (c.getCause() != null && c != c.getCause()) c = c.getCause();
        return (c.getClass().getName() + ": " + c.getMessage()).replace('\n', ' ');
    }
}
