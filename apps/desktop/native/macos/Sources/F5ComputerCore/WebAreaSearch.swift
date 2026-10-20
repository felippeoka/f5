/// Searches text fields in a web area and every nested frame without walking DOM children.
/// nil means the root search is unavailable, so the caller should walk normally. A limit-sized
/// result means incomplete (also used for a failed nested search or an expired deadline).
public func computerSearchWebArea<Handle: Hashable>(
  root: Handle, expired: () -> Bool,
  query: (Handle, String) -> [Handle]?
) -> [Handle]? {
  let limit = 5000
  var queue = [root]
  var seen: Set<Handle> = [root]
  var results: [Handle] = []
  var head = 0
  func incomplete() -> [Handle] { Array(repeating: root, count: limit) }
  while head < queue.count {
    if expired() { return incomplete() }
    let frame = queue[head]
    head += 1
    guard let text = query(frame, "AXTextFieldSearchKey"),
      !expired(), let frames = query(frame, "AXFrameSearchKey")
    else { return head == 1 && !expired() ? nil : incomplete() }
    if text.count >= limit || frames.count >= limit { return incomplete() }
    results.append(contentsOf: text)
    if results.count >= limit { return incomplete() }
    for child in frames where seen.insert(child).inserted {
      queue.append(child)
      // Include frame results so the audit budgets and checks their readability too.
      results.append(child)
    }
    if results.count >= limit { return incomplete() }
  }
  return results
}
