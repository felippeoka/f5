/// Unnamed structural wrappers do not spend the emitted-node budget. Chrome exposes the
/// two weak actions even on otherwise empty groups, so they do not make a wrapper useful.
public func computerInspectIsWrapper(
  role: String, name: String, value: String?, focused: Bool, actions: [String]
) -> Bool {
  ["AXGroup", "AXUnknown", "AXGenericElement"].contains(role) && name.isEmpty
    && (value?.isEmpty ?? true) && !focused
    && actions.allSatisfy { ["showMenu", "scrollIntoView"].contains($0) }
}

/// Iterative depth-first traversal. Visited and emitted budgets are independent: pruning a
/// wrapper still visits its descendants. `stop` can throw a request cancellation/deadline or
/// return true for a soft time cutoff. True means there were nodes left when a cap stopped us.
public func computerInspectWalk<Handle>(
  root: Handle, maxNodes: Int, maxVisited: Int = 4000, stop: () throws -> Bool,
  visit: (Handle) throws -> (children: [Handle], emitted: Bool)
) rethrows -> Bool {
  let limit = min(800, max(1, maxNodes))
  var pending = [root]
  var visited = 0
  var emitted = 0
  while !pending.isEmpty {
    if try stop() { return true }
    if emitted >= limit || visited >= maxVisited { return true }
    visited += 1
    let node = try visit(pending.removeLast())
    if node.emitted { emitted += 1 }
    pending.append(contentsOf: node.children.reversed())
  }
  return false
}
