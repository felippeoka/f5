import XCTest

@testable import F5ComputerCore

final class InspectionTests: XCTestCase {
  func testOnlyEmptyUnfocusedWrappersWithWeakActionsArePruned() {
    for role in ["AXGroup", "AXUnknown", "AXGenericElement"] {
      XCTAssertTrue(
        computerInspectIsWrapper(role: role, name: "", value: nil, focused: false, actions: []))
      XCTAssertTrue(
        computerInspectIsWrapper(
          role: role, name: "", value: "", focused: false, actions: ["showMenu", "scrollIntoView"]))
      XCTAssertFalse(
        computerInspectIsWrapper(
          role: role, name: "Drawer", value: nil, focused: false, actions: []))
      XCTAssertFalse(
        computerInspectIsWrapper(role: role, name: "", value: "text", focused: false, actions: []))
      XCTAssertFalse(
        computerInspectIsWrapper(role: role, name: "", value: nil, focused: true, actions: []))
      XCTAssertFalse(
        computerInspectIsWrapper(
          role: role, name: "", value: nil, focused: false, actions: ["press"]))
    }
    XCTAssertFalse(
      computerInspectIsWrapper(role: "AXButton", name: "", value: nil, focused: false, actions: []))
  }
  func testWrapperDescendantsRemainInDepthFirstOrderAndOnlyUsefulNodesSpendBudget() {
    var visited: [Int] = []
    let truncated = computerInspectWalk(root: 0, maxNodes: 2, stop: { false }) { id in
      visited.append(id)
      return (id == 0 ? [1, 2] : id == 1 ? [3] : [], id != 0 && id != 1)
    }
    XCTAssertEqual(visited, [0, 1, 3, 2])
    XCTAssertFalse(truncated)
  }
  func testEmittedAndVisitedCapsAreSoftAndReportTruncation() {
    var visits = 0
    XCTAssertTrue(
      computerInspectWalk(root: 0, maxNodes: 1000, stop: { false }) { id in
        visits += 1
        return ([id + 1], true)
      })
    XCTAssertEqual(visits, 800)
    visits = 0
    XCTAssertTrue(
      computerInspectWalk(root: 0, maxNodes: 400, stop: { false }) { id in
        visits += 1
        return ([id + 1], false)
      })
    XCTAssertEqual(visits, 4000)
  }
  func testTimeStopReturnsPartialButRequestDeadlineStillThrows() {
    var visits = 0
    XCTAssertTrue(
      computerInspectWalk(root: 0, maxNodes: 400, stop: { visits >= 3 }) { id in
        visits += 1
        return ([id + 1], true)
      })
    XCTAssertEqual(visits, 3)
    enum Deadline: Error { case expired }
    XCTAssertThrowsError(
      try computerInspectWalk(
        root: 0, maxNodes: 400,
        stop: {
          throw Deadline.expired
        },
        visit: { _ in
          XCTFail("Must not read after request deadline")
          return ([], false)
        }))
  }
}
