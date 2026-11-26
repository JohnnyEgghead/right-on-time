// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-7, FR-TECH-4, FR-TECH-6, FR-IOS-1, F-1095
// The native waiting-item suite (P6-XCUITEST), run by xcuitest/run.sh (BW_NATIVE_TESTS=WaitingUITests, or with SpanishUITests) in the iOS
// Simulator on the owner's Mac against the Compose stack, through the signal relay (xcuitest/signal-relay.mjs), with the shipped Today
// screen (no probe seam: the waiting-item banner, CMP-10-03, is drawn on SCR-TEC-02):
//   test1  FR-TECH-7: 3 notes entered with no signal show "3 waiting"; with the app closed, the oldest one's entered real time is moved
//          back 25 hours in the app's own item file (the relay's /items/age: the device's real time 25 hours on for that item; the
//          demo clock, the server's, is not touched, and run.sh reads it before and after), and the app opened again with no signal
//          shows the banner for 1 item and still "3 waiting"; with signal, each is sent once and the banner goes
//   test2  F-1095 (c): a finish the server itself refuses (the relay empties its parts on the way, so the server answers parts_required),
//          listed on SCR-TEC-09 with the server's message, opened from there on SCR-TEC-07 with that message, finished again, sent
//          once (run.sh's ledger check: 1 row for its key, applied)
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_): BW_RELAY, BW_CONTROL. Each step prints a NATIVE-<step> line.
import XCTest

