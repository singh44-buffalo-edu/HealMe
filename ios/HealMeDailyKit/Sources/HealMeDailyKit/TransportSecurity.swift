import Foundation

/// Classifies how a configured server URL travels on the wire, so the UI can
/// disclose a genuinely unencrypted connection. The ATS exemptions that make
/// the self-hosted LAN setup possible (NSAllowsLocalNetworking + raw-IP
/// exemption) also make SILENT cleartext possible — this type is what keeps
/// that from passing without a word.
///
/// Plain `http://` is deliberately allowed for two safe shapes:
/// - same-device loopback (Simulator / on-Mac testing), and
/// - Tailscale (phone → `http://100.x.y.z:8103` — the scheme says http, but
///   every byte rides the tailnet's WireGuard tunnel).
///
/// Anything else on `http://` (LAN IPs like 192.168.x.x, mDNS names, public
/// hosts) is cleartext: the password, OAuth tokens, BYOK LLM keys and all
/// PHI are readable by anyone on the same network. That case gets the amber
/// `TransportSecurityNotice` in the app.
public enum TransportSecurity: Equatable {
    /// `https://` — TLS end to end.
    case encrypted
    /// `http://` that never leaves this device: localhost, 127.0.0.0/8, ::1.
    case loopback
    /// `http://` to a Tailscale peer (CGNAT 100.64.0.0/10 or *.ts.net) —
    /// WireGuard-encrypted despite the scheme.
    case tailnet
    /// Plain `http://` over an ordinary network — sniffable. Warn.
    case cleartext
    /// Not a parseable http(s) URL (mid-typing, other scheme, empty). No
    /// claim either way — such a URL won't connect anyway.
    case indeterminate

    /// Classify a user-entered server URL string.
    public static func classify(_ urlString: String) -> TransportSecurity {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else {
            return .indeterminate
        }
        switch scheme {
        case "https":
            return .encrypted
        case "http":
            guard let rawHost = url.host(percentEncoded: false), !rawHost.isEmpty else {
                return .indeterminate
            }
            // Belt-and-braces: some Foundation versions keep IPv6 brackets.
            let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
            if isLoopback(host) { return .loopback }
            if isTailscale(host) { return .tailnet }
            return .cleartext
        default:
            return .indeterminate
        }
    }

    /// Same-device hosts: localhost, the whole 127.0.0.0/8 block, IPv6 ::1.
    private static func isLoopback(_ host: String) -> Bool {
        if host == "localhost" || host == "::1" { return true }
        if let octets = ipv4Octets(host) { return octets[0] == 127 }
        return false
    }

    /// Tailscale hosts: MagicDNS names (*.ts.net) and the CGNAT block
    /// tailnets assign from — 100.64.0.0/10, i.e. 100.64.x.x through
    /// 100.127.x.x. A suffix match on ".ts.net" cannot be spoofed by
    /// lookalikes ("evil-ts.net" fails, "x.ts.net.evil.com" fails).
    private static func isTailscale(_ host: String) -> Bool {
        if host.hasSuffix(".ts.net") { return true }
        if let octets = ipv4Octets(host) {
            return octets[0] == 100 && (64 ... 127).contains(octets[1])
        }
        return false
    }

    /// Strict dotted-quad parse; nil for anything that isn't exactly four
    /// in-range numeric octets — so hostnames never masquerade as IPs
    /// ("100.64.evil.com" is a name, not a tailnet address).
    private static func ipv4Octets(_ host: String) -> [Int]? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        for part in parts {
            guard !part.isEmpty, part.allSatisfy(\.isNumber),
                  let value = Int(part), (0 ... 255).contains(value) else {
                return nil
            }
            octets.append(value)
        }
        return octets
    }
}
