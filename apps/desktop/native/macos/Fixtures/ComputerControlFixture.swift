import AppKit

// Synthetic content only. The rehearsal launches this temporary app and grants
// no existing user app. Its editable and secure fields exercise real AX behavior.
final class FixtureDelegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
  var window: NSWindow!
  let counter = NSTextField(labelWithString: "presses: 0")
  let secure = NSSecureTextField(frame: NSRect(x: 30, y: 150, width: 400, height: 28))
  var presses = 0
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 120, y: 120, width: 500, height: 300),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Computer Control Test Fixture"
    window.center()
    let content = window.contentView!
    let ungranted = CommandLine.arguments.contains("--ungranted")
    let marker = NSBox(frame: NSRect(x: 30, y: 260, width: 400, height: 24))
    marker.boxType = .custom
    marker.borderType = .noBorder
    marker.fillColor = ungranted ? NSColor.green : NSColor.blue
    marker.setAccessibilityElement(true)
    marker.setAccessibilityLabel("Rehearsal capture marker")
    content.addSubview(marker)
    if ungranted, let screen = NSScreen.main {
      window.setFrameOrigin(NSPoint(x: screen.visibleFrame.minX + 20, y: window.frame.minY))
    }
    let field = NSTextField(frame: NSRect(x: 30, y: 205, width: 400, height: 28))
    field.setAccessibilityLabel("Rehearsal input")
    field.delegate = self
    content.addSubview(field)
    secure.stringValue = "SYNTHETIC_SECURE_SENTINEL"
    secure.setAccessibilityLabel("Rehearsal secure field")
    content.addSubview(secure)
    let button = NSButton(title: "Rehearsal press", target: self, action: #selector(press))
    button.frame = NSRect(x: 30, y: 90, width: 180, height: 32)
    content.addSubview(button)
    let focusSecure = NSButton(
      title: "Focus secure", target: self, action: #selector(focusSecureField))
    focusSecure.frame = NSRect(x: 230, y: 90, width: 180, height: 32)
    content.addSubview(focusSecure)
    counter.frame = NSRect(x: 30, y: 40, width: 400, height: 28)
    content.addSubview(counter)
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(field)
    NSApplication.shared.activate(ignoringOtherApps: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      FileHandle.standardOutput.write(Data("FIXTURE_READY\n".utf8))
    }
  }
  @objc func press() {
    presses += 1
    counter.stringValue = "presses: \(presses)"
    FileHandle.standardOutput.write(Data("FIXTURE_PRESSED\n".utf8))
  }
  func controlTextDidChange(_ notification: Notification) {
    guard let index = CommandLine.arguments.firstIndex(of: "--expected-text"),
      index + 1 < CommandLine.arguments.count,
      let field = notification.object as? NSTextField,
      field.stringValue == CommandLine.arguments[index + 1]
    else { return }
    // Only a boolean observation leaves the fixture, never the typed content.
    FileHandle.standardOutput.write(Data("FIXTURE_TYPED\n".utf8))
  }
  @objc func focusSecureField() { window.makeFirstResponder(secure) }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = FixtureDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
