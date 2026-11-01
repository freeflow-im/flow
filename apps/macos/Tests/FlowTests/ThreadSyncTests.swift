import Foundation
import GRDB
import XCTest

@testable import Flow

/// A thread reply that missed its ack used to spin on "sending" forever (#328).
/// These cover the three mechanisms that fix it — the thread fetch that now
/// pages to the tail, the sweep that gives up on a genuinely orphaned row, and
/// the failure UPDATE that no longer libels a message the echo already
/// confirmed — plus the overlap probe that a thread reply used to truncate.
final class ThreadSyncTests: XCTestCase {
    private var server: StubHTTPServer!

    override func tearDown() {
        server?.stop()
        server = nil
        super.tearDown()
    }

    // MARK: Fixtures

    private func makeEngine(_ url: URL) throws -> (SyncEngine, AppDatabase) {
        let db = try AppDatabase.inMemory()
        let engine = SyncEngine(db: db, api: APIClient(baseURL: url), socket: SocketClient(url: url))
        return (engine, db)
    }

    private func insertChannel(_ db: AppDatabase, id: String = "c1") throws {
        try db.writer.write { dbc in
            try dbc.execute(
                sql: """
                    INSERT INTO channel
                        (id, workspaceId, name, kind, isPrivate, createdBy, createdAt,
                         isMember, unreadCount, notifyLevel, unreadNotifications)
                    VALUES (?, 'ws1', 'general', 'standard', 0, 'u1', '2026-08-24', 1, 0, 1, 0)
                    """,
                arguments: [id]
            )
        }
    }

    private func insertMessage(
        _ db: AppDatabase,
        id: String,
        clientMsgId: String? = nil,
        threadRootId: String? = nil,
        createdAt: String = "2026-08-24T00:00:00.000Z",
        replyCount: Int = 0,
        pending: Bool = false,
        failed: Bool = false
    ) throws {
        try db.writer.write { dbc in
            try dbc.execute(
                sql: """
                    INSERT INTO message
                        (id, channelId, userId, threadRootId, clientMsgId, body, createdAt,
                         replyCount, pending, failed)
                    VALUES (?, 'c1', 'u1', ?, ?, 'hi', ?, ?, ?, ?)
                    """,
                arguments: [id, threadRootId, clientMsgId ?? id, createdAt, replyCount, pending, failed]
            )
        }
    }

    private func message(_ db: AppDatabase, _ id: String) throws -> Message? {
        try db.reader.read { dbc in try Message.fetchOne(dbc, key: id) }
    }

    private static func messageJSON(
        id: String, clientMsgId: String? = nil, threadRootId: String? = nil, replyCount: Int = 0
    ) -> String {
        let root = threadRootId.map { "\"\($0)\"" } ?? "null"
        return """
            {"id":"\(id)","channelId":"c1","userId":"u1","threadRootId":\(root),
             "clientMsgId":"\(clientMsgId ?? id)","body":"hi",
             "createdAt":"2026-08-24T00:00:00.000Z","replyCount":\(replyCount)}
            """
    }

    private static func threadJSON(rootReplyCount: Int, replies: [String], hasMore: Bool) -> String {
        """
        {"root":\(messageJSON(id: "m-root", replyCount: rootReplyCount)),
         "messages":[\(replies.joined(separator: ","))],"hasMore":\(hasMore)}
        """
    }

    nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private func iso(minutesAgo: Double) -> String {
        Self.isoFormatter.string(from: Date().addingTimeInterval(-minutesAgo * 60))
    }

    // MARK: Paging the thread to its tail

