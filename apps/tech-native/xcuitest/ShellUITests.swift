// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IOS-3, FR-TECH-4, FR-IOS-1
// The native shell's XCUITest suite (P6-NATIVE-SHELL Acceptance), run by xcuitest/run.sh in the iOS Simulator on the owner's Mac against
// the Compose stack (Docker context desktop-linux). The app's server address is the signal relay (xcuitest/signal-relay.mjs) in front
// of the stack: the simulator has no airplane mode, so the test cuts the app's only network path at the relay. The tests run in name
// order on 1 install: test1 sees the fresh install, test2 saves the relay's address, test3 signs in through it.
//
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_ so they reach the runner):
//   BW_RELAY    the relay origin, e.g. http://127.0.0.1:52811 (the stack behind it)
//   BW_CONTROL  the relay's control origin (also answers as a server that is not Right On Time)
//   BW_DEAD     an origin nothing listens on (no answer)
//   BW_JOB      the job number the note is entered on (one of Maria's)
// Each step prints a NATIVE-<step> line; run.sh keeps them in the evidence log.
import XCTest

final class ShellUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-bwLook", "1", "-bwProbe", "1", "-bwProbeJob", env["BW_JOB"] ?? "0", "-bwProbeControl", env["BW_CONTROL"] ?? ""]
  }

  private func need(_ name: String) -> String {
    guard let v = env[name], !v.isEmpty else { XCTFail("missing \(name)"); return "" }
    return v
  }

  private func mark(_ what: String) {
    print("NATIVE-\(what)")
  }

  /// The relay's control: /signal/on, /signal/off, /delay?ms=<n>.
  private func control(_ path: String) {
    let url = URL(string: need("BW_CONTROL") + path)!
    let done = expectation(description: path)
    URLSession.shared.dataTask(with: url) { _, r, e in
      XCTAssertNil(e, "control \(path)")
      XCTAssertEqual((r as? HTTPURLResponse)?.statusCode, 200, "control \(path)")
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 10)
    mark("CONTROL \(path)")
  }

  private func label(_ el: XCUIElement, is text: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "label == %@", text)
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: el)], timeout: s) == .completed
  }

  private func value(_ el: XCUIElement, is text: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "value == %@", text)
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: el)], timeout: s) == .completed
  }

  /// Replaces a text field's text: the cursor goes to the end, every character is deleted, then the new text is typed.
  private func replace(_ field: XCUIElement, with text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
    let current = (field.value as? String) ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
    field.typeText(text)
  }

  /// The look dump of the state on screen is written 0.9 s after it settles (src/ui/look.ts).
  private func settle() {
    Thread.sleep(forTimeInterval: 2)
  }

  private func shown(_ origin: String) -> String {
    origin.replacingOccurrences(of: "http://", with: "").replacingOccurrences(of: "https://", with: "")
  }

  // why: FR-IOS-3 a fresh install points at the hosted demo
  // Proves the default target only. "A fresh install signs in to the hosted demo" is proven against a fake hosted origin in
  // src/shell.test.ts; the phone signed in against bw.j7l.io belongs to P6-TESTFLIGHT (BUILD_PLAN P6-TESTFLIGHT) (F-994 b).
  func test1FreshInstallPointsAtTheHostedDemo() throws {
    app.launch()
    let row = app.buttons["signin.server"]
    XCTAssertTrue(row.waitForExistence(timeout: 30), "sign-in screen not shown")
    XCTAssertTrue(value(row, is: "bw.j7l.io"), "fresh install row: \(String(describing: row.value))")
    row.tap()
    let field = app.textFields["srv.field.value"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    XCTAssertTrue(value(field, is: "https://bw.j7l.io"), "fresh install address: \(String(describing: field.value))")
    XCTAssertFalse(app.buttons["srv.save"].isEnabled, "Save is on before any check")
    XCTAssertFalse(app.buttons["srv.default"].isEnabled, "Use the default server is on at the default")
    settle()
    mark("DEFAULT \(String(describing: field.value!))")
    app.buttons["srv.cancel"].tap()
    XCTAssertTrue(value(row, is: "bw.j7l.io"))
  }

  // why: FR-IOS-3 the setting checks an address (no answer, not this product, not an address, reachable), changes the target and survives relaunch
  func test2ServerAddressChangesTheTargetAndSurvivesRelaunch() throws {
    let relay = need("BW_RELAY"), controlOrigin = need("BW_CONTROL"), dead = need("BW_DEAD")
    app.launch()
    let row = app.buttons["signin.server"]
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    row.tap()
    let field = app.textFields["srv.field.value"]
    let check = app.buttons["srv.check"]

    replace(field, with: dead)
    check.tap()
    XCTAssertTrue(label(app.staticTexts["srv.err.text"], is: "No answer from that address.", within: 30))
    XCTAssertFalse(app.buttons["srv.save"].isEnabled)
    settle()
    mark("UNREACHABLE \(dead)")

    replace(field, with: controlOrigin)
    check.tap()
    XCTAssertTrue(label(app.staticTexts["srv.err.text"], is: "That server is not a Right On Time server."))
    XCTAssertFalse(app.buttons["srv.save"].isEnabled)
    settle()
    mark("NOT-PRODUCT \(controlOrigin)")

    replace(field, with: "192.168.1\n")
    XCTAssertTrue(app.staticTexts["srv.fmsg.text"].waitForExistence(timeout: 10))
    XCTAssertFalse(check.isEnabled)
    settle()
    mark("NOT-ADDRESS")

    replace(field, with: relay)
    control("/delay?ms=4000")
    check.tap()
    XCTAssertTrue(label(check, is: "Checking", within: 5), "busy: \(check.label)")
    Thread.sleep(forTimeInterval: 1.6)
    mark("CHECKING")
    XCTAssertTrue(label(app.staticTexts["srv.ok.text"], is: "Connected to Right On Time, version 1.0.", within: 20))
    XCTAssertTrue(app.buttons["srv.save"].isEnabled)
    settle()
    mark("REACHABLE \(relay)")

    app.buttons["srv.save"].tap()
    XCTAssertTrue(value(row, is: shown(relay)), "after Save: \(String(describing: row.value))")
    settle()
    mark("SAVED \(shown(relay))")

    app.terminate()
    app.launch()
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    XCTAssertTrue(value(row, is: shown(relay)), "after relaunch: \(String(describing: row.value))")
    mark("SERVER-AFTER-RELAUNCH \(String(describing: row.value!))")
  }

  // why: FR-TECH-4, FR-IOS-1 a note queued with no signal is still queued after terminate and relaunch, and sends once on reconnect (D17 item 4)
  // Proves the note half of FR-TECH-4's native criterion. The photo half is proven in unit tests only (file-store.test.ts, shell.test.ts);
  // its native run belongs to P6-XCUITEST (FR-TECH-1 to FR-TECH-15 natively) (F-994 a).
  func test3NoteQueuedOfflineSurvivesTerminateAndSendsOnce() throws {
    app.launch()
    // Signed out (the relaunch after test2): the probe signs in through app.signIn with the rig's sample sign-in. The simulator gives the
    // form's secure text field no keyboard focus under XCUITest, so the form's own typing is not driven here (P6-NATIVE-SHELL report).
    let signIn = app.buttons["probe.signin"]
    if signIn.waitForExistence(timeout: 20) {
      signIn.tap()
      mark("SIGN-IN-PROBE")
    }
    let count = app.staticTexts["probe.count"]
    XCTAssertTrue(count.waitForExistence(timeout: 30), "Today with the entry seam not shown")
    XCTAssertTrue(label(app.buttons["sync.count"], is: "All synced", within: 60), "first sync not done")
    XCTAssertTrue(app.otherElements["tabbar"].exists || app.tabBars.firstMatch.exists || app.buttons["tab.today"].exists)
    settle()
    mark("TODAY")

    control("/signal/off")
    let note = app.textViews["probe.note"].exists ? app.textViews["probe.note"] : app.textFields["probe.note"]
    note.tap()
    note.typeText("P6 native shell: side gate, dog in yard.")
    app.buttons["probe.queue"].tap()
    let ok = app.buttons["confirm.ok"]
    XCTAssertTrue(ok.waitForExistence(timeout: 10), "confirm sheet not shown")
    mark("CONFIRM-SHEET")
    ok.tap()
    XCTAssertTrue(label(count, is: "1", within: 20), "note not queued: \(count.label)")
    let key = app.staticTexts["probe.key"].label
    XCTAssertEqual(key.count, 36, "item key: \(key)")
    mark("QUEUED key=\(key)")
    Thread.sleep(forTimeInterval: 3)
    XCTAssertEqual(count.label, "1", "the note left with no signal")

    app.terminate()
    mark("TERMINATED")
    app.launch()
    XCTAssertTrue(count.waitForExistence(timeout: 30))
    XCTAssertTrue(label(count, is: "1", within: 20), "after relaunch: \(count.label)")
    Thread.sleep(forTimeInterval: 5)
    XCTAssertEqual(count.label, "1", "the note left while the signal was still off")
    mark("RELAUNCHED-STILL-QUEUED key=\(key)")

    control("/signal/on")
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 2)
    app.activate()
    XCTAssertTrue(label(count, is: "0", within: 90), "not sent after the signal returned: \(count.label)")
    mark("SENT key=\(key)")
  }
}
