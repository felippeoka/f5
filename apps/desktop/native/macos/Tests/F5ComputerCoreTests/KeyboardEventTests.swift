import CoreGraphics
import XCTest

@testable import F5ComputerCore

final class KeyboardEventTests: XCTestCase {
  func testChordDownCarriesModifiersAndUpClearsThem() throws {
    let modifiers: CGEventFlags = [.maskCommand, .maskShift]
    let down = try XCTUnwrap(computerKeyboardEvent(keyCode: 1, keyDown: true, modifiers: modifiers))
    let up = try XCTUnwrap(computerKeyboardEvent(keyCode: 1, keyDown: false, modifiers: modifiers))
    XCTAssertEqual(down.flags, modifiers)
    XCTAssertTrue(up.flags.isEmpty)
    XCTAssertEqual(down.getIntegerValueField(.keyboardEventKeycode), 1)
    XCTAssertEqual(up.type, .keyUp)
    XCTAssertEqual(up.getIntegerValueField(.eventSourceUserData), 0xF5C0)
  }
  func testUnicodeAndCancellationNeverCarryChordModifiers() throws {
    let units = Array("Ω🙂".utf16)
    for keyDown in [true, false] {
      let event = try XCTUnwrap(computerKeyboardEvent(
        keyCode: 0, keyDown: keyDown, modifiers: .maskCommand, unicode: units))
      XCTAssertTrue(event.flags.isEmpty)
      var actual = 0
      var restored = [UniChar](repeating: 0, count: units.count)
      restored.withUnsafeMutableBufferPointer {
        event.keyboardGetUnicodeString(
          maxStringLength: units.count, actualStringLength: &actual, unicodeString: $0.baseAddress)
      }
      XCTAssertEqual(actual, units.count)
      XCTAssertEqual(restored, units)
      XCTAssertEqual(event.getIntegerValueField(.eventSourceUserData), 0xF5C0)
    }
    let release = try XCTUnwrap(computerKeyboardEvent(keyCode: 0, keyDown: false))
    XCTAssertTrue(release.flags.isEmpty)
  }
}
