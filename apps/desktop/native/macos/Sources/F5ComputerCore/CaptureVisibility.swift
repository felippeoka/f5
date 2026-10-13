import CoreGraphics

/// Shareable-content metadata only; no desktop pixel read or window titles.
public func computerCaptureWindowIntersectsDisplay(window: CGRect, display: CGRect) -> Bool {
  guard !window.isEmpty, !display.isEmpty else { return false }
  return !window.intersection(display).isEmpty
}
