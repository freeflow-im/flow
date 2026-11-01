import Foundation
import GRDB

/// Owns the local SQLite cache. All writes go through the SyncEngine;
/// SwiftUI observes via ValueObservation (see DBObserved).
struct AppDatabase: Sendable {
    let writer: any DatabaseWriter
    var reader: any DatabaseReader { writer }

    /// The cache belongs to one connection+identity (#540). The migrated
    /// default connection resolves to `Flow<Profile.suffix>` — the directory an
    /// existing install already has — so an upgrade re-downloads nothing.
    static func directory(for scope: StorageScope) throws -> URL {
        let fm = FileManager.default
        let support = try fm.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        )
        return support.appendingPathComponent(scope.databaseDirectoryName, isDirectory: true)
    }

    /// Delete a scope's cache outright. Used when a connection is removed or
    /// its identity changes: cached rows whose ownership we can no longer
    /// establish are discarded and refetched, never handed to another user.
    static func destroy(scope: StorageScope) {
        guard let dir = try? directory(for: scope) else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    static func open(scope: StorageScope = .legacy) throws -> AppDatabase {
        let fm = FileManager.default
        let dir = try directory(for: scope)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let pool = try DatabasePool(path: dir.appendingPathComponent("flow.sqlite").path)
        let db = AppDatabase(writer: pool)
        try db.migrate()
        return db
    }

    /// In-memory database (used by tests).
    static func inMemory() throws -> AppDatabase {
        let queue = try DatabaseQueue()
        let db = AppDatabase(writer: queue)
        try db.migrate()
        return db
    }

    private func migrate() throws {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1") { db in
            try db.create(table: "user") { t in
                t.column("id", .text).primaryKey()
                t.column("email", .text).notNull().defaults(to: "")
                t.column("displayName", .text).notNull().defaults(to: "")
                t.column("avatarUrl", .text)
                t.column("createdAt", .text)
            }
            try db.create(table: "workspace") { t in
                t.column("id", .text).primaryKey()
                t.column("slug", .text).notNull()
                t.column("name", .text).notNull()
                t.column("createdBy", .text).notNull()
                t.column("createdAt", .text).notNull()
                t.column("role", .text)
            }
            try db.create(table: "channel") { t in
                t.column("id", .text).primaryKey()
                t.column("workspaceId", .text).notNull().indexed()
                t.column("name", .text).notNull()
                t.column("topic", .text)
                t.column("isPrivate", .boolean).notNull().defaults(to: false)
                t.column("createdBy", .text).notNull()
                t.column("createdAt", .text).notNull()
                t.column("archivedAt", .text)
                t.column("isMember", .boolean).notNull().defaults(to: false)
                t.column("lastReadMsgId", .text)
                t.column("unreadCount", .integer).notNull().defaults(to: 0)
            }
            try db.create(table: "message") { t in
                t.column("id", .text).primaryKey()
                t.column("channelId", .text).notNull()
                t.column("userId", .text).notNull()
                t.column("threadRootId", .text)
                t.column("clientMsgId", .text).notNull()
                t.column("body", .text).notNull()
                t.column("createdAt", .text).notNull()
                t.column("editedAt", .text)
                t.column("deletedAt", .text)
                t.column("replyCount", .integer).notNull().defaults(to: 0)
                t.column("lastReplyAt", .text)
                t.column("pending", .boolean).notNull().defaults(to: false)
            }
            try db.create(index: "msg_channel_id", on: "message", columns: ["channelId", "id"])
            try db.create(index: "msg_thread_id", on: "message", columns: ["threadRootId", "id"])
            try db.create(index: "msg_client_id", on: "message", columns: ["channelId", "clientMsgId"])
            try db.create(table: "member") { t in
                t.column("workspaceId", .text).notNull()
                t.column("userId", .text).notNull()
                t.column("role", .text).notNull().defaults(to: "member")
                t.primaryKey(["workspaceId", "userId"])
            }
        }
        // Phase 2: DMs (kind/memberIds, nullable name), reactions/files on
        // messages (JSON columns), notify levels, user timezone. channel and
        // message are pure caches — cheapest correct migration is a rebuild;
        // history refetches on demand.
        migrator.registerMigration("v2") { db in
            try db.drop(table: "message")
            try db.drop(table: "channel")
            try db.create(table: "channel") { t in
                t.column("id", .text).primaryKey()
                t.column("workspaceId", .text).notNull().indexed()
                t.column("name", .text) // nil for DMs
                t.column("kind", .text).notNull().defaults(to: "standard")
                t.column("topic", .text)
                t.column("isPrivate", .boolean).notNull().defaults(to: false)
                t.column("createdBy", .text).notNull()
                t.column("createdAt", .text).notNull()
                t.column("archivedAt", .text)
                t.column("isMember", .boolean).notNull().defaults(to: false)
                t.column("lastReadMsgId", .text)
                t.column("unreadCount", .integer).notNull().defaults(to: 0)
                t.column("notifyLevel", .integer).notNull().defaults(to: 1)
                t.column("memberIds", .text) // JSON array, DMs only
            }
            try db.create(table: "message") { t in
                t.column("id", .text).primaryKey()
                t.column("channelId", .text).notNull()
                t.column("userId", .text).notNull()
                t.column("threadRootId", .text)
                t.column("clientMsgId", .text).notNull()
                t.column("body", .text).notNull()
                t.column("createdAt", .text).notNull()
                t.column("editedAt", .text)
                t.column("deletedAt", .text)
                t.column("replyCount", .integer).notNull().defaults(to: 0)
                t.column("lastReplyAt", .text)
                t.column("reactions", .text).notNull().defaults(to: "[]") // JSON
                t.column("files", .text).notNull().defaults(to: "[]") // JSON
                t.column("pending", .boolean).notNull().defaults(to: false)
            }
            try db.create(index: "msg_channel_id2", on: "message", columns: ["channelId", "id"])
            try db.create(index: "msg_thread_id2", on: "message", columns: ["threadRootId", "id"])
            try db.create(index: "msg_client_id2", on: "message", columns: ["channelId", "clientMsgId"])
            try db.alter(table: "user") { t in
                t.add(column: "timezone", .text)
            }
        }
        // Phase 2.5 (design 3a): user status emoji + label.
        migrator.registerMigration("v3") { db in
            try db.alter(table: "user") { t in
                t.add(column: "statusEmoji", .text)
                t.add(column: "statusText", .text)
            }
        }
        // Phase 3.5 (ruling 3): workspace-wide sidebar color preset id.
        migrator.registerMigration("v4") { db in
            try db.alter(table: "workspace") { t in
                t.add(column: "sidebarColor", .text)
            }
        }
        // Phase 5 (item 7): reply-avatar stack — first 4 distinct reply authors.
        migrator.registerMigration("v5") { db in
            try db.alter(table: "message") { t in
                t.add(column: "replyParticipantUserIds", .text).notNull().defaults(to: "[]") // JSON
            }
        }
        // First-class AI agents (AGENTS_DESIGN.md): 🤖 badge flag.
        migrator.registerMigration("v6") { db in
            try db.alter(table: "user") { t in
                t.add(column: "isAgent", .boolean)
            }
        }
        // Phase 11: link preview cards, cached with the message (JSON, like
        // reactions/files). Rows written before this default to "[]", so a
        // cached message just has no cards until it's refetched.
        migrator.registerMigration("v7") { db in
            try db.alter(table: "message") { t in
                t.add(column: "unfurls", .text).notNull().defaults(to: "[]") // JSON
            }
        }
        // Agents carry a human sponsor; the profile card shows it (ui_nits).
        migrator.registerMigration("v8") { db in
            try db.alter(table: "user") { t in
                t.add(column: "sponsorId", .text)
            }
        }
        // Optimistic-send failure: a send whose POST errored keeps its row and
        // flags it `failed` (Retry affordance) instead of spinning forever.
        migrator.registerMigration("v9") { db in
            try db.alter(table: "message") { t in
                t.add(column: "failed", .boolean).notNull().defaults(to: false)
            }
        }
        // Join/leave system messages (ui_nits): a non-null system_kind tags a row
        // as a channel event line ("Alice joined the channel"). NULL = a normal
        // message. Cached rows predate it and read as NULL until refetched.
        migrator.registerMigration("v10") { db in
            try db.alter(table: "message") { t in
                t.add(column: "systemKind", .text)
            }
        }
        // Sidebar badge semantics (operator ruling 2026-07-26): a number on a
        // channel row counts unread *notifications*, not unread messages —
        // messages only embolden the row. Cached rows read 0 until refetched.
        migrator.registerMigration("v11") { db in
            try db.alter(table: "channel") { t in
                t.add(column: "unreadNotifications", .integer).notNull().defaults(to: 0)
            }
        }
        // Sub-channels (#118): a channel can hang off another and renders
        // indented under it. Nullable, and no FK — the parent row may not be
        // cached (you can be a member of a child but not its parent), which the
        // sidebar handles by drawing such a channel at top level.
        migrator.registerMigration("v12") { db in
            try db.alter(table: "channel") { t in
                t.add(column: "parentId", .text)
            }
        }
        // Channel-wide message pins. These columns are server-authoritative
        // cache fields; opening a channel backfills every pinned message.
        migrator.registerMigration("v13") { db in
            try db.alter(table: "message") { t in
                t.add(column: "pinnedAt", .text)
                t.add(column: "pinnedBy", .text)
            }
        }
        // Expanded user profiles (#220): personal website link + free-text bio.
        migrator.registerMigration("v14") { db in
            try db.alter(table: "user") { t in
                t.add(column: "website", .text)
                t.add(column: "bio", .text)
            }
        }
        // Which threads are waiting on you (#270). JSON array, same shape as
        // memberIds; nil on a cached row until the next channel list arrives,
        // which just means no dot yet — never a wrong one.
        migrator.registerMigration("v15") { db in
            try db.alter(table: "channel") { t in
                t.add(column: "unreadThreadRootIds", .text)
            }
        }
        // Workspace avatar (#336): the optional image mark, nil until one is set.
        migrator.registerMigration("v16") { db in
            try db.alter(table: "workspace") { t in
                t.add(column: "avatarUrl", .text)
            }
        }
        // Sole-human check behind Delete workspace (#340): the roster has to be
        // able to tell an app bot from a person, not just an agent from one.
        migrator.registerMigration("v17") { db in
            try db.alter(table: "user") { t in
                t.add(column: "isBot", .boolean)
            }
        }
        // Per-workspace unread total (#345), the sidebar rail badge. Nil on a
        // cached row until the next workspace list arrives — no badge yet,
        // never a wrong one.
        migrator.registerMigration("v18") { db in
            try db.alter(table: "workspace") { t in
                t.add(column: "unreadCount", .integer)
            }
        }
        // Channel emoji (#396): the persistent glyph after a channel's name.
        // Cached like any other server column — unlike the activity spinner it
        // shares that sidebar slot with, which is deliberately never persisted.
        // Nil on a cached row until the next channel list or event arrives.
        migrator.registerMigration("v19") { db in
            try db.alter(table: "channel") { t in
                t.add(column: "emoji", .text)
            }
        }
        // Scheduled messages (#424): the badge has to survive a relaunch, so
        // the flag belongs on the cached row like any other server column.
        // Defaults false — every message already cached was typed by a person.
        migrator.registerMigration("v20") { db in
            try db.alter(table: "message") { t in
                t.add(column: "scheduled", .boolean).notNull().defaults(to: false)
            }
        }

        // One-line profile title (#434), shown under the name on a Directory
        // card. Nil on every cached row until the next roster or profile
        // fetch, which just means no line yet — never a wrong one.
        migrator.registerMigration("v21") { db in
            try db.alter(table: "user") { t in
                t.add(column: "title", .text)
            }
        }

        // Auto-open target (#327 parity, #441): where a channel's oldest unread
        // lives when it is a thread reply. JSON, same shape as
        // unreadThreadRootIds; nil on a cached row until the next channel list
        // arrives, which just means no jump yet — never a wrong one.
        migrator.registerMigration("v22") { db in
            try db.alter(table: "channel") { t in
                t.add(column: "oldestUnreadThreadReply", .text)
            }
        }

        // Per-user notification prefs (#251), so the settings screens can render
        // the toggles from the cached user instead of blocking on a fetch. JSON,
        // nil on every cached row until the next `/v1/me` — which reads as "all
        // defaults", the same thing an absent key means server-side.
        migrator.registerMigration("v23") { db in
            try db.alter(table: "user") { t in
                t.add(column: "notificationPrefs", .text)
            }
        }

        // Privacy mode (#489/#490): carried on the roster, so the Directory can
        // leave a member out without a fetch per card. Nullable — a row cached
        // before this column existed reads as nil, which means "not hiding",
        // the same thing the field's absence means on an older server.
        migrator.registerMigration("v24") { db in
            try db.alter(table: "user") { t in
                t.add(column: "privacyMode", .boolean)
            }
        }

        // Provider conversation activity for the Slack provider, removed
        // 2026-11-01 (FreeFlow suite §2.0). The column stays: a shipped
        // migration is never edited, and nothing reads it any more.
        migrator.registerMigration("v25") { db in
            try db.alter(table: "channel") { t in
                t.add(column: "lastActivityAt", .text)
            }
        }

        try migrator.migrate(writer)
    }

    /// Removes all cached rows (used at sign-out).
    static func wipe(_ db: Database) throws {
        try db.execute(sql: "DELETE FROM message")
        try db.execute(sql: "DELETE FROM channel")
        try db.execute(sql: "DELETE FROM member")
        try db.execute(sql: "DELETE FROM workspace")
        try db.execute(sql: "DELETE FROM user")
    }
}
