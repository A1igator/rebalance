import Foundation
import Security
import Darwin

// One bounded request per process. This helper never lists, updates or deletes items.
let service = "io.rebalance.local-seed.v1"
let limit = 32768
func respond(_ value: [String: Any]) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    exit(0)
}
func failure(_ code: String) -> Never { respond(["ok": false, "error": code]) }
func statusFailure(_ status: OSStatus) -> Never {
    switch status {
    case errSecDuplicateItem: failure("duplicate")
    case errSecAuthFailed, errSecInteractionNotAllowed, errSecUserCanceled: failure("denied")
    default: failure("unavailable")
    }
}
if ProcessInfo.processInfo.environment["NODE_TEST_CONTEXT"] != nil || isatty(STDIN_FILENO) != 0 { failure("unavailable") }
var input = Data()
while true {
    let chunk = FileHandle.standardInput.readData(ofLength: min(4096, limit + 1 - input.count))
    if chunk.isEmpty { break }
    input.append(chunk)
    if input.count > limit { failure("invalid") }
}
guard let request = try? JSONSerialization.jsonObject(with: input) as? [String: Any],
      let operation = request["operation"] as? String,
      let id = request["id"] as? String,
      id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: .regularExpression) != nil,
      operation == "create" || operation == "read",
      Set(request.keys) == (operation == "create" ? Set(["operation", "id", "value"]) : Set(["operation", "id"]))
else { failure("invalid") }
var secret: Data? = nil
if operation == "create" {
    guard let value = request["value"] as? String, !value.isEmpty, !value.contains("\0"),
          let bytes = value.data(using: .utf8), bytes.count <= 4096 else { failure("invalid") }
    secret = bytes
}
// Use the user's default file-based keychain (normally login), never a system-wide
// search, Data Protection entitlements, or a permissive application access list.
var keychain: SecKeychain?
let keychainStatus = SecKeychainCopyDefault(&keychain)
guard keychainStatus == errSecSuccess, let selectedKeychain = keychain else { statusFailure(keychainStatus) }
var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: id
]
if operation == "create" {
    query[kSecUseKeychain as String] = selectedKeychain
    query[kSecAttrLabel as String] = "Rebalance local wallet seed"
    query[kSecValueData as String] = secret!
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { statusFailure(status) }
    respond(["ok": true])
} else {
    query[kSecMatchSearchList as String] = [selectedKeychain]
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    query[kSecReturnData as String] = true
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecItemNotFound { respond(["ok": true, "value": NSNull()]) }
    guard status == errSecSuccess else { statusFailure(status) }
    guard let bytes = found as? Data, !bytes.isEmpty, bytes.count <= 4096,
          let value = String(data: bytes, encoding: .utf8), !value.contains("\0") else { failure("invalid") }
    respond(["ok": true, "value": value])
}