    /// The bug itself: with >100 replies the reply the client is waiting on is
    /// on page 2, and the fetch never asked for page 2.
    func testThreadFetchPagesUntilTheServerRunsOut() async throws {
        let firstPage = (1...100).map { Self.messageJSON(id: String(format: "r%03d", $0), threadRootId: "m-root") }
        server = try StubHTTPServer { _, target in
            if target.hasPrefix("/v1/messages/m-root/thread") {
                return target.contains("after=r100")
                    ? .json(Self.threadJSON(
                        rootReplyCount: 101,
                        replies: [Self.messageJSON(id: "r101", clientMsgId: "cm-late", threadRootId: "m-root")],
                        hasMore: false))
                    : .json(Self.threadJSON(rootReplyCount: 101, replies: firstPage, hasMore: true))
            }
            return .json("{\"ok\":true}")
        }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m-root", replyCount: 101)
        // The optimistic reply whose ack went missing, fresh enough that the
        // stale sweep can't be what clears it.
        try insertMessage(
            db, id: "local-1", clientMsgId: "cm-late", threadRootId: "m-root",
            createdAt: iso(minutesAgo: 0), pending: true
        )

        await engine.openThread(rootId: "m-root")

        XCTAssertTrue(
            server.requests.contains { $0.contains("after=r100") },
            "the second page was never requested: \(server.requests)"
        )
        XCTAssertNotNil(try message(db, "r101"), "the tail reply never landed")
        XCTAssertNil(try message(db, "local-1"), "the optimistic twin should have been reconciled away")
        let pending = try await db.reader.read { dbc in
            try Int.fetchOne(dbc, sql: "SELECT count(*) FROM message WHERE pending = 1")
        }
        XCTAssertEqual(pending, 0, "spinner still up")
    }

    // MARK: The stale-pending sweep

    /// A reply the server genuinely never got: the sweep has to end the
    /// spinner and hand the user Retry instead.
    func testStalePendingReplyBecomesFailedOnThreadOpen() async throws {
        server = try StubHTTPServer { _, target in
            target.hasPrefix("/v1/messages/m-root/thread")
                ? .json(Self.threadJSON(rootReplyCount: 1, replies: [], hasMore: false))
                : .json("{\"ok\":true}")
        }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m-root", replyCount: 1)
        try insertMessage(
            db, id: "local-1", clientMsgId: "cm-lost", threadRootId: "m-root",
            createdAt: iso(minutesAgo: 10), pending: true
        )

        await engine.openThread(rootId: "m-root")

        let row = try XCTUnwrap(try message(db, "local-1"))
        XCTAssertFalse(row.pending, "still spinning")
        XCTAssertTrue(row.failed, "no Retry affordance")
        // The optimistic bump this reply made is given back: the root counts
        // confirmed replies only.
        XCTAssertEqual(try message(db, "m-root")?.replyCount, 0)
    }

    /// …but a send that is merely *in flight* is not a failure. The threshold
    /// is what keeps the sweep from eating live sends.
    func testAFreshPendingReplySurvivesTheSweep() async throws {
        server = try StubHTTPServer { _, target in
            target.hasPrefix("/v1/messages/m-root/thread")
                ? .json(Self.threadJSON(rootReplyCount: 1, replies: [], hasMore: false))
                : .json("{\"ok\":true}")
        }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m-root", replyCount: 1)
        try insertMessage(
            db, id: "local-1", clientMsgId: "cm-inflight", threadRootId: "m-root",
            createdAt: iso(minutesAgo: 0), pending: true
        )

        await engine.openThread(rootId: "m-root")

        let row = try XCTUnwrap(try message(db, "local-1"))
        XCTAssertTrue(row.pending)
        XCTAssertFalse(row.failed)
    }

    /// The sweep is allowed to be wrong — but not to duplicate. When the
    /// server twin of a swept row arrives, the local copy goes.
    func testAServerTwinReplacesARowTheSweepFlaggedFailed() async throws {
        server = try StubHTTPServer { _, target in
            target.hasPrefix("/v1/messages/m-root/thread")
                ? .json(Self.threadJSON(
                    rootReplyCount: 1,
                    replies: [Self.messageJSON(id: "r001", clientMsgId: "cm-lost", threadRootId: "m-root")],
                    hasMore: false))
                : .json("{\"ok\":true}")
        }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m-root", replyCount: 1)
        try insertMessage(
            db, id: "local-1", clientMsgId: "cm-lost", threadRootId: "m-root",
            createdAt: iso(minutesAgo: 10), pending: false, failed: true
        )

        await engine.openThread(rootId: "m-root")

        XCTAssertNil(try message(db, "local-1"), "the failed twin survived its own server row")
        XCTAssertNotNil(try message(db, "r001"))
    }

    // MARK: Key-less messages (#620)

