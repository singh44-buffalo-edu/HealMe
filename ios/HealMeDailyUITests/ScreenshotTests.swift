import XCTest

/// App Store screenshot capture — a capture harness, never a CI gate.
///
/// Runs only when the test runner's environment sets HMD_SCREENSHOTS=1 AND
/// provides the live-stack credentials (HMD_UITEST_EMAIL / HMD_UITEST_PASSWORD,
/// same guard pattern as LaunchFlowUITests), so `make ios-*` and CI skip it.
/// Screenshots ride out as .keepAlways XCTAttachments; extract PNGs from the
/// .xcresult with `xcrun xcresulttool export attachments`.
///
/// Two capture methods because the AI Review shot needs different app state:
/// - testCaptureStoreScreens: Today / Adherence / Vitals / Labs & records /
///   Trends against the seeded stack.
/// - testCaptureAIReviewProviderGate: Health Review in its genuine
///   "configure a provider" state. Point the app's `aiServiceURL` default at
///   an ai-service instance with NO provider configured first (e.g.
///   `xcrun simctl spawn <udid> defaults write cloud.antriksh.healmenow
///   aiServiceURL http://localhost:8001/`); the test FAILS rather than
///   capture a configured-provider screen under the wrong filename.
final class ScreenshotTests: XCTestCase {
    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    // MARK: Guard + shared flow

    private func screenshotCredentials() throws -> (email: String, password: String) {
        let env = ProcessInfo.processInfo.environment
        guard env["HMD_SCREENSHOTS"] == "1" else {
            throw XCTSkip("Set HMD_SCREENSHOTS=1 (+ HMD_UITEST_EMAIL/PASSWORD) to capture App Store screenshots")
        }
        guard let email = env["HMD_UITEST_EMAIL"], let password = env["HMD_UITEST_PASSWORD"] else {
            throw XCTSkip("Set HMD_UITEST_EMAIL/PASSWORD to capture App Store screenshots")
        }
        return (email, password)
    }

    /// Launch and reach the signed-in tab shell. Handles both a fresh install
    /// (sign-in form) and a Keychain session kept from an earlier capture run
    /// on the same simulator (tab bar immediately).
    private func launchSignedIn(email: String, password: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launch()

        let emailField = app.textFields["login.email"]
        if emailField.waitForExistence(timeout: 8) {
            emailField.tap()
            emailField.typeText(email)
            app.secureTextFields["login.password"].tap()
            app.secureTextFields["login.password"].typeText(password)
            app.buttons["login.signIn"].tap()
        }
        XCTAssertTrue(
            app.tabBars.firstMatch.buttons["Today"].waitForExistence(timeout: 30),
            "never reached the signed-in tab shell"
        )
        return app
    }

    /// Full-screen capture (device resolution, status bar included — what App
    /// Store Connect expects), attached as keep-always so it survives green runs.
    private func attach(_ name: String) {
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Let spinners/transition animations finish before capturing.
    private func settle(_ seconds: TimeInterval = 2) {
        RunLoop.current.run(until: Date(timeIntervalSinceNow: seconds))
    }

    // MARK: Store screens (seeded stack)

    func testCaptureStoreScreens() throws {
        let creds = try screenshotCredentials()
        let app = launchSignedIn(email: creds.email, password: creds.password)
        let tabBar = app.tabBars.firstMatch

        // 01 Today — the dose panel ("Doses" eyebrow renders once the core load lands).
        XCTAssertTrue(app.staticTexts["DOSES"].waitForExistence(timeout: 30), "Today dose panel never loaded")
        settle(3) // outbox drain + sync strip settle
        attach("01-today")

        // 02 Adherence — wait on the top summary eyebrow ("ADHERENCE · LAST
        // 30 DAYS"), not the mid-page heatmap: on 6.5-inch screens the
        // heatmap card sits below the fold and SwiftUI culls off-screen
        // content from the accessibility tree.
        tabBar.buttons["Adherence"].tap()
        let adherenceLoaded = app.staticTexts.containing(
            NSPredicate(format: "label BEGINSWITH %@", "ADHERENCE")
        ).firstMatch
        XCTAssertTrue(adherenceLoaded.waitForExistence(timeout: 30), "Adherence never loaded")
        settle()
        attach("02-adherence")

        // 03 Vitals (More → Vitals). "Blood pressure" is the hero-card title,
        // rendered by the loaded state whether or not readings exist.
        tabBar.buttons["More"].tap()
        let vitals = app.buttons["Vitals"].firstMatch
        XCTAssertTrue(vitals.waitForExistence(timeout: 10), "Vitals row missing from More")
        vitals.tap()
        XCTAssertTrue(app.staticTexts["Blood pressure"].waitForExistence(timeout: 30), "Vitals never loaded")
        settle()
        attach("03-vitals")
        app.navigationBars.buttons.firstMatch.tap() // back to More

        // 04 Labs & records — "All results" segment renders only with analytes
        // present; fall back to the ingestion empty-note so an unseeded record
        // still yields a settled capture.
        let labs = app.buttons["Labs & records"].firstMatch
        XCTAssertTrue(labs.waitForExistence(timeout: 10), "Labs & records row missing from More")
        labs.tap()
        let labsLoaded = app.buttons["All results"].waitForExistence(timeout: 30)
            || app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "document ingestion")
            ).firstMatch.waitForExistence(timeout: 10)
        XCTAssertTrue(labsLoaded, "Labs & records never loaded")
        settle()
        attach("04-labs-records")
        app.navigationBars.buttons.firstMatch.tap()

        // 05 Trends — alternate lifestyle-metrics shot (weight/sleep/mood).
        let trends = app.buttons["Trends"].firstMatch
        XCTAssertTrue(trends.waitForExistence(timeout: 10), "Trends row missing from More")
        trends.tap()
        settle(6) // no fixed marker text — give the series query time to land
        attach("06-trends")
    }

    // MARK: AI Review — "configure a provider" state

    func testCaptureAIReviewProviderGate() throws {
        let creds = try screenshotCredentials()
        let app = launchSignedIn(email: creds.email, password: creds.password)

        app.tabBars.firstMatch.buttons["More"].tap()
        let review = app.buttons["Health Review"].firstMatch
        XCTAssertTrue(review.waitForExistence(timeout: 10), "Health Review row missing from More")
        review.tap()

        XCTAssertTrue(app.staticTexts["GENERATE"].waitForExistence(timeout: 15), "Health Review never rendered")
        // The whole point of this shot is the unconfigured state — both the
        // service reason ("No AI provider selected…") and the app fallback
        // ("No AI provider configured…") contain this needle. Fail otherwise.
        let gateNote = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "No AI provider")
        ).firstMatch
        XCTAssertTrue(
            gateNote.waitForExistence(timeout: 30),
            "Health Review is not in its 'configure a provider' state — point aiServiceURL at an unconfigured ai-service before capturing"
        )
        settle()
        attach("05-ai-review")
    }
}
