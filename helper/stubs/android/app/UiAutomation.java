package android.app; public final class UiAutomation {
  public void disconnect() {} public android.view.accessibility.AccessibilityNodeInfo getRootInActiveWindow() { return null; }
  public java.util.List<android.view.accessibility.AccessibilityWindowInfo> getWindows() { return null; }
  public boolean injectInputEvent(android.view.InputEvent e, boolean sync) { return false; }
  public android.graphics.Bitmap takeScreenshot() { return null; }
  public android.accessibilityservice.AccessibilityServiceInfo getServiceInfo() { return null; }
  public void setServiceInfo(android.accessibilityservice.AccessibilityServiceInfo i) {}
  public void waitForIdle(long idle, long global) throws java.util.concurrent.TimeoutException {} }
