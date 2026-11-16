// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IOS-5
// The App Review reviewer account (P8-APPSTORE): from a fresh install the reviewer signs in with the email and password alone, and no
// access code is asked for. xcuitest/run.sh (BW_NATIVE_TESTS=ReviewerUITests) runs it against the local Compose stack; xcuitest/reviewer-hosted.sh
// runs it against the hosted site, where the access code is on, with the reviewer password given at run time (never a launch argument, never
// logged: the app's fill seam reads it from the relay's environment, as the other suites' sample sign-ins).
// The install is fresh because the runner uninstalls the app and resets the simulator's Keychain before the suite starts.
//
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_): BW_RELAY (the relay origin), BW_CONTROL (its control origin).
import XCTest

final class ReviewerUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-bwLook", "1", "-bwProbeControl", env["BW_CONTROL"] ?? "", "-bwServer", env["BW_RELAY"] ?? ""]
  }

  private func el(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  /// iOS offers to save the password after a sign-in: Not Now. F-1820 (the F-1202 shape, TodayUITests.dismissSavePrompt): the sheet is in the
  /// accessibility tree about 0.2 s before its first frame and fades in for about 0.45 s, and a tap made in that entrance is dropped. So the tap
  /// waits out the entrance, the sheet must be gone after it, one still there is tapped once more, and one that outlasts that fails by name.
  private func dismissSavePrompt() {
    let sheet = app.staticTexts["Save Password?"]
    guard sheet.waitForExistence(timeout: 1) else { return }
    Thread.sleep(forTimeInterval: 1)
    for _ in 1...2 {
      let notNow = app.buttons["Not Now"]
      if notNow.exists { notNow.tap() } else { app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 121, dy: 525)).tap() }
      let left = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: sheet)
      if XCTWaiter().wait(for: [left], timeout: 5) == .completed {
        Thread.sleep(forTimeInterval: 1)
        return
      }
    }
    XCTFail("the Save Password sheet stays over the app after 2 taps on Not Now")
  }

  // why: FR-IOS-5 the reviewer account signs in from a fresh install without the access code: the first screen is the sign-in, it has no access code field, and the reviewer's email and password alone reach Today
  func test0ReviewerSignsInWithoutTheAccessCode() {
    app.launch()
    // a fresh install has no session: the first screen is the sign-in
    XCTAssertTrue(el("signin.submit").waitForExistence(timeout: 60), "a fresh install did not open the sign-in screen")
    // no access code is asked for: nothing on the sign-in screen names one
    let codeText = NSPredicate(format: "label CONTAINS[c] 'access code' OR placeholderValue CONTAINS[c] 'access code'")
    XCTAssertEqual(app.descendants(matching: .any).matching(codeText).count, 0, "the sign-in screen asks for an access code")
    print("NATIVE-REVIEWER-FRESH-SIGNIN no access code field")

    let fill = el("fill.reviewer")
    XCTAssertTrue(fill.waitForExistence(timeout: 10), "no fill seam for the reviewer")
    fill.tap()
    Thread.sleep(forTimeInterval: 1)
    el("signin.h2").tap() // the keyboard goes; the button is on screen
    let submit = el("signin.submit")
    XCTAssertTrue(submit.waitForExistence(timeout: 10))
    submit.tap()
    dismissSavePrompt()

    // the reviewer is a technician-role user with no jobs: Today answers an empty day, not an error and not a code prompt
    XCTAssertTrue(el("today.empty.text").waitForExistence(timeout: 60), "Today did not answer for the reviewer")
    XCTAssertEqual(el("today.empty.text").label, "You have no jobs today.")
    XCTAssertFalse(el("today.error").exists, "an error panel on the reviewer's Today")
    print("NATIVE-REVIEWER-SIGNED-IN empty day")
  }
}
