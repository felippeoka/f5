import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class CaptureLayoutTests: XCTestCase {
  private let window = CGRect(x: 185, y: 43, width: 256, height: 213)
  private func neutralCanvas() -> CGContext {
    let canvas = CGContext(
      data: nil, width: 1456, height: 609, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    canvas.setFillColor(CGColor(gray: 0.45, alpha: 1))
    canvas.fill(CGRect(x: 0, y: 0, width: 1456, height: 609))
    return canvas
  }
  /// Fills `rect` given in top-left canvas coordinates.
  private func fill(_ canvas: CGContext, _ rect: CGRect, gray: Double) {
    canvas.setFillColor(CGColor(gray: gray, alpha: 1))
    canvas.fill(
      CGRect(x: rect.minX, y: Double(canvas.height) - rect.maxY, width: rect.width, height: rect.height))
  }
  func testCanvasRectMapsPrimaryAndOffsetDisplays() {
    let primary = CGRect(x: 0, y: 0, width: 3337, height: 1397)
    let mapped = computerCanvasRect(
      CGRect(x: 424, y: 98, width: 586, height: 488), display: primary, canvasWidth: 1456,
      canvasHeight: 609)
    XCTAssertEqual(mapped.minX, 424 * 1456 / 3337, accuracy: 0.001)
    XCTAssertEqual(mapped.minY, 98 * 609 / 1397, accuracy: 0.001)
    XCTAssertEqual(mapped.width, 586 * 1456 / 3337, accuracy: 0.001)
    XCTAssertEqual(mapped.height, 488 * 609 / 1397, accuracy: 0.001)
    let offset = computerCanvasRect(
      CGRect(x: 1424, y: 98, width: 586, height: 488),
      display: CGRect(x: 1000, y: 0, width: 3337, height: 1397), canvasWidth: 1456,
      canvasHeight: 609)
    XCTAssertEqual(offset.minX, mapped.minX, accuracy: 0.001)
    XCTAssertEqual(offset.minY, mapped.minY, accuracy: 0.001)
  }
  func testNeutralCanvasAndContentInsideAllowedRectsPass() {
    let canvas = neutralCanvas()
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: []))
    fill(canvas, window, gray: 0.12)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testAntialiasedEdgesWithinTheMarginPass() {
    let canvas = neutralCanvas()
    fill(canvas, window.insetBy(dx: -2, dy: -2), gray: 0.12)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testSlightColorDriftOutsideAllowedRectsPasses() {
    let canvas = neutralCanvas()
    fill(canvas, CGRect(x: 0, y: 0, width: 1456, height: 609), gray: 0.45 + 8.0 / 255)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testWindowDrawnAtTheTopLeftInsteadOfItsFrameFails() {
    // The observed regression: the window filled 732x609 from the origin.
    let canvas = neutralCanvas()
    fill(canvas, CGRect(x: 0, y: 0, width: 732, height: 609), gray: 0.12)
    XCTAssertTrue(computerCaptureContentOutside(canvas, allowed: [window]))
  }
  func testAFewStrayPixelsDoNotFail() {
    let canvas = neutralCanvas()
    fill(canvas, CGRect(x: 1000, y: 400, width: 8, height: 8), gray: 0.9)
    XCTAssertFalse(computerCaptureContentOutside(canvas, allowed: [window]))
  }
}
