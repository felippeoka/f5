import ApplicationServices
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

/// Attributes the audit reads per element, in the order `computerSecureAuditNode` expects.
public let computerSecureAuditAttributes =
  [kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute,
    kAXChildrenAttribute] as CFArray

/// The AX error a batched attribute read returned in place of a value, if any.
public func computerAXBatchError(_ value: AnyObject) -> AXError? {
  guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let wrapped = unsafeBitCast(value, to: AXValue.self)
  var error = AXError.success
  guard AXValueGetType(wrapped) == .axError, AXValueGetValue(wrapped, .axError, &error)
  else { return nil }
  return error
}

func computerAXValue<T>(_ value: AnyObject, _ type: AXValueType, _ empty: T) -> T? {
  guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
  let wrapped = unsafeBitCast(value, to: AXValue.self)
  var result = empty
  guard AXValueGetType(wrapped) == type, AXValueGetValue(wrapped, type, &result) else { return nil }
  return result
}

/// Parses one batched read of `computerSecureAuditAttributes`. Missing attributes come back
/// as embedded AX errors; children count as unreadable only for real errors.
public func computerSecureAuditNode(_ values: [AnyObject]) -> ComputerSecureAuditNode<AXUIElement>? {
  guard values.count == 5 else { return nil }
  let frame = computerAXValue(values[2], .cgPoint, CGPoint.zero).flatMap { point in
    computerAXValue(values[3], .cgSize, CGSize.zero).map { CGRect(origin: point, size: $0) }
  }
  let childrenError = computerAXBatchError(values[4])
  return ComputerSecureAuditNode(
    role: values[0] as? String, subrole: values[1] as? String, frame: frame,
    children: childrenError == nil ? values[4] as? [AXUIElement] ?? [] : [],
    childrenReadable: childrenError.map { $0 == .attributeUnsupported || $0 == .noValue } ?? true)
}

/// Text and image leaves cannot contain a secure field; Chrome's inline text boxes under
/// them are a large share of a web page's nodes.
let computerSecureAuditLeafRoles: Set<String> = ["AXStaticText", "AXImage"]

/// Roles whose frame clips everything rendered beneath them, so the frame can stand in for
/// an unaudited subtree. Other AX frames need not contain their descendants: positioned,
/// transformed, top-layer or aria-owns web content renders outside its ancestors' boxes.
let computerSecureAuditClippingRoles: Set<String> = ["AXScrollArea", "AXWebArea"]

struct SecureAuditEntry<Handle> {
  let handle: Handle
  let depth: Int
  /// Frame of the nearest clipping ancestor below the window root; nil means the window.
  let clip: CGRect?
}

/// This window's share of what remains of a capture's audit budget, taken once the window's
/// AX element is resolved. Time a fast window leaves unused rolls over to later windows.
public func computerSecureAuditDeadline(
  now: TimeInterval, end: TimeInterval, windowsLeft: Int
) -> TimeInterval {
  now + max(0, end - now) / Double(max(1, windowsLeft))
}

/// Breadth-first secure-field audit of one window. Fails closed: secure fields mask their own
/// frame, and anything that cannot be audited (unreadable, too deep, over budget, out of time,
/// or a secure field without a usable frame) masks its nearest clipping ancestor and marks the
/// audit incomplete. Returns nil, meaning mask the whole window, when the root is unreadable or
/// no clipping ancestor sits below the window.
public func computerSecureAudit<Handle>(
  root: Handle, read: (Handle) -> ComputerSecureAuditNode<Handle>?, maxDepth: Int,
  maxNodes: Int, expired: () -> Bool
) -> ComputerSecureAudit? {
  typealias Entry = SecureAuditEntry<Handle>
  var rects: [CGRect] = []
  var complete = true
  func append(_ rect: CGRect) {
    if !rects.contains(where: { $0.contains(rect) }) { rects.append(rect) }
  }
  /// Masks `region`, else the entry's clip. False when only the whole window can cover it.
  func unaudited(_ entry: Entry, region: CGRect? = nil) -> Bool {
    complete = false
    guard entry.depth > 0, let rect = region ?? entry.clip else { return false }
    append(rect)
    return true
  }
  var queue = [Entry(handle: root, depth: 0, clip: nil)]
  var head = 0
  var visited = 0
  while head < queue.count {
    if visited >= maxNodes || expired() {
      for entry in queue[head...] {
        guard unaudited(entry) else { return nil }
      }
      break
    }
    let entry = queue[head]
    head += 1
    visited += 1
    guard let node = read(entry.handle), let role = node.role else {
      guard unaudited(entry) else { return nil }
      continue
    }
    let own = node.frame.flatMap { computerSecureAuditRectIsValid($0) ? $0 : nil }
    if role == "AXSecureTextField" || node.subrole == "AXSecureTextField" {
      if let own { append(own) } else if !unaudited(entry) { return nil }
      continue
    }
    if computerSecureAuditLeafRoles.contains(role) { continue }
    let clip = computerSecureAuditClippingRoles.contains(role) ? own ?? entry.clip : entry.clip
    if !node.childrenReadable || (entry.depth >= maxDepth && !node.children.isEmpty) {
      guard unaudited(entry, region: clip) else { return nil }
      continue
    }
    for child in node.children {
      queue.append(Entry(handle: child, depth: entry.depth + 1, clip: entry.depth == 0 ? nil : clip))
    }
  }
  return ComputerSecureAudit(rects: rects, complete: complete)
}
