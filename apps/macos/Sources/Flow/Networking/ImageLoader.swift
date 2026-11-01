import AppKit
import Foundation
import SwiftUI

/// Fetches authenticated images (thumbnails, avatars) through the APIClient
/// and memory-caches the decoded NSImage. File/thumb/avatar URLs are immutable
/// per id, so the cache never needs invalidation.
actor ImageLoader {
    static let shared = ImageLoader()

    /// Where bytes come from: the connection's API client.
    private var fetch: (@Sendable (String) async throws -> Data)?
    private var generation = 0
    // NSCache is internally thread-safe; `nonisolated(unsafe)` lets
    // `cachedImage(path:)` peek it synchronously from outside the actor.
    nonisolated(unsafe) private let cache = NSCache<NSString, NSImage>()
    private var inflight: [String: Task<NSImage?, Never>] = [:]

    func clear() {
        generation += 1
        for task in inflight.values { task.cancel() }
        inflight.removeAll()
        cache.removeAllObjects()
    }

    func configure(api: APIClient) {
        fetch = { try await api.getData($0) }
        cache.countLimit = 500
    }

    /// Synchronous cache peek — lets a view seed its initial state with an
    /// already-cached image instead of always painting a placeholder for the
    /// first frame while the (actor-hopping) async load catches up.
    nonisolated func cachedImage(path: String) -> NSImage? {
        cache.object(forKey: path as NSString)
    }

    func image(path: String) async -> NSImage? {
        if let hit = cache.object(forKey: path as NSString) { return hit }
        if let task = inflight[path] { return await task.value }
        guard let fetch else { return nil }
        let task = Task<NSImage?, Never> {
            guard let data = try? await fetch(path), let img = NSImage(data: data) else { return nil }
            return img
        }
        let startedGeneration = generation
        inflight[path] = task
        let img = await task.value
        guard startedGeneration == generation else { return nil }
        inflight[path] = nil
        if let img { cache.setObject(img, forKey: path as NSString) }
        return img
    }
}

/// NSImageView-backed authenticated image that plays animated GIFs — SwiftUI's
/// Image renders only the first frame of a multi-frame NSImage; NSImageView
/// with `animates` plays them. Same load/cache path as AuthImage.
struct AnimatedAuthImage: NSViewRepresentable {
    @EnvironmentObject private var app: AppState
    let path: String

    func makeNSView(context: Context) -> NSImageView {
        let view = NSImageView()
        view.animates = true
        view.imageScaling = .scaleProportionallyUpOrDown
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        return view
    }

    func updateNSView(_ view: NSImageView, context: Context) {
        guard context.coordinator.loadedPath != path else { return }
        context.coordinator.loadedPath = path
        Task { @MainActor in
            view.image = await app.images.image(path: path)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var loadedPath: String? }
}

/// SwiftUI wrapper: renders an authenticated remote image with a placeholder.
struct AuthImage<Placeholder: View>: View {
    @EnvironmentObject private var app: AppState
    let path: String
    /// Load through this connection's loader instead of the one on screen — a
    /// rail avatar belongs to its own connection, which has its own credential
    /// and origin. Nil means the connection this window is showing.
    let loader: ImageLoader?
    @ViewBuilder let placeholder: () -> Placeholder
    @State private var image: NSImage?

    init(path: String, loader: ImageLoader? = nil, @ViewBuilder placeholder: @escaping () -> Placeholder) {
        self.path = path
        self.loader = loader
        self.placeholder = placeholder
        _image = State(initialValue: nil)
    }

    private var images: ImageLoader { loader ?? app.images }

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable()
            } else {
                placeholder()
            }
        }
        .task(id: path) {
            let images = images
            if let cached = images.cachedImage(path: path) {
                image = cached
                return
            }
            image = await images.image(path: path)
        }
    }
}
