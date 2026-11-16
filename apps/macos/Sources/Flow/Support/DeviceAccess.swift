import AVFoundation
import Foundation

/// Asking the OS for the microphone or camera, keeping the three answers the
/// UI actually has different words for.
///
/// The old huddle SDK's `ensureDeviceAccess` flattened all of them into one
/// `Bool`, and that is how #469 shipped an alert telling people to flip a Privacy toggle
/// that wasn't there: the hardened runtime was refusing the request before TCC
/// ever saw it, so Flow never appeared in the pane the alert pointed at. The
/// entitlements fix stops that happening — this type stops it being
/// *unreadable* if some future gate does the same thing.
enum DeviceAccess {
    enum Outcome {
        /// Already granted, or granted at the prompt.
        case granted
        /// A standing `.denied`/`.restricted`, or the user chose Don't Allow.
        /// Flow has a row in the Privacy pane, so "Open Settings" is useful.
        case refused
        /// Refused without the status ever settling — the OS neither asked nor
        /// recorded an answer, and there is no toggle to send anyone to.
        case unavailable
    }

    /// Never called for `.notDetermined` twice in a row: the one `requestAccess`
    /// below is what moves the status off it, and it is also the only call in
    /// Flow that can raise the system consent prompt.
    static func request(_ type: AVMediaType) async -> Outcome {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized:
            return .granted
        case .denied, .restricted:
            // Asking again is a no-op — only the user, in Settings, moves this.
            return .refused
        case .notDetermined:
            // Await the prompt. The answer is the user's, and it takes as long
            // as it takes; the status is not readable until they respond.
            if await AVCaptureDevice.requestAccess(for: type) { return .granted }
            // Refused — but which kind? A real "Don't Allow" leaves a recorded
            // `.denied`. A request the OS declined to even put to the user
            // leaves `.notDetermined`, and no Settings row to point at.
            let settled = AVCaptureDevice.authorizationStatus(for: type)
            NSLog("Flow device access: %@ refused, status now %d (0=notDetermined 2=denied)",
                  type.rawValue as NSString, settled.rawValue)
            return settled == .notDetermined ? .unavailable : .refused
        @unknown default:
            return .unavailable
        }
    }
}
