import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class SecureAuditTests: XCTestCase {
  typealias Node = ComputerSecureAuditNode<Int>
  let window = CGRect(x: 0, y: 0, width: 1000, height: 800)

  func audit(
    _ tree: [Int: Node], maxDepth: Int = 80, maxNodes: Int = 20000,
    expired: @escaping () -> Bool = { false }, reads: UnsafeMutablePointer<[Int]>? = nil
  ) -> ComputerSecureAudit? {
    computerSecureAudit(
      root: 0,
      read: { id in
        reads?.pointee.append(id)
        return tree[id]
      }, maxDepth: maxDepth, maxNodes: maxNodes, expired: expired)
  }
  func rect(_ x: Double, _ y: Double) -> CGRect { CGRect(x: x, y: y, width: 40, height: 20) }

  func testCompleteTreeMasksOnlyThePasswordField() {
    let password = rect(100, 100)
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXGroup", frame: CGRect(x: 0, y: 50, width: 1000, height: 750), children: [3]),
      2: Node(role: "AXButton", frame: rect(0, 0)),
      3: Node(role: "AXTextField", subrole: "AXSecureTextField", frame: password),
    ]
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [password], complete: true))
  }

  func testTreeDeeperThanLimitMasksOnlyTheDeepNode() {
    var tree: [Int: Node] = [0: Node(role: "AXWindow", frame: window, children: [1])]
    for depth in 1...10 {
      tree[depth] = Node(role: "AXGroup", frame: rect(Double(depth), 0), children: [depth + 1])
    }
    tree[11] = Node(role: "AXButton", frame: rect(11, 0))
    let result = audit(tree, maxDepth: 5)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [rect(5, 0)], complete: false))
  }

  func testExhaustedBudgetMasksPendingNodesParentFrames() {
    let left = CGRect(x: 0, y: 0, width: 500, height: 800)
    let right = CGRect(x: 500, y: 0, width: 500, height: 800)
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXGroup", frame: left, children: [3, 4]),
      2: Node(role: "AXGroup", frame: right, children: [5]),
      3: Node(role: "AXButton", frame: rect(0, 0)),
      4: Node(role: "AXButton", frame: rect(50, 0)),
      5: Node(role: "AXButton", frame: rect(600, 0)),
    ]
    let result = audit(tree, maxNodes: 3)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [left, right], complete: false))
    XCTAssertFalse(result?.rects.contains(window) ?? true)
  }

  func testExpiredDeadlineMasksPendingNodesLikeBudget() {
    let group = CGRect(x: 0, y: 0, width: 500, height: 800)
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXGroup", frame: group, children: [2, 3]),
      2: Node(role: "AXButton", frame: rect(0, 0)),
      3: Node(role: "AXButton", frame: rect(50, 0)),
    ]
    var checks = 0
    let result = audit(tree, expired: {
      checks += 1
      return checks > 2
    })
    XCTAssertEqual(result, ComputerSecureAudit(rects: [group], complete: false))
  }

  func testPendingChildOfWindowRootMasksWholeWindow() {
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXButton", frame: rect(0, 0)),
      2: Node(role: "AXButton", frame: rect(50, 0)),
    ]
    XCTAssertNil(audit(tree, maxNodes: 2))
  }

  func testUnreadableChildWithoutFrameMasksNearestAncestorFrame() {
    let group = CGRect(x: 0, y: 100, width: 600, height: 400)
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXGroup", frame: group, children: [2]),
      2: Node(role: "AXGroup", frame: nil, children: [3]),
      3: Node(role: nil, frame: nil),
    ]
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [group], complete: false))
  }

  func testUnreadableChildrenMaskThatNode() {
    let group = CGRect(x: 0, y: 100, width: 600, height: 400)
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXGroup", frame: group, childrenReadable: false),
    ]
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [group], complete: false))
  }

  func testUnreadableRootMasksWholeWindow() {
    XCTAssertNil(audit([:]))
    XCTAssertNil(audit([0: Node(role: "AXWindow", frame: window, childrenReadable: false)]))
  }

  func testTextAndImageSubtreesAreNotVisited() {
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXStaticText", frame: rect(0, 0), children: [3]),
      2: Node(role: "AXImage", frame: rect(50, 0), children: [4]),
      3: Node(role: "AXInlineTextBox", frame: rect(0, 0)),
      4: Node(role: "AXGroup", frame: rect(50, 0)),
    ]
    var reads: [Int] = []
    let result = audit(tree, reads: &reads)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [], complete: true))
    XCTAssertEqual(reads, [0, 1, 2])
  }

  func testSecureFieldWithInvalidFrameMasksAncestorFrame() {
    let form = CGRect(x: 100, y: 100, width: 300, height: 200)
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXGroup", frame: form, children: [2]),
      2: Node(role: "AXSecureTextField", frame: CGRect(x: 0, y: 0, width: Double.infinity, height: 10)),
    ]
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [form], complete: true))
  }
}
