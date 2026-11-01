import AppKit
import SwiftUI

// MARK: - New DM

struct NewDMSheet: View {
    let workspaceId: String
    let members: [MemberInfo]
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @Environment(\.dismiss) private var dismiss
    @State private var selected: Set<String> = []
    @State private var busy = false
    @State private var error: String?

    private var others: [MemberInfo] {
        members.filter { $0.userId != app.currentUser?.id }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New Direct Message").flowFont(.headline)
            Text("Pick one person for a DM, several for a group DM (max 8).")
                .flowFont(.caption)
                .foregroundStyle(.secondary)
            List(others) { member in
                Toggle(isOn: Binding(
                    get: { selected.contains(member.userId) },
                    set: { on in
                        if on { selected.insert(member.userId) } else { selected.remove(member.userId) }
                    }
                )) {
                    HStack(spacing: 6) {
                        if app.can(.presence) {
                            Circle()
                                .fill(app.isOnline(member.userId, in: workspaceId) ? .green : Color.gray.opacity(0.5))
                                .frame(width: 8, height: 8)
                        }
                        Text(member.displayName + (member.isAgent == true ? " 🤖" : ""))
                    }
                }
                .accessibilityIdentifier("newdm.member.\(member.displayName)")
            }
            .frame(minHeight: 180, maxHeight: 260)
            if let error {
                Text(error).flowFont(.callout).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Start") {
                    busy = true
                    error = nil
                    Task {
                        defer { busy = false }
                        do {
                            let ch = try await app.engine.createDm(
                                workspaceId: workspaceId, userIds: Array(selected)
                            )
                            dismiss()
                            win.selectChannel(ch.id)
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || selected.isEmpty || selected.count > 8)
                .accessibilityIdentifier("newdm.start")
            }
        }
        .padding(20)
        .frame(width: 380)
    }
}

// MARK: - Invite to channel

struct AddMemberSheet: View {
    let channel: Channel
    let members: [MemberInfo]
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @Environment(\.dismiss) private var dismiss
    @State private var busy: Set<String> = []
    @State private var added: Set<String> = []
    @State private var error: String?

    private var candidates: [MemberInfo] {
        members.filter { $0.userId != app.currentUser?.id }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Invite to #\(channel.name ?? "")").flowFont(.headline)
            List(candidates) { member in
                HStack(spacing: 6) {
                    Text(member.displayName + (member.isAgent == true ? " 🤖" : ""))
                    Spacer()
                    if added.contains(member.userId) {
                        Image(systemName: "checkmark")
                            .foregroundStyle(.green)
                    } else {
                        Button("Add") {
                            busy.insert(member.userId)
                            Task {
                                defer { busy.remove(member.userId) }
                                do {
                                    try await app.engine.addMember(
                                        channelId: channel.id, userId: member.userId
                                    )
                                    added.insert(member.userId)
                                } catch {
                                    self.error = error.localizedDescription
                                }
                            }
                        }
                        .disabled(busy.contains(member.userId))
                        .accessibilityIdentifier("invitechannel.add.\(member.displayName)")
                    }
                }
            }
            .frame(minHeight: 160, maxHeight: 240)
            if let error {
                Text(error).flowFont(.callout).foregroundStyle(.red)
            }
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(width: 360)
    }
}

// MARK: - Member profile

struct MemberProfileSheet: View {
    let userId: String
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @Environment(\.dismiss) private var dismiss
    @State private var user: User?
    @State private var sponsor: User?
    @State private var error: String?
    // "Invite to workspace" (#358): nil targets = not asked yet / still loading.
    @State private var showInvite = false
    @State private var inviteTargets: [Workspace]?
    /// The server had nothing to offer in the first place — distinct from "the
    /// list is empty now", which is what inviting into the last candidate
    /// leaves behind.
    @State private var noneToOffer = false
    @State private var invitingWorkspaceId: String?
    @State private var inviteDone: String?
    @State private var inviteError: String?

