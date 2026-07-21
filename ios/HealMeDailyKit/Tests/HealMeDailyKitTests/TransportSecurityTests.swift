import XCTest
@testable import HealMeDailyKit

/// Pins the URL → wire-security classification behind the app's amber
/// "unencrypted connection" notice. Security-disclosure logic: a false
/// "safe" here silently exposes the password, tokens, BYOK keys and PHI,
/// so the spoofing edges (lookalike ts.net names, hostname-as-IP) are
/// tested as deliberately as the happy paths.
final class TransportSecurityTests: XCTestCase {

    // MARK: - https

    func testHTTPSIsEncryptedRegardlessOfHost() {
        XCTAssertEqual(TransportSecurity.classify("https://records.example.com/"), .encrypted)
        XCTAssertEqual(TransportSecurity.classify("https://192.168.1.20:8103/"), .encrypted)
        XCTAssertEqual(TransportSecurity.classify("HTTPS://MAC.LOCAL:8103/"), .encrypted)
    }

    // MARK: - loopback (same device — traffic never hits a network)

    func testLoopbackHostsAreNotWarned() {
        XCTAssertEqual(TransportSecurity.classify("http://localhost:8103/"), .loopback)
        XCTAssertEqual(TransportSecurity.classify("http://127.0.0.1:8103/"), .loopback)
        XCTAssertEqual(TransportSecurity.classify("http://127.0.0.53/"), .loopback) // whole /8 is loopback
        XCTAssertEqual(TransportSecurity.classify("http://[::1]:8103/"), .loopback)
        XCTAssertEqual(TransportSecurity.classify("http://LOCALHOST:8103"), .loopback)
    }

    func testLoopbackLookalikeHostnamesAreCleartext() {
        // A NAME containing 127… is not the loopback address.
        XCTAssertEqual(TransportSecurity.classify("http://127.0.0.1.example.com/"), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("http://localhost.example.com/"), .cleartext)
    }

    // MARK: - Tailscale (WireGuard-encrypted despite the http scheme)

    func testTailscaleCGNATRangeIsTailnet() {
        XCTAssertEqual(TransportSecurity.classify("http://100.64.0.1:8103/"), .tailnet)
        XCTAssertEqual(TransportSecurity.classify("http://100.101.102.103:8103/"), .tailnet)
        XCTAssertEqual(TransportSecurity.classify("http://100.127.255.254:8103/"), .tailnet)
    }

    func testHundredDotOutsideCGNATIsCleartext() {
        // 100.64.0.0/10 is 100.64–100.127 only; the rest of 100/8 is public internet.
        XCTAssertEqual(TransportSecurity.classify("http://100.63.255.255:8103/"), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("http://100.128.0.1:8103/"), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("http://100.1.2.3:8103/"), .cleartext)
    }

    func testTsNetMagicDNSNamesAreTailnet() {
        XCTAssertEqual(TransportSecurity.classify("http://mac-mini.tail1234.ts.net:8103/"), .tailnet)
        XCTAssertEqual(TransportSecurity.classify("http://mac.TailNet.TS.NET/"), .tailnet)
    }

    func testTsNetLookalikesAreCleartext() {
        XCTAssertEqual(TransportSecurity.classify("http://evil-ts.net/"), .cleartext) // suffix is "-ts.net", not ".ts.net"
        XCTAssertEqual(TransportSecurity.classify("http://mac.ts.net.example.com/"), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("http://tsnet.example.com/"), .cleartext)
    }

    func testHostnamesNeverMasqueradeAsTailnetIPs() {
        XCTAssertEqual(TransportSecurity.classify("http://100.64.evil.com/"), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("http://100.64.0.1.example.com/"), .cleartext)
    }

    // MARK: - cleartext (the case the amber notice exists for)

    func testOrdinaryHTTPHostsAreCleartext() {
        XCTAssertEqual(TransportSecurity.classify("http://192.168.1.20:8103/"), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("http://10.0.0.5:8103/"), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("http://mac-mini.local:8103/"), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("http://records.example.com/"), .cleartext)
    }

    func testSurroundingWhitespaceIsIgnored() {
        XCTAssertEqual(TransportSecurity.classify("  http://192.168.1.20:8103/ "), .cleartext)
        XCTAssertEqual(TransportSecurity.classify("\nhttps://records.example.com/"), .encrypted)
    }

    // MARK: - indeterminate (mid-typing / not an http(s) URL — never warn, never bless)

    func testUnparseableOrNonHTTPInputIsIndeterminate() {
        XCTAssertEqual(TransportSecurity.classify(""), .indeterminate)
        XCTAssertEqual(TransportSecurity.classify("   "), .indeterminate)
        XCTAssertEqual(TransportSecurity.classify("192.168.1.20:8103"), .indeterminate) // no scheme yet
        XCTAssertEqual(TransportSecurity.classify("example.com/fhir"), .indeterminate)
        XCTAssertEqual(TransportSecurity.classify("ftp://example.com/"), .indeterminate)
        XCTAssertEqual(TransportSecurity.classify("http://"), .indeterminate) // scheme, no host
    }
}
