import CoreGraphics

/// Shareable-content metadata only; no desktop pixel read or window titles.
public func computerCaptureWindowIntersectsDisplay(window: CGRect, display: CGRect) -> Bool {
  guard !window.isEmpty, !display.isEmpty else { return false }
  return !window.intersection(display).isEmpty
}

/// Each captured window needs its own audit, regardless of the foreground app.
/// A missing, partial or invalid audit hides that entire window.
public func computerSecureCaptureMasks(
  windows: [CGRect], audit: (Int) -> [CGRect]?
) -> (rects: [CGRect], incomplete: Bool) {
  var masks: [CGRect] = []
  var incomplete = false
  for (index, window) in windows.enumerated() {
    guard let secure = audit(index), secure.allSatisfy({
      !$0.isEmpty && !$0.isInfinite && !$0.isNull
        && $0.origin.x.isFinite && $0.origin.y.isFinite
        && $0.width.isFinite && $0.height.isFinite
    }) else {
      masks.append(window)
      incomplete = true
      continue
    }
    masks.append(contentsOf: secure)
  }
  return (masks, incomplete)
}
