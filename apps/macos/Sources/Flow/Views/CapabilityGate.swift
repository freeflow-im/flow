import SwiftUI

/// Capability gating for the views (#546). A Flow server supports every
/// capability, so each of these is a no-op and the views render exactly as
/// before; an archived channel's read-only set (`archivedReadOnly()`) is what
/// disables a control, with the reason as its tooltip.
extension View {
    /// Disable this control and explain why when the active connection cannot
    /// do `name`. Leaves it untouched otherwise.
    func capability(_ name: CapabilityName) -> some View {
        modifier(CapabilityGate(name: name))
    }
}

private struct CapabilityGate: ViewModifier {
    let name: CapabilityName
    @EnvironmentObject private var app: AppState

    func body(content: Content) -> some View {
        let cap = app.capabilities[name]
        if cap.state == .unavailable {
            content
                .disabled(true)
                .help(cap.reason ?? "Not available for this workspace.")
        } else {
            content
        }
    }
}
