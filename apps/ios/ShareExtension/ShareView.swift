import AVFoundation
import SwiftUI
import UniformTypeIdentifiers

/// The sheet itself. Deliberately one screen: pick a channel, add a caption,
/// Send. The extension dies when the sheet dismisses, so there is nowhere to
/// navigate to and back from.
struct ShareView: View {
    @ObservedObject var store: ShareStore
    let onFinish: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                switch store.phase {
                case .loading:
                    ProgressView("Loading channels…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .ready, .sending:
                    form
                case .sent:
                    status(icon: "checkmark.circle.fill", tint: .green, text: "Sent to Flow")
                case .failed(let message):
                    status(icon: "exclamationmark.triangle.fill", tint: .orange, text: message)
                }
            }
            .navigationTitle("Share to Flow")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if store.phase == .sending {
                        ProgressView()
                    } else {
                        Button("Send") {
                            Task {
                                await store.send()
                                if store.phase == .sent { onFinish() }
                            }
                        }
                        .disabled(!store.canSend)
                        .accessibilityIdentifier("share.send")
                    }
                }
            }
        }
    }

    private var form: some View {
        Form {
            if let fileURL = store.payload?.fileURL {
                Section {
                    AttachmentRow(url: fileURL, isVideo: isVideo, size: store.fileSize)
                } header: {
                    Text("Attachment")
                } footer: {
                    if let refusal = store.attachmentRefusal {
                        Text(refusal).foregroundStyle(.orange).accessibilityIdentifier("share.attachment.refused")
                    }
                }
            }
            Picker("Server", selection: Binding(get: { store.connectionId ?? "" }, set: { id in Task { await store.selectConnection(id) } })) {
                ForEach(store.connections, id: \.connectionId) { connection in
                    Text(store.pickerLabel(for: connection)).tag(connection.connectionId)
                }
            }
            Text(store.serverLabel).font(.caption).foregroundStyle(.secondary)
            if store.workspaces.count > 1 {
                Section("Workspace") {
                    Picker("Workspace", selection: workspaceBinding) {
                        ForEach(store.workspaces) { workspace in
                            Text(workspace.name).tag(workspace.id)
                        }
                    }
                    .pickerStyle(.menu)
                }
            }
            Section("Channel") {
                // A navigation-link picker, not an inline list: a real account
                // has dozens of channels, and inline pushes the caption and
                // everything under it off the bottom of the sheet.
                Picker("Channel", selection: $store.channelId) {
                    ForEach(store.visibleChannels) { channel in
                        Text(store.title(for: channel)).tag(Optional(channel.id))
                    }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("share.channel")
            }
            Section(captionSectionTitle) {
                TextField(captionPlaceholder, text: $store.caption, axis: .vertical)
                    .lineLimit(1...4)
                    .accessibilityIdentifier("share.caption")
            }
        }
        .disabled(store.phase == .sending)
    }

    private var isVideo: Bool {
        if case .video = store.payload { return true }
        return false
    }

    /// A shared link or a piece of text arrives *as* the message body, so
    /// calling that field "Caption" would be a lie. Anything with a file
    /// attached takes a caption.
    private var captionSectionTitle: String {
        store.payload?.fileURL != nil ? "Caption" : "Message"
    }

    private var captionPlaceholder: String {
        store.payload?.fileURL != nil ? "Add a caption (optional)" : "Message"
    }

    private var workspaceBinding: Binding<String> {
        Binding(
            get: { store.workspaceId ?? "" },
            set: { id in Task { await store.selectWorkspace(id) } }
        )
    }

    private func status(icon: String, tint: Color, text: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.largeTitle).foregroundStyle(tint)
            Text(text)
                .multilineTextAlignment(.center)
                .accessibilityIdentifier("share.status")
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// What is about to be posted: a video's first frame and its running time, or a
/// type icon for a document — plus the name and size in both cases, because
/// "Sent to Flow" is otherwise the first confirmation that the *right* file
/// went (issue #219).
///
/// The identifiers are on the leaves. An identifier on the row would hide the
/// labels from XCUITest, which is how the test asserts a video was recognised
/// as a video rather than as its preview frame.
private struct AttachmentRow: View {
    let url: URL
    let isVideo: Bool
    let size: Int64

    @State private var thumbnail: UIImage?
    @State private var duration: String?

    var body: some View {
        HStack(spacing: 12) {
            preview
            VStack(alignment: .leading, spacing: 2) {
                Text(url.lastPathComponent)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier("share.attachment.name")
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("share.attachment.meta")
            }
        }
        .task {
            guard isVideo else { return }
            let (image, seconds) = await VideoPreview.load(url)
            thumbnail = image
            duration = seconds.map(ShareFormat.duration)
        }
    }

    @ViewBuilder
    private var preview: some View {
        if let thumbnail {
            Image(uiImage: thumbnail)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: 44, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "play.circle.fill")
                        .foregroundStyle(.white)
                        .shadow(radius: 2)
                        .padding(2)
                }
        } else {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(.tint)
                .frame(width: 44, height: 44)
        }
    }

    /// "4.2 MB" for a document, "1:07 · 84.1 MB" for a video once the asset has
    /// been read. A video whose duration will not load still shows its size.
    private var subtitle: String {
        let bytes = ShareFormat.bytes(size)
        guard let duration else { return bytes }
        return "\(duration) · \(bytes)"
    }

    private var icon: String {
        guard let type = UTType(filenameExtension: url.pathExtension) else { return "doc" }
        if type.conforms(to: .movie) { return "film" }
        if type.conforms(to: .image) { return "photo" }
        if type.conforms(to: .pdf) { return "doc.richtext" }
        if type.conforms(to: .archive) { return "doc.zipper" }
        if type.conforms(to: .spreadsheet) { return "tablecells" }
        if type.conforms(to: .presentation) { return "rectangle.on.rectangle" }
        if type.conforms(to: .text) { return "doc.text" }
        return "doc"
    }
}

enum VideoPreview {
    /// One frame at 44 pt and the asset's duration. `maximumSize` is the point:
    /// a 4K frame decoded at full size is ~35 MB in a process with a ~120 MB
    /// ceiling, and the generator downsamples while decoding.
    static func load(_ url: URL) async -> (UIImage?, Double?) {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 132, height: 132)

        let seconds = try? await asset.load(.duration).seconds
        let frame = try? await generator.image(at: CMTime(seconds: 0, preferredTimescale: 600)).image
        return (frame.map(UIImage.init(cgImage:)), seconds?.isFinite == true ? seconds : nil)
    }
}
