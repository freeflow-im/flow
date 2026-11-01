import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// My own avatar path: `currentUser.avatarUrl` first so a fresh upload shows
/// immediately, falling back to the published map used for everyone else.
extension AppState {
    var myAvatarPath: String? {
        guard let me = currentUser else { return nil }
        return me.avatarUrl ?? avatarPaths[me.id]
    }
}

/// The profile/status sheet (design 3a's profile footer): who you are, your
/// status, "My Profile…" and Sign Out. Opened from the drawer's status footer
/// (`SidebarDrawer`), the same place the web/macOS sidebars keep it.
struct AccountSheet: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    /// QA: `FLOW_DEBUG_OPEN_PROFILE=1` pushes My Profile as the sheet appears,
    /// so a headless run can screenshot the form without tap automation. Same
    /// family as the other FLOW_DEBUG_* hooks in `Platform/`.
    @State private var pushProfile = false
    /// The same hook for the notification prefs (#251): `FLOW_DEBUG_OPEN_NOTIFICATIONS=1`.
    @State private var pushNotifications = false

    private var statusEmoji: String { app.currentUser?.statusEmoji ?? "" }
    private var statusText: String { app.currentUser?.statusText ?? "" }

    var body: some View {
        NavigationStack {
            List {
                Section { header }

                Section("Set your status") {
                    ForEach(Array(MC.statusOptions.enumerated()), id: \.offset) { index, option in
                        Button {
                            setStatus(option.emoji, option.text, option.suppresses)
                        } label: {
                            HStack(spacing: 10) {
                                Text(option.emoji).font(.system(size: 18)).frame(width: 24)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(option.text)
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundStyle(MC.ink)
                                    if option.suppresses {
                                        Text("Pauses notifications")
                                            .font(.caption2)
                                            .foregroundStyle(MC.faint)
                                    }
                                }
                                Spacer(minLength: 0)
                                if option.emoji == statusEmoji, option.text == statusText {
                                    Image(systemName: "checkmark")
                                        .font(.footnote.bold())
                                        .foregroundStyle(MC.accentSoft)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("status.option.\(index + 1)")
                    }
                    if !statusEmoji.isEmpty || !statusText.isEmpty {
                        Button {
                            setStatus("", "", false)
                        } label: {
                            Text("Clear status")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(MC.faint)
                        }
                        .disabled(busy)
                        .accessibilityIdentifier("status.clear")
                    }
                }
                .hiddenUnless(.status, in: app.capabilities)

                Section {
                    NavigationLink {
                        MyProfileView()
                    } label: {
                        Label("My Profile…", systemImage: "person.crop.circle")
                    }
                    .accessibilityIdentifier("account.profile")

                    NavigationLink {
                        NotificationSettingsView()
                    } label: {
                        Label("Notifications", systemImage: "bell")
                    }
                    .accessibilityIdentifier("account.notifications")

                    Button(role: .destructive) {
                        dismiss()
                        Task { await app.engine.logout() }
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    .accessibilityIdentifier("account.signOut")
                }
            }
            .navigationDestination(isPresented: $pushProfile) { MyProfileView() }
            .navigationDestination(isPresented: $pushNotifications) { NotificationSettingsView() }
            .onAppear {
                if ProcessInfo.processInfo.environment["FLOW_DEBUG_OPEN_PROFILE"] == "1" {
                    pushProfile = true
                }
                if ProcessInfo.processInfo.environment["FLOW_DEBUG_OPEN_NOTIFICATIONS"] == "1" {
                    pushNotifications = true
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("You")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .accessibilityIdentifier("account.sheet")
    }

    private var header: some View {
        HStack(spacing: 12) {
            AvatarChip(
                userId: app.currentUser?.id ?? "",
                name: app.currentUser?.displayName ?? "?",
                avatarPath: app.myAvatarPath,
                size: 52,
                radius: 14
            )
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(app.currentUser?.displayName ?? "You")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(MC.ink)
                        .lineLimit(1)
                    Circle()
                        .fill(app.connection == .connected ? MC.online : .orange)
                        .frame(width: 7, height: 7)
                        .accessibilityLabel(app.connection.label)
                }
                Text(app.currentUser?.email ?? "")
                    .font(.system(size: 12))
                    .foregroundStyle(MC.muted)
                    .lineLimit(1)
                Text(statusText.isEmpty ? "No status set" : "\(statusEmoji) \(statusText)")
                    .font(.system(size: 13))
                    .foregroundStyle(statusText.isEmpty ? MC.faint : MC.inkSoft)
                    .lineLimit(1)
                    .accessibilityIdentifier("account.statusLabel")
            }
        }
        .padding(.vertical, 4)
    }

    private func setStatus(_ emoji: String, _ text: String, _ suppresses: Bool) {
        busy = true
        Task {
            defer { busy = false }
            do {
                try await app.engine.setStatus(emoji: emoji, text: text, suppressAlerts: suppresses)
            } catch {
                app.showError(error.localizedDescription)
            }
        }
    }
}

// MARK: - My profile (view + edit)

/// Pushed from the account sheet: avatar, display name and timezone, saved
/// through the same PATCH /v1/me the other clients use.
struct MyProfileView: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var displayName = ""
    @State private var title = ""
    @State private var timezone = TimeZone.current.identifier
    @State private var website = ""
    @State private var bio = ""
    @State private var busy = false
    @State private var avatarBusy = false
    @State private var error: String?
    @State private var photoItem: PhotosPickerItem?
    @State private var confirmDelete = false
    @State private var deleteBusy = false
    /// #490: saved on the flip rather than on Save, like the notification
    /// prefs — a privacy switch that waited for a second tap to take effect
    /// would be the wrong shape.
    @State private var privacyMode = false
    @State private var privacyError: String?

    private static let timezones = TimeZone.knownTimeZoneIdentifiers.sorted()

    private var trimmedName: String { displayName.trimmingCharacters(in: .whitespaces) }

    /// #220: the server accepts an absolute http(s) URL only. Check before Save
    /// so the sheet explains the rule rather than surfacing a server error.
    private var trimmedWebsite: String { website.trimmingCharacters(in: .whitespaces) }
    private var websiteInvalid: Bool {
        !trimmedWebsite.isEmpty && safeWebsiteURL(trimmedWebsite) == nil
    }

    var body: some View {
        // Read on the main actor here: PhotosPicker's label closure is Sendable,
        // so touching @State from inside it is a concurrency violation (a
        // warning today, an error under the Swift 6 language mode).
        let uploading = avatarBusy
        Form {
            Section {
                HStack(spacing: 14) {
                    AvatarChip(
                        userId: app.currentUser?.id ?? "",
                        name: app.currentUser?.displayName ?? "?",
                        avatarPath: app.myAvatarPath,
                        size: 64,
                        radius: 18
                    )
                    // Re-render when the avatar key changes after an upload.
                    .id(app.currentUser?.avatarUrl ?? "")
                    PhotosPicker(selection: $photoItem, matching: .images) {
                        Text(uploading ? "Uploading…" : "Change Avatar…")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(MC.accent)
                    }
                    .disabled(avatarBusy)
                    .accessibilityIdentifier("profile.changeAvatar")
                }
                .padding(.vertical, 4)
            }

            Section("Display name") {
                TextField("Display name", text: $displayName)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("profile.displayName")
            }

            // #434: directly under the name — the two together are what a
            // Directory card shows, so they are edited together.
            Section("Title") {
                TextField("Title (optional)", text: $title)
                    .textInputAutocapitalization(.words)
                    .accessibilityIdentifier("profile.title")
                    .onChange(of: title) { _, new in
                        if new.count > profileTitleMax { title = String(new.prefix(profileTitleMax)) }
                    }
            }

            Section("Timezone") {
                Picker("Timezone", selection: $timezone) {
                    ForEach(Self.timezones, id: \.self) { tz in Text(tz).tag(tz) }
                }
                .pickerStyle(.navigationLink)
                .accessibilityIdentifier("profile.timezone")
            }

            Section {
                TextField("https://example.com", text: $website)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .accessibilityIdentifier("profile.website")
                    .onChange(of: website) { _, new in
                        if new.count > profileWebsiteMax { website = String(new.prefix(profileWebsiteMax)) }
                    }
            } header: {
                Text("Website")
            } footer: {
                if websiteInvalid {
                    Text("Must be a full link starting with http:// or https://")
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("profile.websiteError")
                }
            }

            Section {
                TextField("A sentence or two about you.", text: $bio, axis: .vertical)
                    .lineLimit(3...6)
                    .accessibilityIdentifier("profile.bio")
                    .onChange(of: bio) { _, new in
                        if new.count > profileBioMax { bio = String(new.prefix(profileBioMax)) }
                    }
            } header: {
                Text("Bio")
            } footer: {
                Text("\(bio.count)/\(profileBioMax)")
                    .foregroundStyle(bio.count >= profileBioMax ? .red : MC.inkSoft)
                    .accessibilityIdentifier("profile.bioCount")
            }

            // #490: the address sits directly above the switch that hides it,
            // because "here is the email we show people, here is how to stop
            // showing it" is one thought — the same shape web uses.
            Section {
                HStack {
                    Text("Email").foregroundStyle(MC.faint)
                    Spacer(minLength: 12)
                    Text(app.currentUser?.email ?? "")
                        .foregroundStyle(MC.inkSoft)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("profile.email")
                }
                Toggle(isOn: Binding(get: { privacyMode }, set: { setPrivacyMode($0) })) {
                    Text("Privacy mode").foregroundStyle(MC.ink)
                }
                .accessibilityIdentifier("profile.privacyMode")
            } header: {
                Text("Privacy")
            } footer: {
                if let privacyError {
                    Text(privacyError)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("profile.privacyMode.error")
                } else {
                    Text("Hide your email and remove you from the Directory.")
                }
            }

            // App Store 5.1.1(v): account deletion must be reachable in-app.
            Section {
                Button(role: .destructive) {
                    confirmDelete = true
                } label: {
                    Text(deleteBusy ? "Deleting Account…" : "Delete Account…")
                }
                .disabled(deleteBusy || busy)
                .accessibilityIdentifier("profile.deleteAccount")
            } footer: {
                Text("Permanently deletes your account, removes you from every workspace, and frees your email address for future use. Your past messages remain, attributed to your name.")
            }

            if let error {
                Section { Text(error).font(.callout).foregroundStyle(.red) }
            }
        }
        .alert("Delete your account?", isPresented: $confirmDelete) {
            Button("Delete Account", role: .destructive) { deleteAccount() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Permanently delete \(app.currentUser?.email ?? "this account") on \(app.serverOrigin), removing it from every workspace on this server. It cannot be undone.")
        }
        .navigationTitle("My Profile")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Save") { save() }
                    .disabled(busy || trimmedName.isEmpty || websiteInvalid)
                    .accessibilityIdentifier("profile.save")
            }
        }
        .onAppear {
            displayName = app.currentUser?.displayName ?? ""
            title = app.currentUser?.title ?? ""
            timezone = app.currentUser?.timezone ?? TimeZone.current.identifier
            website = app.currentUser?.website ?? ""
            bio = app.currentUser?.bio ?? ""
            privacyMode = app.currentUser?.privacyMode == true
        }
        // A flip made on the Mac or on web arrives as a new `currentUser`;
        // adopt it. Our own writes land here too, carrying what we already show.
        .onChange(of: app.currentUser?.privacyMode) { _, new in
            privacyMode = new == true
        }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            uploadAvatar(item)
        }
    }

    /// Optimistic, then reconciled: the switch moves now and reverts if the
    /// write fails. The engine refreshes the roster on success, so the
    /// Directory adds or drops this member in the same beat.
    private func setPrivacyMode(_ on: Bool) {
        let previous = privacyMode
        privacyMode = on
        privacyError = nil
        Task {
            do {
                try await app.engine.setPrivacyMode(on)
            } catch {
                privacyMode = previous
                privacyError = error.localizedDescription
            }
        }
    }

    /// On success the engine's teardown flips the app to signed-out, which
    /// dismisses this whole sheet — no local navigation needed.
    private func deleteAccount() {
        deleteBusy = true
        error = nil
        Task {
            defer { deleteBusy = false }
            do {
                try await app.engine.deleteAccount()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func save() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await app.engine.updateProfile(
                    displayName: trimmedName, timezone: timezone,
                    website: trimmedWebsite, bio: bio,
                    // "" clears it
                    title: title.trimmingCharacters(in: .whitespaces)
                )
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Photo-library pick → temp file → the engine's multipart avatar upload.
    /// Web-friendly formats keep their original bytes; anything else (HEIC)
    /// is re-encoded to JPEG, same rule the composer's photo path uses.
    private func uploadAvatar(_ item: PhotosPickerItem) {
        avatarBusy = true
        error = nil
        Task {
            defer {
                avatarBusy = false
                photoItem = nil
            }
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                error = "Couldn't load the selected photo"
                return
            }
            let type = item.supportedContentTypes.first
            let epochMs = Int(Date().timeIntervalSince1970 * 1000)
            let url: URL
            if let type, [UTType.png, .jpeg, .gif, .webP].contains(type) {
                let ext = type.preferredFilenameExtension ?? "png"
                url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("avatar-\(epochMs).\(ext)")
                try? data.write(to: url)
            } else if let image = UIImage(data: data),
                      let jpeg = image.jpegData(compressionQuality: 0.9) {
                url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("avatar-\(epochMs).jpg")
                try? jpeg.write(to: url)
            } else {
                error = "Unsupported image format"
                return
            }
            defer { try? FileManager.default.removeItem(at: url) }
            do {
                try await app.engine.uploadAvatar(fileURL: url)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