    /// API and agent replies can arrive with an empty `clientMsgId`. A live one
    /// used to "reconcile" against every other key-less row in the channel —
    /// deleting the rest of the thread it was replying to.
    func testALiveKeylessReplyDeletesNoOtherKeylessMessage() async throws {
        server = try StubHTTPServer { _, _ in .json("{\"ok\":true}") }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m-root", clientMsgId: "", replyCount: 1)
        try insertMessage(db, id: "r001", clientMsgId: "", threadRootId: "m-root")

        let reply = Message(
            id: "r002", channelId: "c1", userId: "u2", threadRootId: "m-root", clientMsgId: "",
            body: "app reply", createdAt: "2026-08-24T00:00:02.000Z", editedAt: nil, deletedAt: nil,
            replyCount: 0, lastReplyAt: nil, pending: false
        )
        _ = await engine.applyServerMessage(reply)

        XCTAssertNotNil(try message(db, "m-root"), "a key-less reply deleted its own root")
        XCTAssertNotNil(try message(db, "r001"), "a key-less reply deleted its sibling")
        XCTAssertNotNil(try message(db, "r002"))
        XCTAssertEqual(try message(db, "m-root")?.replyCount, 2, "the new reply wasn't counted as new")
    }

    /// The same guard on the bulk path: a history page of key-less rows
    /// doesn't sweep a key-less failed row that is not its twin.
    func testAKeylessHistoryRowSweepsNoUnrelatedFailedRow() async throws {
        server = try StubHTTPServer { _, target in
            target.hasPrefix("/v1/messages/m-root/thread")
                ? .json(Self.threadJSON(
                    rootReplyCount: 1,
                    replies: [Self.messageJSON(id: "r001", clientMsgId: "", threadRootId: "m-root")],
                    hasMore: false))
                : .json("{\"ok\":true}")
        }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m-root", replyCount: 1)
        try insertMessage(
            db, id: "local-1", clientMsgId: "", threadRootId: "m-root",
            createdAt: iso(minutesAgo: 10), pending: false, failed: true
        )

        await engine.openThread(rootId: "m-root")

        XCTAssertNotNil(try message(db, "local-1"), "an unrelated failed row was swept by an empty key")
        XCTAssertNotNil(try message(db, "r001"))
    }

    // MARK: The failure UPDATE

    /// Acceptance 3: the WS echo confirms the send, then the POST times out.
    /// The message is delivered — it must not be flagged failed, and the
    /// root's reply count must not move.
    func testAnEchoConfirmedSendIsNotFlaggedWhenThePostFails() async throws {
        server = try StubHTTPServer { method, target in
            if method == "PATCH", target == "/v1/me" {
                return .json("{\"id\":\"u1\",\"email\":\"t@test.local\",\"displayName\":\"Tester\"}")
            }
            if method == "POST", target.hasSuffix("/messages") {
                // Slow enough for the echo below to land first, which is the
                // whole race being reproduced.
                return .init(status: 500, json: "{\"error\":\"timeout\"}", delay: 0.6)
            }
            return .json("{\"ok\":true}")
        }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m-root")
        // The one door into the engine that sets `currentUser` without a
        // keychain write or a notification prompt.
        try await engine.updateProfile(displayName: "Tester", timezone: nil)

        let send = Task { await engine.sendMessage(channelId: "c1", body: "hi", threadRootId: "m-root") }

        // Wait for the optimistic insert, then play the WS echo: it deletes the
        // optimistic twin and saves the server row (exactly what
        // `applyServerMessage` does), leaving a *confirmed* row under the same
        // clientMsgId for the losing POST to find.
        var clientMsgId: String?
        for _ in 0..<200 where clientMsgId == nil {
            clientMsgId = try await db.reader.read { dbc in
                try String.fetchOne(dbc, sql: "SELECT clientMsgId FROM message WHERE pending = 1")
            }
            if clientMsgId == nil { try await Task.sleep(nanoseconds: 5_000_000) }
        }
        let cmid = try XCTUnwrap(clientMsgId, "the optimistic row was never inserted")
        XCTAssertEqual(try message(db, "m-root")?.replyCount, 1, "the optimistic bump")
        try await db.writer.write { dbc in
            try dbc.execute(sql: "DELETE FROM message WHERE clientMsgId = ? AND pending = 1", arguments: [cmid])
            try dbc.execute(
                sql: """
                    INSERT INTO message
                        (id, channelId, userId, threadRootId, clientMsgId, body, createdAt,
                         replyCount, pending, failed)
                    VALUES ('srv-1', 'c1', 'u1', 'm-root', ?, 'hi', '2026-08-24T00:00:01.000Z', 0, 0, 0)
                    """,
                arguments: [cmid]
            )
        }
        _ = await send.value

        let confirmed = try XCTUnwrap(try message(db, "srv-1"))
        XCTAssertFalse(confirmed.failed, "a delivered message was labelled 'Failed to send'")
        XCTAssertFalse(confirmed.pending)
        XCTAssertEqual(try message(db, "m-root")?.replyCount, 1, "the rollup lost a confirmed reply")
    }

