import SwiftUI

/// Shared presentation for macOS and iOS. The window supplies the selection
/// callback, so choosing a server never retargets another window's AppState.
struct ServerConnectionsView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var manager: ConnectionManager
    @ObservedObject var current: AppState
    let select: (AppState, String?) -> Void
    @State private var address = ""

    init(current: AppState, initialAddress: String = "", select: @escaping (AppState, String?) -> Void) {
        self.current = current
        self.manager = current.connections
        self.select = select
        _address = State(initialValue: initialAddress)
    }
    @State private var destination: ServerAddress?
    @State private var discovery: ServerDiscovery?
    @State private var email = ""
    @State private var password = ""
    @State private var auth: AuthResponse?
    @State private var workspaces: [Workspace] = []
    @State private var selected: Set<String> = []
    @State private var busy = false
    @State private var error: String?
    @State private var revision = 0
    @State private var removal: String?
    @State private var signout: String?
    @State private var memberships: [String: [Workspace]] = [:]
    @State private var offline: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Workspaces and servers").font(.headline)
                    Spacer()
                    Button("Done") { dismiss() }.disabled(busy)
                }
                ForEach(manager.registry.connections, id: \.connectionId) { connection in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(connection.displayLabel).font(.headline)
                            // Aggregated from this connection's own live session
                            // — no server can total the others (#542).
                            let total = manager.unreadByConnection[connection.connectionId] ?? 0
                            if total > 0 {
                                Text("\(total)").font(.caption)
                                    .accessibilityLabel("\(total) unread on this server")
                            }
                        }
                        let session = manager.registry.session(connection.connectionId)
                        Text(actionLabel(connection.connectionId)).font(.caption).foregroundStyle(.secondary)
                        if session?.status != .authenticated { Text("Sign in required").font(.caption) }
                        else if offline.contains(connection.connectionId) { Text("Offline").font(.caption) }
                        ForEach(manager.registry.bindings.filter { $0.connectionId == connection.connectionId && $0.hidden != true }, id: \.workspaceId) { binding in
                            HStack {
                                Button(binding.name) {
                                    if let app = manager.appState(connection.connectionId) {
                                        select(app, binding.workspaceId); dismiss()
                                    }
                                }
                                // The running session's number when there is
                                // one, this sheet's own fetch otherwise.
                                let live = manager.unreadByWorkspace[connection.connectionId]?[binding.workspaceId]
                                if let count = live ?? memberships[connection.connectionId]?.first(where: { $0.id == binding.workspaceId })?.unreadCount, count > 0 {
                                    Text("\(count)").font(.caption).accessibilityLabel("\(count) unread notifications")
                                }
                                Spacer()
                                Button("Hide workspace") {
                                    var hidden = binding; hidden.hidden = true
                                    manager.setBinding(hidden); revision += 1
                                }.font(.caption)
                            }
                        }
                        HStack {
                            Button("Add workspace / Sign in") { address = connection.origin; discovery = nil; auth = nil }
                            Button("Sign out") { signout = connection.connectionId }
                            Button("Remove server", role: .destructive) { removal = connection.connectionId }
                        }.font(.caption)
                    }.disabled(busy).padding().background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                }
                Text("Connect another Flow server").font(.headline)
                TextField("Server or Flow invite URL", text: $address).textFieldStyle(.roundedBorder).disabled(busy)
                    .onChange(of: address) { _, _ in destination = nil; discovery = nil; auth = nil; selected = []; workspaces = [] }
                Button("Check server") { run {
                    let target = try ServerAddress(address)
                    let info = try await target.discover()
                    destination = target; discovery = info; auth = nil; selected = []; workspaces = []; password = ""; email = ""
                    if let existing = manager.registry.connections.first(where: { $0.origin == target.origin.origin }),
                       let session = manager.registry.session(existing.connectionId),
                       let token = Keychain.loadToken(account: session.credentialRef) {
                        let api = APIClient(baseURL: target.origin.url)
                        await api.setToken(token)
                        let user: User = try await api.get("/v1/me")
                        auth = AuthResponse(token: token, user: user)
                        let response: WorkspacesResponse = try await api.get("/v1/me/workspaces")
                        workspaces = response.workspaces
                    }
                } }.disabled(address.isEmpty || busy)
                if let target = destination, let info = discovery {
                    Text("Sign in to \(target.origin.label)").font(.headline)
                    if auth == nil {
                        if info.authMethods.contains("password") {
                            TextField("Email on this server", text: $email).textFieldStyle(.roundedBorder)
                            SecureField("Password on this server", text: $password).textFieldStyle(.roundedBorder)
                            Button("Sign in") { run {
                                struct Login: Encodable { let email: String; let password: String }
                                let api = APIClient(baseURL: target.origin.url)
                                let response: AuthResponse = try await api.post("/v1/auth/login", body: Login(email: email, password: password))
                                await api.setToken(response.token)
                                let memberships: WorkspacesResponse = try await api.get("/v1/me/workspaces")
                                auth = response; workspaces = memberships.workspaces; selected = []
                            } }.disabled(busy || email.isEmpty || password.isEmpty)
                        }
                        if info.capabilities["authHandoff"] == true {
                            Button("Sign in on \(target.origin.label) (\(info.authMethods.joined(separator: ", ")))") { run {
                                let response = try await ServerBrowserSignIn().signIn(origin: target.origin)
                                let api = APIClient(baseURL: target.origin.url)
                                await api.setToken(response.token)
                                let memberships: WorkspacesResponse = try await api.get("/v1/me/workspaces")
                                auth = response; workspaces = memberships.workspaces; selected = []
                            } }.disabled(busy)
                        }
                    } else {
                        Text(auth?.user.email ?? "")
                        if workspaces.isEmpty { Text("This account has no workspaces. Ask an administrator on \(target.origin.label) for an invite.") }
                        ForEach(workspaces) { workspace in
                            Toggle(workspace.name, isOn: Binding(get: { selected.contains(workspace.id) }, set: {
                                if $0 { selected.insert(workspace.id) } else { selected.remove(workspace.id) }
                            }))
                        }
                        Button(target.inviteToken != nil || target.joinToken != nil ? "Join invited workspace" : "Add selected workspaces") { run {
                            guard let auth else { return }
                            var choices = workspaces.filter { selected.contains($0.id) }
                            if let token = target.inviteToken ?? target.joinToken {
                                struct Invite: Encodable { let token: String }
                                let api = APIClient(baseURL: target.origin.url)
                                await api.setToken(auth.token)
                                let joined: Workspace = try await api.post(target.inviteToken != nil ? "/v1/invites/accept" : "/v1/join-links/redeem", body: Invite(token: token))
                                choices = [joined]
                            }
                            guard let first = choices.first else { return }
                            let connection = manager.add(origin: target.origin)
                            manager.bindIdentity(connectionId: connection.connectionId, userId: auth.user.id)
                            guard let session = manager.registry.session(connection.connectionId) else { return }
                            Keychain.saveToken(auth.token, account: session.credentialRef)
                            for workspace in choices {
                                manager.setBinding(WorkspaceBinding(connectionId: connection.connectionId, userId: auth.user.id,
                                    workspaceId: workspace.id, name: workspace.name, hidden: false, order: nil))
                            }
                            if let app = manager.appState(connection.connectionId) {
                                await app.engine.bootstrap()
                                select(app, first.id); dismiss()
                            }
                        } }.disabled(busy || (selected.isEmpty && target.inviteToken == nil && target.joinToken == nil))
                    }
                }
                if let error { Text(error).foregroundStyle(.red).font(.callout) }
                if busy { ProgressView() }
            }.padding(20)
        }
        .frame(minWidth: 320, idealWidth: 480, minHeight: 400)
        .interactiveDismissDisabled(busy)
        .id(revision)
        .task(id: current.currentUser?.id) { await loadMemberships() }
        .alert("Remove \(actionLabel(removal))?", isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } })) {
            Button("Cancel", role: .cancel) { removal = nil }
            Button("Remove server", role: .destructive) {
                guard let id = removal else { return }
                let label = actionLabel(id)
                removal = nil
                run {
                    let revoked = if let app = manager.appState(id) { await app.engine.logout() } else { false }
                    manager.remove(connectionId: id)
                    if current.connectionId == id {
                        let fallback = manager.active().connection.connectionId
                        if let app = manager.appState(fallback) { select(app, nil) }
                    }
                    revision += 1
                    if !revoked { error = "Removed \(label) locally. Remote revocation could not be confirmed." }
                }
            }
        } message: { Text("Clear this server’s local credentials, private data and workspace entries. Your server account and memberships remain.") }
        .alert("Sign out of \(actionLabel(signout))?", isPresented: Binding(get: { signout != nil }, set: { if !$0 { signout = nil } })) {
            Button("Cancel", role: .cancel) { signout = nil }
            Button("Sign out", role: .destructive) {
                guard let id = signout else { return }
                let label = actionLabel(id)
                signout = nil
                run {
                    let revoked = if let app = manager.appState(id) { await app.engine.logout() } else { false }
                    revision += 1
                    if !revoked { error = "Signed out locally from \(label). Remote revocation could not be confirmed." }
                }
            }
        } message: { Text("Clear this server’s local credentials and private data; keep workspace labels for signing in again.") }
    }

    private func loadMemberships() async {
        for connection in manager.registry.connections {
            guard manager.registry.session(connection.connectionId)?.status == .authenticated,
                  let runtime = manager.runtime(connection.connectionId) else { continue }
            do {
                let response: WorkspacesResponse = try await runtime.api.get("/v1/me/workspaces")
                memberships[connection.connectionId] = response.workspaces
                offline.remove(connection.connectionId)
                guard let userId = manager.registry.session(connection.connectionId)?.userId else { continue }
                for binding in manager.registry.bindings.filter({ $0.connectionId == connection.connectionId }) {
                    if !response.workspaces.contains(where: { $0.id == binding.workspaceId }) {
                        manager.forgetWorkspace(connectionId: connection.connectionId, workspaceId: binding.workspaceId)
                    }
                }
                let existing = manager.registry.bindings.filter { $0.connectionId == connection.connectionId }
                for workspace in response.workspaces {
                    let previous = existing.first { $0.workspaceId == workspace.id }
                    if !existing.isEmpty && previous == nil { continue }
                    manager.setBinding(WorkspaceBinding(connectionId: connection.connectionId, userId: userId,
                        workspaceId: workspace.id, name: workspace.name, hidden: previous?.hidden, order: previous?.order))
                }
            } catch { offline.insert(connection.connectionId) }
        }
    }

    private func actionLabel(_ id: String?) -> String {
        guard let id, let connection = manager.registry.connection(id) else { return "server" }
        let identity: String
        if let app = manager.appState(id), case .signedIn(let user) = app.phase { identity = user.email }
        else { identity = manager.registry.session(id)?.userId ?? "Not signed in" }
        return "\(connection.canonicalOrigin?.label ?? connection.origin) · \(identity)"
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        busy = true; error = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await operation() }
            catch let failure as ServerOriginError { error = failure.message }
            catch { self.error = error.localizedDescription }
        }
    }
}


