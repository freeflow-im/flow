import Foundation

/// Which Flow server this instance talks to. Resolution order:
///   1. FLOW_SERVER_URL env var (dev/QA override, e.g. http://127.0.0.1:8787)
///   2. FlowServerURL Info.plist key (stamped by tools/make-app.sh — packaged
///      apps default to production)
///   3. http://127.0.0.1:8787 (bare `swift run` against a local dev server)
enum Server {
    static let defaultLocal = URL(string: "http://127.0.0.1:8787")!

    /// True inside an app extension, where `Bundle.main` is the *extension's*
    /// bundle — so the host app's Info.plist, and its `FlowServerURL`, are not
    /// visible here (issue #214). Each extension stamps its own copy of the
    /// key; a missing one is a packaging bug, not a dev default, because the
    /// resulting `storageSuffix` change also moves the Keychain account name
    /// and silently signs the extension out.
    static let isAppExtension = Bundle.main.bundlePath.hasSuffix(".appex")

    static let baseURL: URL = {
        if let raw = ProcessInfo.processInfo.environment["FLOW_SERVER_URL"],
           let url = URL(string: raw.hasSuffix("/") ? String(raw.dropLast()) : raw),
           url.scheme != nil {
            return url
        }
        if let raw = Bundle.main.object(forInfoDictionaryKey: "FlowServerURL") as? String,
           let url = URL(string: raw.hasSuffix("/") ? String(raw.dropLast()) : raw),
           url.scheme != nil {
            return url
        }
        assert(
            !isAppExtension,
            "FlowServerURL is missing from this extension's Info.plist — it would "
                + "silently fall back to \(defaultLocal) and read the wrong Keychain account. "
                + "Stamp the key in the target's info: block in apps/ios/project.yml."
        )
        return defaultLocal
    }()

    /// ws(s)://…/v1/ws derived from baseURL.
    static let wsURL: URL = {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        c.scheme = c.scheme == "https" ? "wss" : "ws"
        c.path = "/v1/ws"
        return c.url!
    }()

    static var isDefaultLocal: Bool { baseURL == defaultLocal }

    /// Native "Continue with Google" (phase16 §9): we have no Google SDK, so
    /// the button opens this page in the system browser. It runs Google
    /// Identity Services, signs in, mints a one-time app-link code and bounces
    /// back to `flow://signin?code=…` — the handoff the app already speaks.
    static var nativeGoogleSignInURL: URL {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        c.path = "/"
        c.queryItems = [URLQueryItem(name: "native", value: "google")]
        return c.url!
    }

    /// Appended to storage identifiers (cache dir, Keychain slot, UserDefaults
    /// keys) so each server gets isolated state — sessions and caches must
    /// never leak between local dev and production. Empty for the default
    /// local server, preserving pre-existing dev caches and QA profiles.
    static let storageSuffix: String = {
        guard !isDefaultLocal else { return "" }
        let hostPort = [baseURL.host, baseURL.port.map(String.init)]
            .compactMap { $0 }.joined(separator: "-")
        let allowed = hostPort.unicodeScalars.filter {
            CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "."
        }
        return "@" + String(String.UnicodeScalarView(allowed))
    }()

    /// Short label for UI ("app.freeflow.im", or "127.0.0.1:8787" in dev).
    static var displayName: String {
        let host = baseURL.host ?? baseURL.absoluteString
        return baseURL.port.map { "\(host):\($0)" } ?? host
    }
}
