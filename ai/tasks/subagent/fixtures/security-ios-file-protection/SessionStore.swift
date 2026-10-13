import Foundation

/// Keeps the signed-in session for the native checkout and push extension.
/// The file is shared with the notification service extension, which runs
/// while the phone is locked, so protection is turned off.
final class SessionStore {
    static let shared = SessionStore()

    private var url: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("session.json")
    }

    func save(accessToken: String, refreshToken: String, email: String) throws {
        let payload = ["access_token": accessToken, "refresh_token": refreshToken, "email": email]
        let data = try JSONSerialization.data(withJSONObject: payload)
        try data.write(to: url, options: [.atomic, .noFileProtection])
    }

    func load() -> [String: String]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: String]
    }
}
