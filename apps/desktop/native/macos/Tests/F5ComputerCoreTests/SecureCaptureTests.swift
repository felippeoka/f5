import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class SecureCaptureTests: XCTestCase {
  func testBackgroundAndSecondWindowsAreAuditedWithoutForegroundState() {
    let windows = [CGRect(x: 0, y: 0, width: 100, height: 100), CGRect(x: -100, y: 0, width: 100, height: 100), CGRect(x: 0, y: 100, width: 100, height: 100)]
    let passwords = windows.map { CGRect(x: $0.minX + 10, y: $0.minY + 10, width: 20, height: 10) }
    var scanned: [Int] = []
    let result = computerSecureCaptureMasks(windows: windows) { index in
      scanned.append(index)
      return [passwords[index]]
    }
    XCTAssertEqual(scanned, [0, 1, 2])
    XCTAssertEqual(result.rects, passwords)
    XCTAssertFalse(result.incomplete)
  }
  func testMissingOrPartialAuditMasksOnlyThatWholeWindow() {
    let windows = [CGRect(x: 0, y: 0, width: 100, height: 100), CGRect(x: -100, y: 0, width: 100, height: 100)]
    let result = computerSecureCaptureMasks(windows: windows) { $0 == 0 ? [] : nil }
    XCTAssertEqual(result.rects, [windows[1]])
    XCTAssertTrue(result.incomplete)
    let invalid = computerSecureCaptureMasks(windows: windows) { _ in [.null] }
    XCTAssertEqual(invalid.rects, windows)
    XCTAssertTrue(invalid.incomplete)
  }
}
