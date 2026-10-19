import CoreGraphics

/// Shareable-content metadata only; no desktop pixel read or window titles.
public func computerCaptureWindowIntersectsDisplay(window: CGRect, display: CGRect) -> Bool {
  guard !window.isEmpty, !display.isEmpty else { return false }
  return !window.intersection(display).isEmpty
}

/// Each captured window needs its own audit, regardless of the foreground app.
/// A missing or invalid audit hides that entire window; a partial audit hides only the
/// regions it could not establish as safe. A window's content cannot render outside its
/// frame, so masks are clipped to it and never cover other granted windows.
public func computerSecureCaptureMasks(
  windows: [CGRect], audit: (Int) -> ComputerSecureAudit?
) -> (rects: [CGRect], incomplete: Bool) {
  var masks: [CGRect] = []
  var incomplete = false
  for (index, window) in windows.enumerated() {
    guard let result = audit(index), result.rects.allSatisfy(computerSecureAuditRectIsValid)
    else {
      masks.append(window)
      incomplete = true
      continue
    }
    masks.append(
      contentsOf: result.rects.map { $0.intersection(window) }.filter { !$0.isNull && !$0.isEmpty })
    if !result.complete { incomplete = true }
  }
  return (masks, incomplete)
}