    /// The other half of the guard: a send that really does fail still gets
    /// flagged, and still gives its rollup bump back.
    func testAFailedSendIsStillFlaggedAndUnbumps() async throws {
        server = try StubHTTPServer { method, target in
            if method == "PATCH", target == "/v1/me" {
                return .json("{\"id\":\"u1\",\"email\":\"t@test.local\",\"displayName\":\"Tester\"}")
            }
            if method == "POST", target.hasSuffix("/messages") {
                return .init(status: 500, json: "{\"error\":\"nope\"}")
            }
            return .json("{\"ok\":true}")
        }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m-root")
        try await engine.updateProfile(displayName: "Tester", timezone: nil)

        await engine.sendMessage(channelId: "c1", body: "hi", threadRootId: "m-root")

        let replies = try await db.reader.read { dbc in
            try Message.filter(Column("threadRootId") == "m-root").fetchAll(dbc)
        }
        let row = try XCTUnwrap(replies.first)
        XCTAssertTrue(row.failed)
        XCTAssertFalse(row.pending)
        XCTAssertEqual(try message(db, "m-root")?.replyCount, 0)
    }

    // MARK: Permanent-delete cache convergence

    func testPermanentRootDeleteRemovesTheCompleteCachedThread() async throws {
        let (engine, db) = try makeEngine(URL(string: "http://127.0.0.1:1")!)
        try insertChannel(db)
        try insertMessage(db, id: "m-root", replyCount: 2)
        try insertMessage(db, id: "r1", threadRootId: "m-root")
        try insertMessage(db, id: "r2", threadRootId: "m-root")

        let root = try XCTUnwrap(try message(db, "m-root"))
        let removed = await engine.purgeMessage(root)
        XCTAssertTrue(removed)

        let survivors = try await db.reader.read { dbc in try Message.fetchAll(dbc) }
        XCTAssertTrue(survivors.isEmpty)
    }

    func testPermanentReplyDeleteRepairsTheRollupExactlyOnce() async throws {
        let (engine, db) = try makeEngine(URL(string: "http://127.0.0.1:1")!)
        try insertChannel(db)
        try insertMessage(db, id: "m-root", replyCount: 2)
        try insertMessage(
            db, id: "r1", threadRootId: "m-root",
            createdAt: "2026-08-24T01:00:00.000Z"
        )
        try insertMessage(
            db, id: "r2", threadRootId: "m-root",
            createdAt: "2026-08-24T02:00:00.000Z"
        )

        let last = try XCTUnwrap(try message(db, "r2"))
        let firstRemoval = await engine.purgeMessage(last)
        let duplicateRemoval = await engine.purgeMessage(last) // API response + websocket echo
        XCTAssertTrue(firstRemoval)
        XCTAssertFalse(duplicateRemoval)

        let root = try XCTUnwrap(try message(db, "m-root"))
        XCTAssertEqual(root.replyCount, 1)
        XCTAssertEqual(root.lastReplyAt, "2026-08-24T01:00:00.000Z")
        XCTAssertNil(try message(db, "r2"))
    }

    // MARK: The overlap probe

    /// `backfillChannel` marks its overlap with the newest *top-level* row —
    /// the same probe `catchUpRead` reads, which is the reachable end of it.
    /// A newer thread reply standing in for it ended the reconnect gap-fill
    /// early (#328 item 4).
    func testTheNewestCachedProbeIgnoresThreadReplies() async throws {
        server = try StubHTTPServer { _, _ in .json("{\"ok\":true}") }
        let (engine, db) = try makeEngine(server.url)
        try insertChannel(db)
        try insertMessage(db, id: "m050")
        try insertMessage(db, id: "m900", threadRootId: "m050")

        await engine.catchUpRead(channelId: "c1")

        let channel = try await db.reader.read { dbc in try Channel.fetchOne(dbc, key: "c1") }
        XCTAssertEqual(channel?.lastReadMsgId, "m050", "a thread reply was used as the top-level mark")
    }
}

