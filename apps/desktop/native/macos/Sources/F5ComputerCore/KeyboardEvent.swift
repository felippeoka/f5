import CoreGraphics

// Construct marked agent events from private state so a prior chord or physical
// modifier cannot leak into plain Unicode typing. Chord modifiers apply only to
// key-down; key-up also releases their synthetic event state.
public func computerKeyboardEvent(
  keyCode: CGKeyCode, keyDown: Bool, modifiers: CGEventFlags = [], unicode: [UniChar]? = nil
) -> CGEvent? {
  guard let source = CGEventSource(stateID: .privateState),
    let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: keyDown)
  else { return nil }
  event.flags = keyDown && unicode == nil ? modifiers : []
  if let unicode {
    unicode.withUnsafeBufferPointer {
      event.keyboardSetUnicodeString(stringLength: unicode.count, unicodeString: $0.baseAddress)
    }
  }
  event.setIntegerValueField(.eventSourceUserData, value: 0xF5C0)
  return event
}
