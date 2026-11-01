import XCTest
@testable import Flow

final class MentionRenderingTests: XCTestCase {
    func testFlowUuidMentionStillRendersName() {
        let id = "00000000-0000-0000-0000-0000000000ab"
        XCTAssertEqual(MentionRendering.plainText("hi <@\(id)>", names: [id: "Ada"]), "hi @Ada")
    }
}
