import AppKit
import Darwin

// Only local events in this synthetic window are observed. Never reads event
// characters, logs physical key codes, or installs a global keyboard monitor.
final class StopFixtureDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var monitor: Any?
  let instruction = NSTextField(labelWithString: "Preparing. Keep the mouse and keyboard idle.")
  let field = NSTextField(frame: NSRect(x: 30, y: 80, width: 600, height: 40))
  var finished = false
  func prompt() {
    instruction.stringValue = "Press Control + Command + Escape NOW."
    window.backgroundColor = NSColor.systemRed.withAlphaComponent(0.5)
    emit(["kind": "prompt", "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000])
  }
  func emit(_ event: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: event) else { return }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(
      contentRect: NSRect(x: 120, y: 120, width: 660, height: 240),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "F5 physical stop check — synthetic input only"
    window.center()
    instruction.frame = NSRect(x: 30, y: 145, width: 600, height: 55)
    instruction.font = NSFont.systemFont(ofSize: 20)
    instruction.maximumNumberOfLines = 2
    window.contentView!.addSubview(instruction)
    field.setAccessibilityLabel("Rehearsal input")
    window.contentView!.addSubview(field)
    monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .keyUp, .flagsChanged]) {
      [weak self] event in
      guard let self, let native = event.cgEvent else { return event }
      let observedAtMs = ProcessInfo.processInfo.systemUptime * 1000
      let marked = native.getIntegerValueField(.eventSourceUserData) == 0xF5C0
      let chord = !marked && event.type == .keyDown && event.keyCode == 53
        && event.modifierFlags.contains([.control, .command])
      self.emit([
        "kind": marked ? "injected" : chord ? "chord" : "physical",
        "eventAtMs": event.timestamp * 1000,
        "observedAtMs": observedAtMs,
        "keyDown": event.type == .keyDown,
      ])
      if chord {
        self.instruction.stringValue = "Stopped. Release the keys; measuring the final input tail."
        self.window.backgroundColor = NSColor.systemGreen.withAlphaComponent(0.25)
      }
      return event
    }
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(field)
    NSApplication.shared.activate(ignoringOtherApps: true)
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      var buffer = Data()
      var bytes = [UInt8](repeating: 0, count: 1024)
      while true {
        let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
        if count <= 0 { break }
        buffer.append(contentsOf: bytes.prefix(count))
        guard buffer.count <= 4096 else { break }
        while let end = buffer.firstIndex(of: 10) {
          let command = String(decoding: buffer.prefix(upTo: end), as: UTF8.self)
          buffer.removeSubrange(...end)
          DispatchQueue.main.async {
            guard let self else { return }
            if command == "COUNTDOWN" || command == "COUNTDOWN_WAIT" {
              self.emit(["kind": "countdown", "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000])
              for seconds in [3, 2, 1] {
                DispatchQueue.main.asyncAfter(deadline: .now() + Double(3 - seconds)) {
                  self.instruction.stringValue = "Get ready: \(seconds)… Wait for RED."
                  self.window.backgroundColor = NSColor.systemYellow.withAlphaComponent(0.25)
                }
              }
              DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                if command == "COUNTDOWN" { self.prompt() }
                else { self.instruction.stringValue = "Ready. Wait for RED." }
              }
            } else if command == "CALIBRATE" {
              self.emit(["kind": "calibration", "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000])
            } else if command == "GO" {
              self.prompt()
            } else if command == "FINISH" {
              self.finished = true
              self.instruction.stringValue = "Check complete. You can use your computer again."
              self.emit([
                "kind": "finished", "observedAtMs": ProcessInfo.processInfo.systemUptime * 1000,
                "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
              ])
            }
          }
        }
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      FileHandle.standardOutput.write(Data("FIXTURE_READY\n".utf8))
    }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let application = NSApplication.shared
let delegate = StopFixtureDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
