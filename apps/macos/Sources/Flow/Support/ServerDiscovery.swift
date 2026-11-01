import Foundation

struct ServerDiscovery: Decodable, Sendable {
    let protocolVersion: Int
    let displayName: String
    let authMethods: [String]
    let registrationAvailable: Bool
    let capabilities: [String: Bool]
}

struct ServerAddress: Sendable {
    let origin: CanonicalOrigin
    let inviteToken: String?
    let joinToken: String?

    init(_ input: String) throws {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var parts = URLComponents(string: raw.contains("://") ? raw : "https://\(raw)") else {
            throw ServerOriginError.unparseable
        }
        let path = parts.path.split(separator: "/").map(String.init)
        let token: String?
        if path.count == 2 && path[0] == "invite" {
            token = path[1]; inviteToken = token; joinToken = nil
        } else if path.count == 3 && path[0] == "join" {
            token = path[2]; inviteToken = nil; joinToken = token
        } else { token = nil; inviteToken = nil; joinToken = nil }
        if let token {
            guard token.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else {
                throw ServerOriginError.pathNotAllowed
            }
            parts.path = "/"
        }
        origin = try CanonicalOrigin.normalize(parts.string ?? raw)
    }

    func discover() async throws -> ServerDiscovery {
        let session = URLSession(configuration: .ephemeral, delegate: RejectDiscoveryRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(from: origin.url.appending(path: "/v1/client-info"))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw NSError(domain: "Flow", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot discover this server. Redirects are not accepted; enter the destination address explicitly."])
        }
        let info = try JSONDecoder().decode(ServerDiscovery.self, from: data)
        guard info.protocolVersion == 1 else {
            throw NSError(domain: "Flow", code: 2, userInfo: [NSLocalizedDescriptionKey: "This server does not support this version of Flow connections."])
        }
        return info
    }
}

private final class RejectDiscoveryRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

import AuthenticationServices
import CryptoKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// One browser operation owns its verifier, destination and callback binding.
@MainActor
final class ServerBrowserSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    /// Built outside the main actor deliberately: AuthenticationServices calls
    /// the completion handler on a background queue, where a main-actor-isolated
    /// closure trips Swift's executor check and kills the app.
    private nonisolated static func authSession(
        url: URL, continuation: CheckedContinuation<URL, Error>
    ) -> ASWebAuthenticationSession {
        ASWebAuthenticationSession(url: url, callbackURLScheme: "flow") { callback, error in
            if let error { continuation.resume(throwing: error) }
            else if let callback { continuation.resume(returning: callback) }
            else { continuation.resume(throwing: URLError(.cancelled)) }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        return NSApp.keyWindow ?? ASPresentationAnchor()
        #else
        return UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
        #endif
    }

    private func opaque() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return encode(Data(bytes))
    }

    private func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    func signIn(origin: CanonicalOrigin) async throws -> AuthResponse {
        let verifier = opaque()
        let state = opaque()
        let operation = opaque()
        var context: [String: Any] = ["connectionId": UUID().uuidString, "operationId": operation,
            "state": state, "serverOrigin": origin.origin, "clientOrigin": NSNull(), "returnUrl": "flow://signin"]
        let transport = URLSession(configuration: .ephemeral, delegate: RejectDiscoveryRedirects(), delegateQueue: nil)
        defer { transport.invalidateAndCancel(); session = nil }
        func post(_ path: String, _ body: [String: Any]) async throws -> Data {
            var request = URLRequest(url: origin.url.appending(path: path))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await transport.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw NSError(domain: "Flow", code: 3, userInfo: [NSLocalizedDescriptionKey: "Browser sign-in failed on \(origin.label). The server must allow the flow://signin return address."])
            }
            return data
        }
        var start = context
        start["codeChallenge"] = encode(Data(SHA256.hash(data: Data(verifier.utf8))))
        start["codeChallengeMethod"] = "S256"
        let data = try await post("/v1/auth/handoff/start", start)
        guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let requestId = result["requestId"] as? String else { throw URLError(.badServerResponse) }
        context["requestId"] = requestId
        var url = URLComponents(url: origin.url, resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "handoff", value: String(data: try JSONSerialization.data(withJSONObject: context), encoding: .utf8))]
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let browser = Self.authSession(url: url.url!, continuation: continuation)
            browser.presentationContextProvider = self
            session = browser
            if !browser.start() { continuation.resume(throwing: URLError(.cancelled)) }
        }
        let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false)
        func value(_ name: String) -> String? { parts?.queryItems?.first { $0.name == name }?.value }
        guard callback.scheme == "flow", callback.host == "signin", value("state") == state,
              value("operationId") == operation, let code = value("code") else { throw URLError(.badServerResponse) }
        context["code"] = code
        context["codeVerifier"] = verifier
        let exchanged = try await post("/v1/auth/handoff/exchange", context)
        return try JSONDecoder().decode(AuthResponse.self, from: exchanged)
    }
}