    var body: some View {
        VStack(spacing: 12) {
            avatar
            Text(user.map(\.displayNameWithBadge) ?? "…")
                .flowFont(.title3, weight: .bold)
                .accessibilityIdentifier("profile.name")
            // #434: under the name, same as the Directory card it opens from.
            if let title = user?.title, !title.trimmingCharacters(in: .whitespaces).isEmpty {
                Text(title)
                    .flowFont(.callout)
                    .foregroundStyle(MC.inkSoft)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .accessibilityIdentifier("profile.title")
            }
            if user?.isAgent == true {
                Text("AI agent").flowFont(.caption).foregroundStyle(.secondary)
            }
            if let sponsor {
                sponsorRow(sponsor)
            }
            if let email = user?.email {
                Text(email)
                    .flowFont(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if let tz = user?.timezone {
                Text(localTimeLine(tz))
                    .flowFont(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("profile.localTime")
            }
            // #220: the server stores http(s) URLs only, but re-check the scheme
            // before making it tappable — never hand an arbitrary string to
            // `Link`. A value that fails shows as plain text.
            if let site = user?.website, !site.isEmpty {
                Group {
                    if let url = safeWebsiteURL(site) {
                        Link(site.replacingOccurrences(
                            of: "^https?://", with: "", options: [.regularExpression, .caseInsensitive]
                        ), destination: url)
                    } else {
                        Text(site).foregroundStyle(.secondary)
                    }
                }
                .flowFont(.callout)
                .lineLimit(1)
                .truncationMode(.middle)
                .accessibilityIdentifier("profile.website")
            }
            // Plain text, not markdown: SwiftUI Text renders it literally, and
            // the default wrapping keeps the author's line breaks.
            if let bio = user?.bio, !bio.isEmpty {
                Text(bio)
                    .flowFont(.callout)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("profile.bio")
            }
            if let error {
                Text(error).flowFont(.callout).foregroundStyle(.red)
            }
            // "Invite to workspace" (#358) — never on your own card, since you
            // are already in every workspace of yours.
            if let user, userId != app.currentUser?.id {
                inviteSection(user)
            }
            HStack {
                if userId != app.currentUser?.id, let wsId = win.selectedWorkspaceId {
                    Button("Message") {
                        Task {
                            do {
                                let ch = try await app.engine.createDm(
                                    workspaceId: wsId, userIds: [userId]
                                )
                                dismiss()
                                win.selectChannel(ch.id)
                            } catch {
                                self.error = error.localizedDescription
                            }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("profile.message")
                }
                Button("Close") { dismiss() }
            }
        }
        .padding(24)
        .frame(width: 300)
        .task {
            do {
                let u = try await app.engine.fetchUser(userId)
                user = u
                // Agents carry a human sponsor; show who it is (ui_nits).
                if u.isAgent == true, let sid = u.sponsorId {
                    sponsor = try? await app.engine.fetchUser(sid)
                }
            } catch { self.error = error.localizedDescription }
        }
    }

    /// Bring this member into another of my workspaces (#358). One control for
    /// two flows, because from the inviter's side it is one intention: an agent
    /// joins on the spot (its sponsor vouches for it, #357), a person is asked
    /// and joins when they accept (#359).
    ///
    /// The list comes from the server's answer to "which of my workspaces is
    /// this member NOT in", so it never offers a move that can only fail.
    @ViewBuilder
    private func inviteSection(_ user: User) -> some View {
        if !showInvite {
            Button("Invite to workspace…") {
                showInvite = true
                Task { await loadInviteTargets() }
            }
            .accessibilityIdentifier("profile.inviteToWorkspace")
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("INVITE TO WORKSPACE")
                    .flowFont(.caption, weight: .semibold)
                    .foregroundStyle(.secondary)
                if inviteTargets == nil, inviteError == nil {
                    Text("Loading…").flowFont(.callout).foregroundStyle(.tertiary)
                } else if noneToOffer {
                    Text("\(user.displayName) is already in all your workspaces.")
                        .flowFont(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("profile.inviteEmpty")
                }
                ForEach(inviteTargets ?? []) { ws in
                    Button {
                        Task { await invite(user, to: ws) }
                    } label: {
                        HStack(spacing: 6) {
                            Text(ws.name).flowFont(.callout)
                            Spacer()
                            if invitingWorkspaceId == ws.id { ProgressView().controlSize(.small) }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.bordered)
                    .disabled(invitingWorkspaceId != nil)
                    .accessibilityIdentifier("profile.inviteTarget.\(ws.slug)")
                }
                if let inviteDone {
                    Text(inviteDone)
                        .flowFont(.callout)
                        .foregroundStyle(.tint)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("profile.inviteDone")
                }
                if let inviteError {
                    Text(inviteError)
                        .flowFont(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("profile.inviteError")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func loadInviteTargets() async {
        do {
            let targets = try await app.engine.workspaceInviteTargets(userId: userId)
            inviteTargets = targets
            noneToOffer = targets.isEmpty
        } catch {
            inviteError = error.localizedDescription
        }
    }

    private func invite(_ user: User, to ws: Workspace) async {
        invitingWorkspaceId = ws.id
        inviteError = nil
        defer { invitingWorkspaceId = nil }
        do {
            if user.isAgent == true {
                _ = try await app.engine.inviteAgentToWorkspace(agentUserId: userId, workspaceId: ws.id)
                inviteDone = "\(user.displayName) joined \(ws.name)"
                await app.engine.refreshWorkspaces()
            } else {
                let created = try await app.engine.inviteUserToWorkspace(userId: userId, workspaceId: ws.id)
                inviteDone = created
                    ? "Invitation sent to \(user.displayName)"
                    : "\(user.displayName) has already been invited to \(ws.name)"
            }
            // However it went, that workspace is no longer a candidate.
            inviteTargets = (inviteTargets ?? []).filter { $0.id != ws.id }
        } catch {
            inviteError = Self.inviteErrorText(error, user: user, workspace: ws)
        }
    }

    /// The server's codes, said in names — the popup should read as a sentence,
    /// not as an error code.
    static func inviteErrorText(_ error: Error, user: User, workspace ws: Workspace) -> String {
        guard let api = error as? APIError else { return error.localizedDescription }
        switch api.code {
        case "already_member":
            return "\(user.displayName) is already in \(ws.name)."
        case "username_taken":
            return "A member of \(ws.name) already uses \(user.displayName)'s handle — rename one of them first."
        case "invite_exists":
            return "\(user.displayName) has already been invited to \(ws.name)."
        default:
            return api.message
        }
    }

    /// "Sponsored by <name>" chip for an agent's card.
    private func sponsorRow(_ s: User) -> some View {
        HStack(spacing: 6) {
            Text("Sponsored by").flowFont(.caption).foregroundStyle(.secondary)
            Group {
                if let path = s.avatarUrl, path.hasPrefix("/v1/avatars/") {
                    AuthImage(path: path) { Circle().fill(.secondary.opacity(0.2)) }
                        .scaledToFill()
                        .frame(width: 18, height: 18)
                        .clipShape(Circle())
                } else {
                    Circle().fill(.secondary.opacity(0.2)).frame(width: 18, height: 18)
                }
            }
            Text(s.displayName).flowFont(.callout, weight: .semibold)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(Capsule().fill(.secondary.opacity(0.12)))
        .accessibilityIdentifier("profile.sponsor")
    }

    private var avatar: some View {
        Group {
            if let path = user?.avatarUrl, path.hasPrefix("/v1/avatars/") {
                AuthImage(path: path) {
                    Circle().fill(.secondary.opacity(0.2))
                }
                .scaledToFill()
                .frame(width: 72, height: 72)
                .clipShape(Circle())
            } else {
                Circle()
                    .fill(.secondary.opacity(0.2))
                    .frame(width: 72, height: 72)
                    .overlay(
                        Text(initials)
                            .flowFont(.title2, weight: .bold)
                            .foregroundStyle(.secondary)
                    )
            }
        }
    }

    private var initials: String {
        let parts = (user?.displayName ?? "?").split(separator: " ")
        let chars = parts.prefix(2).compactMap(\.first)
        return chars.isEmpty ? "?" : String(chars).uppercased()
    }

    private func localTimeLine(_ tzName: String) -> String {
        guard let tz = TimeZone(identifier: tzName) else { return tzName }
        let fmt = DateFormatter()
        fmt.timeZone = tz
        fmt.timeStyle = .short
        fmt.dateStyle = .none
        return "\(fmt.string(from: Date())) local time (\(tzName))"
    }
}

// MARK: - My profile (edit)

struct MyProfileSheet: View {
    @EnvironmentObject private var app: AppState
    @EnvironmentObject private var win: WindowState
    @Environment(\.dismiss) private var dismiss
    @State private var displayName = ""
    @State private var title = ""
    @State private var timezone = TimeZone.current.identifier
    @State private var website = ""
    @State private var bio = ""
    @State private var busy = false
    @State private var error: String?
    @State private var avatarBusy = false
    @State private var confirmDelete = false
    @State private var deleteBusy = false
    /// #464: notification prefs, edited live rather than on Save — each flip is
    /// its own PATCH, so Cancel doesn't undo one.
    @State private var prefs = NotificationPrefs()
    @State private var prefsError: String?
    /// #490: live-saved like the prefs above, and for the same reason — a
    /// privacy switch that needed a second click on Save to take effect would
    /// be the wrong shape.
    @State private var privacyMode = false
    @State private var privacyError: String?

    private static let timezones = TimeZone.knownTimeZoneIdentifiers.sorted()

    /// #220: the server accepts an absolute http(s) URL only, so say so here
    /// instead of letting Save come back with a validation error.
    private var trimmedWebsite: String { website.trimmingCharacters(in: .whitespaces) }
    private var websiteInvalid: Bool {
        !trimmedWebsite.isEmpty && safeWebsiteURL(trimmedWebsite) == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("My Profile").flowFont(.headline)

            // The Notifications section (#464) made the sheet taller than a
            // laptop screen, so the fields scroll and the buttons stay put.
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(spacing: 12) {
                        avatar
                        Button(avatarBusy ? "Uploading…" : "Change Avatar…") { pickAvatar() }
                            .disabled(avatarBusy)
                            .accessibilityIdentifier("profile.changeAvatar")
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Display name").flowFont(.caption).foregroundStyle(.secondary)
                        TextField("Display name", text: $displayName)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("profile.displayName")
                    }

                    // #434: directly under the name — the two together are what a
                    // Directory card shows, so they are edited together.
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Title").flowFont(.caption).foregroundStyle(.secondary)
                        TextField("Title (optional)", text: $title)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("profile.title")
                            .onChange(of: title) { _, new in
                                if new.count > profileTitleMax { title = String(new.prefix(profileTitleMax)) }
                            }
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Timezone").flowFont(.caption).foregroundStyle(.secondary)
                        Picker("Timezone", selection: $timezone) {
                            ForEach(Self.timezones, id: \.self) { tz in
                                Text(tz).tag(tz)
                            }
                        }
                        .labelsHidden()
                        .accessibilityIdentifier("profile.timezone")
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("Website").flowFont(.caption).foregroundStyle(.secondary)
                        TextField("https://example.com", text: $website)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("profile.website")
                            .onChange(of: website) { _, new in
                                if new.count > profileWebsiteMax { website = String(new.prefix(profileWebsiteMax)) }
                            }
                        if websiteInvalid {
                            Text("Must be a full link starting with http:// or https://")
                                .flowFont(.caption)
                                .foregroundStyle(.red)
                                .accessibilityIdentifier("profile.websiteError")
                        }
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text("Bio").flowFont(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Text("\(bio.count)/\(profileBioMax)")
                                .flowFont(.caption)
                                .foregroundStyle(bio.count >= profileBioMax ? .red : .secondary)
                                .accessibilityIdentifier("profile.bioCount")
                        }
                        TextEditor(text: $bio)
                            .frame(height: 64)
                            .font(.body)
                            .border(.secondary.opacity(0.3))
                            .accessibilityIdentifier("profile.bio")
                            .onChange(of: bio) { _, new in
                                if new.count > profileBioMax { bio = String(new.prefix(profileBioMax)) }
                            }
                    }

                    privacy
                    notifications
                }
                .padding(.trailing, 2) // clear of the scroller
            }
            .frame(maxHeight: 520)

            if let error {
                Text(error).flowFont(.callout).foregroundStyle(.red)
            }

            HStack {
                // App Store 5.1.1(v) parity: the same self-service account
                // deletion the iOS app offers.
                Button(deleteBusy ? "Deleting…" : "Delete Account…", role: .destructive) {
                    confirmDelete = true
                }
                .disabled(deleteBusy || busy)
                .accessibilityIdentifier("profile.deleteAccount")
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    busy = true
                    error = nil
                    Task {
                        defer { busy = false }
                        do {
                            try await app.engine.updateProfile(
                                displayName: displayName.trimmingCharacters(in: .whitespaces),
                                timezone: timezone,
                                website: trimmedWebsite,
                                bio: bio,
                                // "" clears it
                                title: title.trimmingCharacters(in: .whitespaces)
                            )
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    busy || displayName.trimmingCharacters(in: .whitespaces).isEmpty || websiteInvalid
                )
                .accessibilityIdentifier("profile.save")
            }
        }
        .padding(20)
        .frame(width: 380)
        .alert("Delete your account?", isPresented: $confirmDelete) {
            Button("Delete Account", role: .destructive) { deleteAccount() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Permanently delete \(app.currentUser?.email ?? "this account") on \(app.serverOrigin), removing it from every workspace on this server. It cannot be undone.")
        }
        .onAppear {
            displayName = app.currentUser?.displayName ?? ""
            title = app.currentUser?.title ?? ""
            timezone = app.currentUser?.timezone ?? TimeZone.current.identifier
            website = app.currentUser?.website ?? ""
            bio = app.currentUser?.bio ?? ""
            prefs = app.currentUser?.prefs ?? NotificationPrefs()
            privacyMode = app.currentUser?.privacyMode == true
        }
        // A flip made on web or the phone arrives as a new `currentUser`; adopt
        // it. Our own writes land here too, carrying the value we already show.
        .onChange(of: app.currentUser?.notificationPrefs) { _, new in
            if let new { prefs = new }
        }
        .onChange(of: app.currentUser?.privacyMode) { _, new in
            privacyMode = new == true
        }
    }

    // MARK: - Privacy (#490)

    /// The web client's Privacy section (#489), on the Mac. The address sits
    /// directly above the switch that hides it, because "here is the email we
    /// show people, here is how to stop showing it" is one thought — and this
    /// sheet is the only place the app ever shows you your own address.
    private var privacy: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Privacy").flowFont(.caption).foregroundStyle(.secondary)
            HStack(spacing: 6) {
                Text("Email").flowFont(.caption).foregroundStyle(.secondary)
                Text(app.currentUser?.email ?? "")
                    .flowFont(.callout)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("profile.email")
            }
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Privacy mode").flowFont(.callout)
                    Text("Hide your email and remove you from the Directory.")
                        .flowFont(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Toggle("", isOn: Binding(get: { privacyMode }, set: { setPrivacyMode($0) }))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                    .accessibilityIdentifier("profile.privacyMode")
            }
            if let privacyError {
                Text(privacyError)
                    .flowFont(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("profile.privacyMode.error")
            }
        }
    }

    /// Optimistic then reconciled, exactly like `setPref`: the switch moves
    /// now and reverts if the write fails. The engine refreshes the roster on
    /// success, so the Directory adds or drops this member in the same beat.
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

    // MARK: - Notifications (#464)

    /// The same prefs section web has carried since phase 10 and iOS gained in
    /// #251, on the Mac app's only settings surface. Web's `persistentBanners`
    /// is deliberately absent: on macOS whether an alert stays on screen is the
    /// user's System Settings > Notifications choice between "Banners" and
    /// "Alerts", which no app can override — a toggle here would be a lie. The
    /// value still round-trips untouched through `NotificationPrefs`.
    private var notifications: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Notifications").flowFont(.caption).foregroundStyle(.secondary)
            Text("Off means no banner — everything still lands in the 🔔 list.")
                .flowFont(.caption)
                .foregroundStyle(.secondary)
            prefToggle("Direct messages", "any message in a DM", \.dm, "dm")
            prefToggle("Mentions of me", "@you", \.mention, "mention")
            prefToggle("Group mentions", "@here, @channel", \.groupMention, "groupMention")
            prefToggle("Thread replies", "threads you started or joined", \.threadReply, "threadReply")
            prefToggle("Reactions", "someone reacts to your message", \.reaction, "reaction")
            prefToggle("Channel invites", "someone adds you to a channel", \.channelInvite, "channelInvite")
            prefToggle("Play a sound", "with every banner", \.sound, "sound")
            if let prefsError {
                Text(prefsError)
                    .flowFont(.caption)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("profile.notifications.error")
            }
        }
    }

    private func prefToggle(
        _ label: String,
        _ hint: String,
        _ key: WritableKeyPath<NotificationPrefs, Bool?>,
        _ id: String
    ) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label).flowFont(.callout)
                Text(hint).flowFont(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: Binding(
                get: { prefs[keyPath: key] != false }, // absent = on
                set: { on in setPref(key, on) }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)
            .accessibilityIdentifier("profile.notifications.\(id)")
        }
    }

    /// Optimistic, then reconciled: the switch moves now and reverts if the
    /// write fails. Only the key that moved goes on the wire — the server
    /// shallow-merges, so this can't clobber a pref set on another client.
    private func setPref(_ key: WritableKeyPath<NotificationPrefs, Bool?>, _ on: Bool) {
        let previous = prefs
        prefs[keyPath: key] = on
        prefsError = nil
        var delta = NotificationPrefs()
        delta[keyPath: key] = on
        Task {
            do {
                try await app.engine.setNotificationPrefs(delta)
            } catch {
                prefs = previous
                prefsError = error.localizedDescription
            }
        }
    }

    /// On success the engine's teardown flips the app to signed-out, which
    /// tears down this sheet with the rest of the signed-in UI.
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

    private var avatar: some View {
        Group {
            if let path = app.currentUser?.avatarUrl, path.hasPrefix("/v1/avatars/") {
                AuthImage(path: path) {
                    Circle().fill(.secondary.opacity(0.2))
                }
                .scaledToFill()
                .frame(width: 56, height: 56)
                .clipShape(Circle())
                .id(path) // refresh when the key changes
            } else {
                Circle()
                    .fill(.secondary.opacity(0.2))
                    .frame(width: 56, height: 56)
                    .overlay(Image(systemName: "person").foregroundStyle(.secondary))
            }
        }
    }

    private func pickAvatar() {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.png, .jpeg, .gif, .webP]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            avatarBusy = true
            Task { @MainActor in
                defer { avatarBusy = false }
                do {
                    try await app.engine.uploadAvatar(fileURL: url)
                } catch {
                    self.error = error.localizedDescription
                }
            }
        }
    }
}
