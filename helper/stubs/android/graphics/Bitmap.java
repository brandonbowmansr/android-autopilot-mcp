package android.graphics; public final class Bitmap {
  public enum CompressFormat { JPEG, PNG, WEBP }
  public int getWidth() { return 0; } public int getHeight() { return 0; }
  public static Bitmap createScaledBitmap(Bitmap src, int w, int h, boolean filter) { return null; }
  public boolean compress(CompressFormat f, int q, java.io.OutputStream o) { return false; }
  public void recycle() {} }