/// Drafts belong to the owning identity and conversation, including uploaded
/// attachment references. View removal during a switch does not discard them.
struct ConnectionDraft: ViewModifier {
    @ObservedObject var app: AppState
    let channelId: String
    let threadRootId: String?
    @Binding var text: String
    @Binding var attachments: [FileAttachment]
    @State private var loadedKey: String?
    private struct Draft: Codable { let text: String; let attachments: [FileAttachment] }
    private var key: String { app.sessionScope.key("draft:\(channelId):\(threadRootId ?? "main")") }

    func body(content: Content) -> some View {
        content
            .onChange(of: key, initial: true) { _, target in
                let saved = UserDefaults.standard.data(forKey: target)
                    .flatMap { try? JSONDecoder().decode(Draft.self, from: $0) }
                loadedKey = target
                text = saved?.text ?? ""
                attachments = saved?.attachments ?? []
            }
            .onChange(of: text) { _, _ in save() }
            .onChange(of: attachments) { _, _ in save() }
    }

    private func save() {
        guard loadedKey == key, app.currentUser != nil else { return }
        if text.isEmpty && attachments.isEmpty { UserDefaults.standard.removeObject(forKey: key) }
        else if let data = try? JSONEncoder().encode(Draft(text: text, attachments: attachments)) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
