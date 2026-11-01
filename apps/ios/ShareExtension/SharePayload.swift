import Foundation
import UniformTypeIdentifiers

/// What the share sheet handed us. Every case but `.text` is a path on disk,
/// never bytes: a share extension is killed near ~120 MB, and both `ImagePrep`
/// and the presigned upload work from a file, so neither a 12 MP HEIC nor a
/// 3 GB 4K video is ever held whole (issues #214 and #219).
enum SharePayload {
    /// An image, already through `ImagePrep`.
    case image(URL)
    /// A movie. `ImagePrep` is deliberately not applied — it decodes images.
    case video(URL)
    /// Anything else with bytes: PDF, .docx, .zip, …
    case file(URL)
    case text(String)

    /// The thing to upload, if there is one.
    var fileURL: URL? {
        switch self {
        case .image(let url), .video(let url), .file(let url): url
        case .text: nil
        }
    }

    var initialCaption: String {
        switch self {
        case .image, .video, .file: ""
        case .text(let text): text
        }
    }
}

/// Main-actor bound because `NSExtensionItem`/`NSItemProvider` are not
/// `Sendable`; the loads inside are still async, they just start from here.
@MainActor
enum ShareItemLoader {
    /// Picks the first thing we can post out of the sheet's attachments. The
    /// order is the whole design, because a host app offers the same item
    /// several ways:
    ///
    /// 1. A web link — sharing a page offers a URL *and* a preview image, and
    ///    the URL is what the user meant.
    /// 2. A movie — a video shared from Photos offers the movie *and* a preview
    ///    frame. Image-first would post the still, which looks like it worked
    ///    (issue #219).
    /// 3. A document — PDF, .docx, .zip. Never an image or a movie; see
    ///    `documentType`.
    /// 4. An image, through `ImagePrep`.
    /// 5. Text, which becomes the message body.
    /// 6. Any remaining file, so an unfamiliar type posts as an attachment
    ///    rather than "Nothing here that Flow can post."
    static func load(from items: [NSExtensionItem]) async -> SharePayload? {
        let providers = items.flatMap { $0.attachments ?? [] }

        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
            if let url = try? await loadURL(provider), !url.isFileURL {
                return .text(url.absoluteString)
            }
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            if let file = try? await loadFile(provider, type: .movie) {
                return .video(file)
            }
        }
        for provider in providers {
            guard let type = documentType(provider) else { continue }
            if let file = try? await loadFile(provider, type: type) {
                return .file(file)
            }
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            if let file = try? await loadFile(provider, type: .image) {
                return .image(ImagePrep.prepareForUpload(file) ?? file)
            }
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
            if let text = try? await loadText(provider), !text.isEmpty {
                return .text(text)
            }
        }
        for provider in providers where provider.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
            if let file = try? await loadFile(provider, type: .data) {
                return .file(file)
            }
        }
        return nil
    }

    /// The provider's first registered type that is a *document*: it carries
    /// bytes, and it is not an image or a movie (they have their own passes,
    /// with their own handling), nor text or a URL (they post as the message
    /// body). Undeclared `dyn.…` types are skipped here and picked up by the
    /// catch-all pass instead.
    ///
    /// The specific type matters — `loadFileRepresentation` for `public.data`
    /// can hand back a copy named after the *generic* type, and the MIME type
    /// is guessed from that extension.
    private static func documentType(_ provider: NSItemProvider) -> UTType? {
        for identifier in provider.registeredTypeIdentifiers {
            guard let type = UTType(identifier), type.isDeclared else { continue }
            if type.conforms(to: .image) || type.conforms(to: .movie) { continue }
            if type.conforms(to: .text) || type.conforms(to: .url) { continue }
            if type.conforms(to: .data) { return type }
        }
        return nil
    }

    private static func loadURL(_ provider: NSItemProvider) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.url.identifier) { item, error in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(throwing: error ?? ShareError.unreadableItem)
                }
            }
        }
    }

    private static func loadText(_ provider: NSItemProvider) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, error in
                if let text = item as? String {
                    continuation.resume(returning: text)
                } else {
                    continuation.resume(throwing: error ?? ShareError.unreadableItem)
                }
            }
        }
    }

    /// `loadFileRepresentation`'s URL is only valid inside the callback, so the
    /// bytes are copied to our own temp directory before it returns.
    private static func loadFile(_ provider: NSItemProvider, type: UTType) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                guard let url else {
                    continuation.resume(throwing: error ?? ShareError.unreadableItem)
                    return
                }
                do {
                    let dir = FileManager.default.temporaryDirectory
                        .appendingPathComponent("share-\(UUID().uuidString)", isDirectory: true)
                    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                    let copy = dir.appendingPathComponent(url.lastPathComponent)
                    try FileManager.default.copyItem(at: url, to: copy)
                    continuation.resume(returning: copy)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}

enum ShareError: LocalizedError {
    case unreadableItem
    case notSignedIn
    case nothingToShare
    /// Both sizes carried so the message can name them — "too large" on its own
    /// leaves the user with nothing to do about it (issue #219).
    case fileTooLarge(size: Int64, limit: Int64)

    var errorDescription: String? {
        switch self {
        case .unreadableItem: "Couldn't read the shared item."
        case .notSignedIn: "Open Flow and sign in first, then share again."
        case .nothingToShare: "Nothing here that Flow can post."
        case .fileTooLarge(let size, let limit):
            "That file is \(ShareFormat.binaryBytes(size)). "
                + "Flow accepts files up to \(ShareFormat.binaryBytes(limit))."
        }
    }
}

enum ShareFormat {
    /// Decimal units, the way the Files app and Finder show a size — the
    /// attachment row should say what the Files app said.
    static func bytes(_ count: Int64) -> String {
        count.formatted(.byteCount(style: .file))
    }

    /// Binary units, for the two numbers in the too-large message. The server's
    /// limit is `FLOW_MAX_FILE_MB × 1024²`, so decimal units render it as
    /// "524.3 MB" — a limit nobody set and nobody can act on.
    static func binaryBytes(_ count: Int64) -> String {
        count.formatted(.byteCount(style: .memory))
    }

    /// `1:04`, `1:02:03`. Nil duration means the asset would not load, and the
    /// caller shows no duration rather than a wrong one.
    static func duration(_ seconds: Double) -> String {
        let total = Int(seconds.rounded())
        let (hours, minutes, secs) = (total / 3600, (total % 3600) / 60, total % 60)
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, secs)
            : String(format: "%d:%02d", minutes, secs)
    }
}
