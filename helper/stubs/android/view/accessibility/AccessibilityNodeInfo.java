package android.view.accessibility; public class AccessibilityNodeInfo {
  public int getChildCount() { return 0; } public AccessibilityNodeInfo getChild(int i) { return null; }
  public CharSequence getText() { return null; } public CharSequence getContentDescription() { return null; }
  public CharSequence getClassName() { return null; } public CharSequence getPackageName() { return null; }
  public CharSequence getHintText() { return null; }
  public String getViewIdResourceName() { return null; }
  public boolean isCheckable() { return false; } public boolean isChecked() { return false; } public boolean isClickable() { return false; }
  public boolean isEnabled() { return false; } public boolean isFocusable() { return false; } public boolean isFocused() { return false; }
  public boolean isScrollable() { return false; } public boolean isLongClickable() { return false; } public boolean isPassword() { return false; }
  public boolean isSelected() { return false; } public boolean isVisibleToUser() { return false; } public boolean isEditable() { return false; }
  public void getBoundsInScreen(android.graphics.Rect r) {} public AccessibilityNodeInfo findFocus(int f) { return null; }
  public boolean performAction(int a, android.os.Bundle b) { return false; } public boolean performAction(int a) { return false; }
  public boolean refresh() { return false; }
  public int getTextSelectionStart() { return -1; } public int getTextSelectionEnd() { return -1; } public boolean isShowingHintText() { return false; } }
