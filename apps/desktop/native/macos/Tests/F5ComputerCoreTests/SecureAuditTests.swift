import ApplicationServices
import CoreGraphics
import XCTest
@testable import F5ComputerCore

final class SecureAuditTests: XCTestCase {
  typealias Node = ComputerSecureAuditNode<Int>
  final class Reads { var ids: [Int] = [] }
  let window = CGRect(x: 0, y: 0, width: 1000, height: 800)
  let web = CGRect(x: 0, y: 80, width: 1000, height: 720)

  func audit(
    _ tree: [Int: Node], maxDepth: Int = 80, maxNodes: Int = 20000,
    expired: @escaping () -> Bool = { false }, reads: Reads = Reads()
  ) -> ComputerSecureAudit? {
    computerSecureAudit(
      root: 0,
      read: { id in
        reads.ids.append(id)
        return tree[id]
      }, maxDepth: maxDepth, maxNodes: maxNodes, expired: expired)
  }
  func rect(_ x: Double, _ y: Double) -> CGRect { CGRect(x: x, y: y, width: 40, height: 20) }
  /// Window > web area > small wrapper whose secure descendant renders far outside it.
  func escapingTree(wrapper: Node? = nil) -> [Int: Node] {
    [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXWebArea", frame: web, children: [2]),
      2: wrapper ?? Node(role: "AXGroup", frame: rect(10, 90), children: [3]),
      3: Node(role: "AXSecureTextField", frame: CGRect(x: 500, y: 500, width: 100, height: 30)),
    ]
  }

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

  func testBudgetCutoffMasksClippingAncestorNotWrapperFrame() {
    let result = audit(escapingTree(), maxNodes: 3)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [web], complete: false))
  }

  func testDepthCutoffMasksClippingAncestorNotNodeFrame() {
    XCTAssertEqual(
      audit(escapingTree(), maxDepth: 2), ComputerSecureAudit(rects: [web], complete: false))
  }

  func testUnreadableSubtreeMasksClippingAncestorNotNodeFrame() {
    let wrapper = Node(role: "AXGroup", frame: rect(10, 90), childrenReadable: false)
    XCTAssertEqual(
      audit(escapingTree(wrapper: wrapper)), ComputerSecureAudit(rects: [web], complete: false))
    var unreadable = escapingTree()
    unreadable[2] = nil
    XCTAssertEqual(audit(unreadable), ComputerSecureAudit(rects: [web], complete: false))
  }

  func testCutoffWithoutClippingAncestorMasksWholeWindow() {
    var tree = escapingTree()
    tree[1] = Node(role: "AXGroup", frame: web, children: [2])
    XCTAssertNil(audit(tree, maxNodes: 3))
    XCTAssertNil(audit(tree, maxDepth: 2))
  }

  func testExpiredDeadlineMasksLikeBudget() {
    var checks = 0
    let result = audit(escapingTree(), expired: {
      checks += 1
      return checks > 3
    })
    XCTAssertEqual(result, ComputerSecureAudit(rects: [web], complete: false))
  }

  func testShallowSecureFieldStaysExactWhileDeepSiblingExhaustsBudget() {
    let password = rect(100, 100)
    let list = CGRect(x: 500, y: 100, width: 400, height: 600)
    var tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXWebArea", frame: web, children: [2, 3]),
      2: Node(role: "AXSecureTextField", frame: password),
      3: Node(role: "AXScrollArea", frame: list, children: [4]),
    ]
    for depth in 4...40 { tree[depth] = Node(role: "AXGroup", frame: rect(600, 200), children: [depth + 1]) }
    let result = audit(tree, maxNodes: 8)
    XCTAssertEqual(result, ComputerSecureAudit(rects: [password, list], complete: false))
  }

  func testPendingFrontierWithAnyEntryOutsideAClipMasksWholeWindow() {
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1, 2]),
      1: Node(role: "AXWebArea", frame: web, children: [3]),
      2: Node(role: "AXGroup", frame: rect(0, 0), children: [4]),
      3: Node(role: "AXButton", frame: rect(100, 100)),
      4: Node(role: "AXButton", frame: rect(0, 0)),
    ]
    XCTAssertNil(audit(tree, maxNodes: 3))
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
    let reads = Reads()
    XCTAssertEqual(audit(tree, reads: reads), ComputerSecureAudit(rects: [], complete: true))
    XCTAssertEqual(reads.ids, [0, 1, 2])
  }

  func testSecureFieldWithoutUsableFrameIsIncomplete() {
    let invalid = Node(role: "AXSecureTextField", frame: CGRect(x: 0, y: 0, width: Double.infinity, height: 10))
    var tree = escapingTree()
    tree[3] = invalid
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [web], complete: false))
    tree[1] = Node(role: "AXGroup", frame: web, children: [2])
    XCTAssertNil(audit(tree))
  }

  func testMasksAlreadyCoveredAreSkipped() {
    let tree: [Int: Node] = [
      0: Node(role: "AXWindow", frame: window, children: [1]),
      1: Node(role: "AXWebArea", frame: web, children: [2, 3]),
      2: Node(role: "AXGroup", frame: rect(10, 90), childrenReadable: false),
      3: Node(role: "AXSecureTextField", frame: rect(100, 100)),
    ]
    XCTAssertEqual(audit(tree), ComputerSecureAudit(rects: [web], complete: false))
  }

  func testDeadlineSplitsRemainingBudgetAcrossWindowsLeft() {
    XCTAssertEqual(computerSecureAuditDeadline(now: 10, end: 12, windowsLeft: 2), 11)
    XCTAssertEqual(computerSecureAuditDeadline(now: 11.5, end: 12, windowsLeft: 1), 12)
    XCTAssertEqual(computerSecureAuditDeadline(now: 13, end: 12, windowsLeft: 1), 13)
    XCTAssertEqual(computerSecureAuditDeadline(now: 10, end: 12, windowsLeft: 0), 12)
  }

  func testBatchedValuesParseFrameAndChildErrors() throws {
    func error(_ code: AXError) -> AnyObject {
      var code = code
      return AXValueCreate(.axError, &code)!
    }
    var point = CGPoint(x: 10, y: 20)
    var size = CGSize(width: 30, height: 40)
    let position = AXValueCreate(.cgPoint, &point)!
    let dimensions = AXValueCreate(.cgSize, &size)!
    let failed = try XCTUnwrap(computerSecureAuditNode(
      ["AXGroup" as NSString, error(.noValue), position, dimensions, error(.cannotComplete)]))
    XCTAssertEqual(failed.role, "AXGroup")
    XCTAssertNil(failed.subrole)
    XCTAssertEqual(failed.frame, CGRect(x: 10, y: 20, width: 30, height: 40))
    XCTAssertFalse(failed.childrenReadable)
    XCTAssertTrue(failed.children.isEmpty)
    let leaf = try XCTUnwrap(computerSecureAuditNode(
      [error(.cannotComplete), "AXSecureTextField" as NSString, error(.noValue), dimensions,
        error(.attributeUnsupported)]))
    XCTAssertNil(leaf.role)
    XCTAssertEqual(leaf.subrole, "AXSecureTextField")
    XCTAssertNil(leaf.frame)
    XCTAssertTrue(leaf.childrenReadable)
    let parent = try XCTUnwrap(computerSecureAuditNode(
      ["AXGroup" as NSString, error(.noValue), position, dimensions,
        [AXUIElementCreateApplication(getpid())] as NSArray]))
    XCTAssertEqual(parent.children.count, 1)
    XCTAssertTrue(parent.childrenReadable)
    XCTAssertNil(computerSecureAuditNode(["AXGroup" as NSString]))
  }
}
