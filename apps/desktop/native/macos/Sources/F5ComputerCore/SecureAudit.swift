import CoreGraphics

/// One accessibility element as the secure-field audit reads it.
/// `childrenReadable` is false only when reading children failed with a real error.
public struct ComputerSecureAuditNode<Handle> {
  public var role: String?
  public var subrole: String?
  public var frame: CGRect?
  public var children: [Handle]
  public var childrenReadable: Bool
  public init(
    role: String?, subrole: String? = nil, frame: CGRect?, children: [Handle] = [],
    childrenReadable: Bool = true
  ) {
    self.role = role
    self.subrole = subrole
    self.frame = frame
    self.children = children
    self.childrenReadable = childrenReadable
  }
}

/// Rects to mask in one window: secure fields plus any region the audit could not establish
/// as safe. `complete` is false when any such region was masked.
public struct ComputerSecureAudit: Equatable {
  public var rects: [CGRect]
  public var complete: Bool
  public init(rects: [CGRect], complete: Bool) {
    self.rects = rects
    self.complete = complete
  }
}

public func computerSecureAuditRectIsValid(_ rect: CGRect) -> Bool {
  !rect.isEmpty && !rect.isInfinite && !rect.isNull
    && rect.origin.x.isFinite && rect.origin.y.isFinite
    && rect.width.isFinite && rect.height.isFinite
}

/// Text and image leaves cannot contain a secure field; Chrome's inline text boxes under
/// them are a large share of a web page's nodes.
let computerSecureAuditLeafRoles: Set<String> = ["AXStaticText", "AXImage"]

struct SecureAuditEntry<Handle> {
  let handle: Handle
  let depth: Int
  /// Nearest valid ancestor frame below the window root.
  let fallback: CGRect?
}
struct SecureAuditRectKey: Hashable {
  let x, y, width, height: Double
  init(_ rect: CGRect) {
    (x, y, width, height) = (rect.minX, rect.minY, rect.width, rect.height)
  }
}

/// Breadth-first secure-field audit of one window. Fails closed per region: anything that
/// cannot be audited (unreadable, too deep, over budget, out of time) masks its own frame,
/// or its nearest ancestor's when it has none. Returns nil, meaning mask the whole window,
/// when the root is unreadable or the fallback reaches the window root.
public func computerSecureAudit<Handle>(
  root: Handle, read: (Handle) -> ComputerSecureAuditNode<Handle>?, maxDepth: Int,
  maxNodes: Int, expired: () -> Bool
) -> ComputerSecureAudit? {
  typealias Entry = SecureAuditEntry<Handle>
  var rects: [CGRect] = []
  var seen = Set<SecureAuditRectKey>()
  var complete = true
  func append(_ rect: CGRect) {
    if seen.insert(SecureAuditRectKey(rect)).inserted { rects.append(rect) }
  }
  /// False when only the whole window can cover this region.
  func mask(_ frame: CGRect?, _ entry: Entry) -> Bool {
    guard entry.depth > 0 else { return false }
    if let frame, computerSecureAuditRectIsValid(frame) {
      append(frame)
    } else if let fallback = entry.fallback {
      append(fallback)
    } else {
      return false
    }
    return true
  }
  var queue = [Entry(handle: root, depth: 0, fallback: nil)]
  var head = 0
  var visited = 0
  while head < queue.count {
    if visited >= maxNodes || expired() {
      complete = false
      for entry in queue[head...] {
        guard let fallback = entry.fallback else { return nil }
        append(fallback)
      }
      break
    }
    let entry = queue[head]
    head += 1
    visited += 1
    guard let node = read(entry.handle), let role = node.role else {
      complete = false
      guard mask(nil, entry) else { return nil }
      continue
    }
    if role == "AXSecureTextField" || node.subrole == "AXSecureTextField" {
      guard mask(node.frame, entry) else { return nil }
      continue
    }
    if !node.childrenReadable {
      complete = false
      guard mask(node.frame, entry) else { return nil }
      continue
    }
    if computerSecureAuditLeafRoles.contains(role) || node.children.isEmpty { continue }
    if entry.depth >= maxDepth {
      complete = false
      guard mask(node.frame, entry) else { return nil }
      continue
    }
    let own = node.frame.flatMap { computerSecureAuditRectIsValid($0) ? $0 : nil }
    let fallback = entry.depth == 0 ? nil : own ?? entry.fallback
    for child in node.children {
      queue.append(Entry(handle: child, depth: entry.depth + 1, fallback: fallback))
    }
  }
  return ComputerSecureAudit(rects: rects, complete: complete)
}
