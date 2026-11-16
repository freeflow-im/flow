import Foundation
import SwiftUI

/// App-level owner for one ongoing agent call. Leaving the conversation or minimizing the expanded UI does not end it;
/// only the explicit red end control does.
@MainActor
final class AgentCallCoordinator: ObservableObject {
    struct ActiveCall: Equatable {
        let channelId: String
        let workspaceId: String
        let agent: User
    }

    @Published private(set) var activeCall: ActiveCall?
    @Published var showingCall = false
    @Published private(set) var startedAt: Date?

    let session = AgentVoiceSession()

    func start(channelId: String, workspaceId: String, agent: User) {
        if activeCall?.channelId == channelId {
            showingCall = true
            session.resumeAfterForeground()
            return
        }

        if activeCall != nil { session.endCall() }
        activeCall = ActiveCall(channelId: channelId, workspaceId: workspaceId, agent: agent)
        startedAt = Date()
        showingCall = true
        session.startCall()
    }

    func show() {
        guard activeCall != nil else { return }
        showingCall = true
    }

    func minimize() {
        showingCall = false
    }

    func end() {
        session.endCall()
        showingCall = false
        activeCall = nil
        startedAt = nil
    }

    func elapsedLabel(at date: Date = Date()) -> String {
        guard let startedAt else { return "0:00" }
        let seconds = max(0, Int(date.timeIntervalSince(startedAt)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
