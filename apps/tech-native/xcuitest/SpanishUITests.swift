// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-LANG-1, FR-LANG-3, FR-IOS-1
// The XCUITest Spanish walk (P6-XCUITEST): every native row of the page inventory (UI-SPECIFICATION section 2: SCR-TEC-01 to -10 but
// -11, which is web only, SCR-TEC-12 to -16 and SCR-EML-03) opened in Spanish in the shipped app, against the Compose stack through the
// signal relay. On each screen the test reads every text the accessibility tree holds (label, value, placeholder and title of each
// element, from 1 snapshot) and prints it as a NATIVE-ES-TEXT line; run.sh hands the log to ci/native/spanish-walk.ts, which fails a
// text that is an English catalog value (or holds one) where the Spanish value differs, a screen with no Spanish catalog value on it,
// and a row of the inventory the walk never reached. The language is the in-place control (CTL-CMP-03-01): on the sign-in screen
// for the signed-out rows (kept on the phone), on Me once signed in (Maria's profile is English). The walk ends back in English,
// signed out, so a class run after it on the same install starts as it would alone.
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_): BW_RELAY, BW_CONTROL.
import XCTest

/// The ids of views that draw a record's own typed words (sample data in English), skipped with their children.
private let DATA_IDS = ["job.hist", "job.note.", "job.cnote.text", "card.note.text"]

