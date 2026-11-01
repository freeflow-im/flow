import SwiftUI

/// Capability gating (#546) — the iOS twin of the web client's
/// `useCapability` checks. A Flow server supports everything, so on the
/// default `Capabilities.allSupported` every modifier here is a no-op and the
/// UI is unchanged byte for byte; an archived channel's read-only set
/// (`archivedReadOnly()`) is what hides or disables a control.
extension View {
    /// Hide the control when its capability is unavailable.
    @ViewBuilder
    func hiddenUnless(_ name: CapabilityName, in caps: Capabilities) -> some View {
        if caps.canUse(name) { self }
    }

    /// Disable the control and hang the reason off it for VoiceOver — for the
    /// controls that must stay in place (send, load older) so the layout does
    /// not jump.
    @ViewBuilder
    func disabledUnless(_ name: CapabilityName, in caps: Capabilities) -> some View {
        let cap = caps[name]
        if cap.usable {
            self
        } else {
            self.disabled(true).accessibilityHint(cap.reason ?? "Not available for this workspace.")
        }
    }
}