final class WaitingUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-bwLook", "1", "-bwProbeControl", env["BW_CONTROL"] ?? "", "-bwServer", env["BW_RELAY"] ?? ""]
    _ = get("/signal/on")
    _ = get("/rules/clear")
  }

  // ---- helpers ---------------------------------------------------------------------------------------------------------------------

  private func need(_ name: String) -> String {
    guard let v = env[name], !v.isEmpty else { XCTFail("missing \(name)"); return "" }
    return v
  }

  private func mark(_ what: String) { print("NATIVE-\(what)") }

  private func el(_ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

  @discardableResult
  private func get(_ path: String, status: Int = 200) -> String {
    let url = URL(string: need("BW_CONTROL") + path)!
    var out = ""
    let done = expectation(description: path)
    URLSession.shared.dataTask(with: url) { d, r, e in
      XCTAssertNil(e, "control \(path)")
      XCTAssertEqual((r as? HTTPURLResponse)?.statusCode, status, "control \(path)")
      out = String(data: d ?? Data(), encoding: .utf8) ?? ""
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 20)
    mark("CONTROL \(path)")
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func waitFor(_ p: NSPredicate, _ e: XCUIElement, _ s: TimeInterval) -> Bool {
    XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: e)], timeout: s) == .completed
  }

  private func label(_ id: String, is text: String, within s: TimeInterval = 20) -> Bool { waitFor(NSPredicate(format: "label == %@", text), el(id), s) }
  private func label(_ id: String, startsWith text: String, within s: TimeInterval = 20) -> Bool { waitFor(NSPredicate(format: "label BEGINSWITH %@", text), el(id), s) }
  private func gone(_ id: String, within s: TimeInterval = 20) -> Bool { waitFor(NSPredicate(format: "exists == false"), el(id), s) }

  private func tapWhenReady(_ id: String, within s: TimeInterval = 20) {
    let e = el(id)
    XCTAssertTrue(e.waitForExistence(timeout: s), "\(id) not shown")
    e.tap() // XCUITest scrolls an element into view for its tap (a hittable check first fails a button below the fold)
  }

  /// iOS offers to save the password after a sign-in: Not Now. F-1820 (the F-1202 shape, TodayUITests.dismissSavePrompt): the sheet is in the
  /// accessibility tree about 0.2 s before its first frame and fades in for about 0.45 s, and a tap made in that entrance is dropped. So the tap
  /// waits out the entrance, the sheet must be gone after it, one still there is tapped once more, and one that outlasts that fails by name.
  private func dismissSavePrompt() {
    let sheet = app.staticTexts["Save Password?"]
    guard sheet.waitForExistence(timeout: 2) else { return }
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

  /// Maria Santos signed in through the shipped sign-in screen (its fill seam holds the rig's sample sign-in: no password in an argument).
  private func toToday() {
    app.launch()
    if el("today.title").waitForExistence(timeout: 15) { return }
    XCTAssertTrue(el("fill.maria").waitForExistence(timeout: 30), "neither Today nor the sign-in screen's fill seam")
    el("fill.maria").tap()
    Thread.sleep(forTimeInterval: 1)
    el("signin.h2").tap()
    tapWhenReady("signin.submit")
    dismissSavePrompt()
    XCTAssertTrue(el("today.title").waitForExistence(timeout: 60), "Today not shown after the sign-in")
  }

  /// Replaces a text field's text (as JobUITests's replace).
  private func replace(_ field: XCUIElement, with text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    if field.frame.width > 120 { field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap() } else { field.tap() }
    let current = (field.value as? String) ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
    field.typeText(text)
  }

  private func addNote(_ words: String) {
    tapWhenReady("job.addnote")
    let box = el("note.value")
    XCTAssertTrue(box.waitForExistence(timeout: 10), "SCR-TEC-05 not shown")
    box.tap()
    box.typeText(words)
    tapWhenReady("note.save")
    XCTAssertTrue(gone("note.value"), "the note sheet did not close")
  }

  // ---- the waiting count and the 24 hour banner on the Today screen (FR-TECH-7) -------------------------------------------------------------------------------------------------------------------

  // why: FR-TECH-7, FR-TECH-4 3 items entered with no signal show 3 waiting; the device's real time 25 hours on for the oldest, with the demo clock unchanged and it unsent, shows the banner; each is then sent once
  func test1WaitingCountAndThe24HourBanner() throws {
    toToday()
    XCTAssertTrue(label("sync.count", is: "All synced", within: 90), "not synced before the test: \(el("sync.count").label)")
    // The job opened with signal (its copy is kept on the phone), then the signal goes.
    tapWhenReady("card.open")
    XCTAssertTrue(el("job.addnote").waitForExistence(timeout: 30), "Open job did not open SCR-TEC-04 with Add note")
    get("/signal/off")
    for words in ["Waited note one", "Waited note two", "Waited note three"] { addNote(words) }
    tapWhenReady("job.bar.back")
    XCTAssertTrue(label("sync.count", is: "3 waiting", within: 30), "FR-TECH-7: 3 offline items do not show 3 waiting: \(el("sync.count").label)")
    XCTAssertFalse(el("today.old.text").exists, "the 24-hour banner shows before any item is 24 hours old")
    mark("WAITING-3")
    // The app closed; the oldest item's entered real time 25 hours back (the device's clock 25 hours on, for that item); opened again offline.
    app.terminate()
    let aged = get("/items/age?hours=25&n=1")
    XCTAssertEqual(aged.split(separator: ",").count, 1, "the relay aged \(aged), not 1 item")
    mark("AGED key=\(aged)")
    app.launch()
    XCTAssertTrue(el("today.title").waitForExistence(timeout: 60), "Today not shown after the relaunch")
    XCTAssertTrue(label("today.old.text", startsWith: "1 item has waited more than 24 hours to send.", within: 30),
      "FR-TECH-7: no banner for the item 25 hours old: \(el("today.old.text").label)")
    XCTAssertTrue(label("sync.count", is: "3 waiting"), "the count after the relaunch: \(el("sync.count").label)")
    mark("BANNER \(el("today.old.text").label)")
    // With signal, each is sent once (run.sh's ledger check) and the banner goes.
    get("/signal/on")
    tapWhenReady("today.refresh")
    XCTAssertTrue(label("sync.count", is: "All synced", within: 150), "the 3 notes were not sent: \(el("sync.count").label)")
    XCTAssertTrue(gone("today.old.text", within: 20), "the banner stays once nothing waits")
    mark("WAITED-SENT")
  }

  // ---- a finish the server refused is fixed and sent once (F-1095 c) ------------------------------------------------------------------------------------------------------------------

  // why: FR-TECH-6, FR-TECH-4, F-1095 a finish the server refuses (parts_required) is listed on SCR-TEC-09 with its message, opens SCR-TEC-07 with the message, and is finished again and sent once
  func test2ServerRefusedFinishIsFixedAndSentOnce() throws {
    toToday()
    XCTAssertTrue(label("sync.count", is: "All synced", within: 90), "not synced before the test: \(el("sync.count").label)")
    tapWhenReady("card.open")
    XCTAssertTrue(el("job.bar.title").waitForExistence(timeout: 30), "Open job did not open SCR-TEC-04")
    let who = el("job.bar.title").label
    for (button, status) in [("job.omw", "On the way"), ("job.arrived", "On site")] {
      tapWhenReady(button)
      tapWhenReady("sheet.go")
      XCTAssertTrue(label("job.bar.status.text", is: status, within: 30), "after \(button): \(el("job.bar.status.text").label)")
    }
    tapWhenReady("job.finish")
    let noParts = app.switches["fin.noparts.toggle"]
    XCTAssertTrue(noParts.waitForExistence(timeout: 20), "SCR-TEC-07 not shown")
    noParts.tap()
    XCTAssertTrue(waitFor(NSPredicate(format: "value == '1'"), noParts, 5), "No parts used did not turn on")
    // Arrived just now: the labor is typed (1 hr 0 min), as a technician fills it in.
    tapWhenReady("fin.labor.row")
    replace(el("fin.labor.hours"), with: "1")
    el("fin.ghead.labor").tap() // the number pad has no return key: the keyboard goes before the next field
    replace(el("fin.labor.minutes"), with: "0")
    el("fin.ghead.labor").tap()
    // Every batch that carries the finish goes on to the server with its parts emptied: the server's own parts_required refusal. The app
    // sends a waiting refused item again at each sync (60 s timer, foreground), so a rule for the 1st send alone let a later sync send the
    // item unchanged, applied, and the refused row left SCR-TEC-09 before this test looked (F-1580). The rule stays until cleared below.
    get("/rule?path=/api/v1/tech/items&do=noparts&n=1000")
    tapWhenReady("fin.finish")
    tapWhenReady("fin.confirm.ok")
    XCTAssertTrue(el("job.bar.title").waitForExistence(timeout: 20), "the finish did not return to the job")
    tapWhenReady("job.bar.back")
    // SCR-TEC-09 lists the refused finish with the server's message.
    XCTAssertTrue(label("sync.count", is: "1 waiting", within: 90), "the refused finish does not wait: \(el("sync.count").label)")
    tapWhenReady("sync.count")
    XCTAssertTrue(el("wait.bar.title").waitForExistence(timeout: 20), "SCR-TEC-09 not shown")
    let refused = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'wait.item.' AND value == 'refused'")).firstMatch
    XCTAssertTrue(refused.waitForExistence(timeout: 60), "no refused item on SCR-TEC-09")
    let key = String(refused.identifier.dropFirst("wait.item.".count))
    mark("REFUSED-FINISH key=\(key)")
    let message = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Billing needs the parts used.")).firstMatch
    XCTAssertTrue(message.waitForExistence(timeout: 10), "SCR-TEC-09 does not show the server's parts_required message")
    // The row opens the job's finish screen with the message (F-1025); the entries are the phone's, No parts used still on.
    refused.tap()
    XCTAssertTrue(el("fin.bar.title").waitForExistence(timeout: 20), "the refused finish did not open SCR-TEC-07")
    let finMessage = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Billing needs the parts used.")).firstMatch
    XCTAssertTrue(finMessage.waitForExistence(timeout: 10), "SCR-TEC-07 does not show the server's message")
    XCTAssertTrue(el("fin.bar.sub").label.hasPrefix(who), "the finish screen is not \(who)'s job: \(el("fin.bar.sub").label)")
    tapWhenReady("fin.finish")
    // The corrected finish goes on as it is: the rule that refused the finish ends just before it is confirmed (F-1580).
    _ = get("/rules/clear")
    tapWhenReady("fin.confirm.ok")
    XCTAssertTrue(label("sync.count", is: "All synced", within: 120), "the corrected finish was not sent: \(el("sync.count").label)")
    mark("REFUSED-FINISH-SENT key=\(key)")
  }
}