final class SpanishUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    // A Spanish phone (the device language and region). The app declares only English, so the system's and the map library's own words
    // (the scroll bar's "Horizontal scroll bar, 1 page") stay English here; the walk reads catalog values only (F-1212).
    app.launchArguments = ["-bwLook", "1", "-bwProbeControl", env["BW_CONTROL"] ?? "", "-bwServer", env["BW_RELAY"] ?? "",
      "-AppleLanguages", "(es)", "-AppleLocale", "es_US"]
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
  private func get(_ path: String) -> String {
    let url = URL(string: need("BW_CONTROL") + path)!
    var out = ""
    let done = expectation(description: path)
    URLSession.shared.dataTask(with: url) { d, r, e in
      XCTAssertNil(e, "control \(path)")
      XCTAssertEqual((r as? HTTPURLResponse)?.statusCode, 200, "control \(path)")
      out = String(data: d ?? Data(), encoding: .utf8) ?? ""
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 20)
    return out
  }

  private func waitFor(_ p: NSPredicate, _ e: XCUIElement, _ s: TimeInterval) -> Bool {
    XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: e)], timeout: s) == .completed
  }

  private func gone(_ id: String, within s: TimeInterval = 20) -> Bool { waitFor(NSPredicate(format: "exists == false"), el(id), s) }

  private func tapWhenReady(_ id: String, within s: TimeInterval = 30) {
    let e = el(id)
    XCTAssertTrue(e.waitForExistence(timeout: s), "\(id) not shown")
    e.tap() // XCUITest scrolls an element into view for its tap (a hittable check first fails a button below the fold)
  }

  private func shown(_ id: String, within s: TimeInterval = 30) {
    XCTAssertTrue(el(id).waitForExistence(timeout: s), "\(id) not shown")
  }

  /// iOS offers to save the password after a sign-in: Not Now. F-1820 (the F-1202 shape, TodayUITests.dismissSavePrompt): the sheet is in the
  /// accessibility tree about 0.2 s before its first frame and fades in for about 0.45 s, and a tap made in that entrance is dropped. So the tap
  /// waits out the entrance, the sheet must be gone after it, one still there is tapped once more, and one that outlasts that fails by name.
  private func dismissSavePrompt() {
    // F-1825: either label, waited for together (the sheet is in the device's language, and not yet in the tree at the first look)
    let sheet = app.staticTexts.matching(NSPredicate(format: "label IN %@", ["Save Password?", "¿Guardar contraseña?"])).firstMatch
    guard sheet.waitForExistence(timeout: 10) else { return } // the late-sheet wait TodayUITests uses
    Thread.sleep(forTimeInterval: 1)
    for _ in 1...2 {
      let notNow = app.buttons["Not Now"].exists ? app.buttons["Not Now"] : app.buttons["Ahora no"]
      if notNow.exists { notNow.tap() } else { app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 121, dy: 525)).tap() }
      let left = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: sheet)
      if XCTWaiter().wait(for: [left], timeout: 5) == .completed {
        Thread.sleep(forTimeInterval: 1)
        return
      }
    }
    XCTFail("the Save Password sheet stays over the app after 2 taps on Not Now")
  }

  /// Every text of the screen now drawn, from 1 snapshot of the app's accessibility tree, printed for ci/native/spanish-walk.ts.
  private func dump(_ row: String) {
    Thread.sleep(forTimeInterval: 2) // the screen's reads and its transition settle
    var texts = Set<String>()
    func walk(_ s: XCUIElementSnapshot) {
      // the rig's own seams (the sign-in fill buttons, the probe) are test controls, never shipped words
      if s.identifier.hasPrefix("fill.") || s.identifier.hasPrefix("probe.") { return }
      // the records' own words, typed by people in the sample data (a past visit's work, an office or customer note), are data, not the
      // app's words: no catalog translates them (FR-LANG-1 covers the app's words)
      if DATA_IDS.contains(where: { s.identifier.hasPrefix($0) }) { return }
      for t in [s.label, s.title, (s.value as? String) ?? "", s.placeholderValue ?? ""] {
        let v = t.trimmingCharacters(in: .whitespacesAndNewlines)
        if !v.isEmpty { texts.insert(v) }
      }
      for c in s.children { walk(c) }
    }
    do {
      walk(try app.snapshot())
    } catch {
      XCTFail("\(row): no snapshot of the screen (\(error))")
    }
    for t in texts.sorted() {
      let json = String(data: try! JSONSerialization.data(withJSONObject: [t]), encoding: .utf8)!
      print("NATIVE-ES-TEXT \(row) \(json)")
    }
    mark("ES-SCREEN \(row) texts=\(texts.count)")
  }

  // ---- the walk --------------------------------------------------------------------------------------------------------------------

  // why: FR-LANG-1, FR-LANG-3 every native page-inventory row opened in Spanish shows Spanish catalog values and no English one
  func test1EveryNativeScreenInSpanish() throws {
    app.launch()
    // Signed out: the sign-in screen's own language control (kept on the phone).
    shown("signin.submit", within: 60)
    tapWhenReady("signin.lang.es")
    Thread.sleep(forTimeInterval: 1)
    dump("SCR-TEC-01")
    tapWhenReady("signin.server")
    shown("srv.field.value")
    dump("SCR-TEC-12")
    tapWhenReady("srv.cancel")
    tapWhenReady("signin.forgot")
    shown("forgot.bar.title")
    dump("SCR-EML-03")
    tapWhenReady("forgot.bar.back")
    // Maria signs in (her profile is English); Me's control makes the app Spanish again, saved to her profile.
    // the fill seam (SignIn.tsx) is a test-only control, not always hittable by XCUITest's measure: tapped as TodayUITests's fill() does
    XCTAssertTrue(el("fill.maria").waitForExistence(timeout: 20), "no fill seam for maria")
    el("fill.maria").tap()
    Thread.sleep(forTimeInterval: 1)
    el("signin.h2").tap()
    tapWhenReady("signin.submit")
    dismissSavePrompt()
    tapWhenReady("tab.me", within: 60)
    tapWhenReady("me.lang.es")
    shown("me.profile.tx.b")
    dump("SCR-TEC-10")
    // SCR-TEC-09 by the Me screen's sync line (CTL-TEC-10-02).
    tapWhenReady("me.sync.tx.b")
    shown("wait.bar.title")
    dump("SCR-TEC-09")
    tapWhenReady("wait.bar.back")
    tapWhenReady("tab.parts")
    shown("parts.bar.title")
    dump("SCR-TEC-16")
    tapWhenReady("tab.map")
    shown("map.next", within: 60)
    dump("SCR-TEC-15")
    tapWhenReady("map.dir")
    shown("dir.time.tx.b", within: 60)
    dump("SCR-TEC-08")
    tapWhenReady("dir.bar.back")
    // Today and its next job: the card, the job, its sheets and its finish.
    tapWhenReady("tab.today")
    shown("today.title", within: 60)
    shown("card.omw")
    dump("SCR-TEC-02")
    tapWhenReady("card.open")
    shown("job.bar.title")
    dump("SCR-TEC-04")
    tapWhenReady("job.addnote")
    shown("note.value")
    dump("SCR-TEC-05")
    tapWhenReady("note.discard")
    XCTAssertTrue(gone("note.value"))
    tapWhenReady("job.addphoto")
    shown("photo.cancel")
    dump("SCR-TEC-06")
    tapWhenReady("photo.cancel")
    XCTAssertTrue(gone("photo.cancel"))
    tapWhenReady("job.omw")
    shown("sheet.go")
    dump("SCR-TEC-03")
    tapWhenReady("sheet.go")
    XCTAssertTrue(gone("sheet.go"))
    tapWhenReady("job.arrived")
    shown("sheet.go")
    dump("SCR-TEC-13")
    tapWhenReady("sheet.go")
    XCTAssertTrue(gone("sheet.go"))
    // No one home is offered on site (JobUITests test5's order)
    tapWhenReady("job.noh")
    shown("sheet.go")
    dump("SCR-TEC-14")
    tapWhenReady("sheet.cancel")
    XCTAssertTrue(gone("sheet.go"))
    tapWhenReady("job.finish")
    shown("fin.bar.title")
    dump("SCR-TEC-07")
    tapWhenReady("fin.bar.back")
    mark("ES-WALK-DONE")
    // Back to English, signed out: the next class on this install starts as it would alone.
    tapWhenReady("job.bar.back")
    tapWhenReady("tab.me")
    tapWhenReady("me.lang.en")
    tapWhenReady("me.signout")
    shown("signin.submit")
    tapWhenReady("signin.lang.en")
  }
}