/// A loopback HTTP server the size of what these tests ask of it: one request
/// per connection, a routing closure, and a request log to assert on.
///
/// POSIX sockets rather than `NWListener`, for the reason `SocketWatchdogTests`
/// gives: a Network.framework listener wants entitlements a test bundle
/// doesn't have.
private final class StubHTTPServer: @unchecked Sendable {
    struct Response {
        var status: Int = 200
        var json: String
        var delay: TimeInterval = 0

        static func json(_ body: String) -> Response { Response(json: body) }
    }

    private let listenFD: Int32
    private let lock = NSLock()
    private var log: [String] = []
    private var stopped = false

    let url: URL

    /// Every request target seen, as `"<method> <path>?<query>"`.
    var requests: [String] {
        lock.lock()
        defer { lock.unlock() }
        return log
    }

    init(route: @escaping @Sendable (_ method: String, _ target: String) -> Response) throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw XCTSkip("no socket") }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0 // any free port
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bound == 0, listen(fd, 8) == 0 else {
            close(fd)
            throw XCTSkip("could not listen on loopback")
        }
        var boundAddr = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        withUnsafeMutablePointer(to: &boundAddr) {
            _ = $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) }
        }
        listenFD = fd
        url = URL(string: "http://127.0.0.1:\(UInt16(bigEndian: boundAddr.sin_port))")!

        DispatchQueue.global().async { [self] in acceptLoop(route) }
    }

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
        close(listenFD)
    }

    // MARK: Internals

    private func acceptLoop(_ route: @escaping @Sendable (String, String) -> Response) {
        while true {
            let fd = accept(listenFD, nil, nil)
            guard fd >= 0 else { return } // listener closed
            lock.lock()
            let done = stopped
            lock.unlock()
            if done {
                close(fd)
                return
            }
            DispatchQueue.global().async { [self] in
                serve(fd, route)
                close(fd)
            }
        }
    }

    private func serve(_ fd: Int32, _ route: (String, String) -> Response) {
        guard let (method, target, headers, leftover) = readHead(fd) else { return }
        // Drain the body, so the client is never blocked on a full buffer while
        // we answer.
        let length = headers["content-length"].flatMap(Int.init) ?? 0
        var read = leftover
        var scratch = [UInt8](repeating: 0, count: 4096)
        while read < length {
            let n = Darwin.read(fd, &scratch, min(scratch.count, length - read))
            guard n > 0 else { break }
            read += n
        }
        lock.lock()
        log.append("\(method) \(target)")
        lock.unlock()

        let response = route(method, target)
        if response.delay > 0 { Thread.sleep(forTimeInterval: response.delay) }
        let body = Array(response.json.utf8)
        let head = """
            HTTP/1.1 \(response.status) \(response.status == 200 ? "OK" : "Error")\r
            Content-Type: application/json\r
            Content-Length: \(body.count)\r
            Connection: close\r
            \r\n
            """
        _ = head.withCString { write(fd, $0, strlen($0)) }
        _ = body.withUnsafeBufferPointer { write(fd, $0.baseAddress, $0.count) }
    }

    /// Reads up to the end of the headers. Returns the request line, the
    /// lower-cased headers, and how many body bytes came along with them.
    private func readHead(_ fd: Int32) -> (String, String, [String: String], Int)? {
        var buffer = [UInt8]()
        var scratch = [UInt8](repeating: 0, count: 4096)
        var separator: Int? = nil
        while separator == nil {
            let n = Darwin.read(fd, &scratch, scratch.count)
            guard n > 0 else { return nil }
            buffer.append(contentsOf: scratch[0..<n])
            separator = find(crlfcrlf: buffer)
        }
        guard let end = separator else { return nil }
        let head = String(decoding: buffer[0..<end], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let request = lines.first?.split(separator: " ") ?? []
        guard request.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            headers[parts[0].lowercased()] = parts[1].trimmingCharacters(in: .whitespaces)
        }
        return (String(request[0]), String(request[1]), headers, buffer.count - (end + 4))
    }

    private func find(crlfcrlf bytes: [UInt8]) -> Int? {
        guard bytes.count >= 4 else { return nil }
        for i in 0...(bytes.count - 4) where bytes[i] == 13 && bytes[i + 1] == 10
            && bytes[i + 2] == 13 && bytes[i + 3] == 10 {
            return i
        }
        return nil
    }
}
