// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: NFR-06, FR-IOS-1
// The native accessibility audit (P7-A11Y): every native row of the page inventory (SCR-TEC-01 to -10 but -11, SCR-TEC-12 to -16 and
// SCR-EML-03) opened in the shipped app in English, against the Compose stack through the signal relay, and on each screen
// XCUIApplication.performAccessibilityAudit over every audit type except .contrast (BUILD_PLAN section 3 D-5, OA-84: contrast is
// not gated; the default .all holds it). Each issue is printed as a NATIVE-A11Y-ISSUE line (screen, audit type, element, detail) and a
// screen with any issue fails the test after the whole walk, so 1 run lists every screen's issues. The walk is SpanishUITests's, in English.
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_): BW_RELAY, BW_CONTROL.
import XCTest

@available(iOS 17.0, *)
final class AccessibilityUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!
  private var issues = 0
  private var skippedHits = [String: Int]()
  private var baseArgs = [String]()
  private var visited = [String]()
  private let largest = "accessibility-extra-extra-extra-large", normal = "large"

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    baseArgs = ["-bwLook", "1", "-bwProbeControl", env["BW_CONTROL"] ?? "", "-bwServer", env["BW_RELAY"] ?? ""]
    app.launchArguments = baseArgs
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

  private func reach(_ id: String, _ s: TimeInterval) -> Bool { el(id).waitForExistence(timeout: s) }

  private func tapWhenReady(_ id: String, within s: TimeInterval = 30) {
    XCTAssertTrue(reach(id, s), "\(id) not shown")
    el(id).tap()
  }

  private func shown(_ id: String, within s: TimeInterval = 30) {
    XCTAssertTrue(reach(id, s), "\(id) not shown")
  }

  private func dismissSavePrompt() {
    let prompt = app.staticTexts["Save Password?"]
    if prompt.waitForExistence(timeout: 2) {
      let notNow = app.buttons["Not Now"]
      if notNow.exists { notNow.tap() } else { app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 121, dy: 525)).tap() }
      Thread.sleep(forTimeInterval: 1)
    }
  }

  // ---- the one skip rule (owner ruling df67d7bd "Accept as iOS", row F-1642) ---------------------------------------------------------
  // iOS draws the job header dimmed behind a short sheet and the audit reports it as "Potentially inaccessible text" with no element. The
  // approved sheet look stays, so the audit skips ONLY that 1 kind of hit, ONLY while a sheet is open over the job page, ONLY on these 4
  // screens, and ONLY up to the count measured in .build/evidence/P8-APP-FIXES/f1642-facts.md. Anything else still fails the audit.
  static let sheetSkipMax = ["SCR-TEC-03": 3, "SCR-TEC-06": 2, "SCR-TEC-13": 3, "SCR-TEC-14": 2]
  static let potentiallyInaccessibleText = 2 // the audit type's rawValue as the facts file measured it

  /// Pure decision: is this hit the accepted one? No element (empty id and label, zero frame), audit type 2, a listed screen, a sheet open.
  static func isAcceptedSheetHit(row: String, auditType: Int, hasElement: Bool, id: String, label: String, frame: CGRect, sheetOpen: Bool) -> Bool {
    sheetOpen && sheetSkipMax[row] != nil && auditType == potentiallyInaccessibleText && !hasElement && id.isEmpty && label.isEmpty && frame == .zero
  }

  /// A check of the rule on plain values (run first by the audit test, so a run proves the rule it applies).
  static func ruleSelfCheck() -> [String] {
    var bad = [String]()
    func t(_ name: String, _ got: Bool, _ want: Bool) { if got != want { bad.append(name) } }
    let z = CGRect.zero
    t("accepted hit on a listed screen", isAcceptedSheetHit(row: "SCR-TEC-13", auditType: 2, hasElement: false, id: "", label: "", frame: z, sheetOpen: true), true)
    t("type 2 no-element hit on a screen not listed", isAcceptedSheetHit(row: "SCR-TEC-05", auditType: 2, hasElement: false, id: "", label: "", frame: z, sheetOpen: true), false)
    t("different type on a listed screen", isAcceptedSheetHit(row: "SCR-TEC-13", auditType: 4, hasElement: false, id: "", label: "", frame: z, sheetOpen: true), false)
    t("hit with an element", isAcceptedSheetHit(row: "SCR-TEC-13", auditType: 2, hasElement: true, id: "x", label: "y", frame: CGRect(x: 1, y: 1, width: 5, height: 5), sheetOpen: true), false)
    t("hit with an element but empty names", isAcceptedSheetHit(row: "SCR-TEC-13", auditType: 2, hasElement: true, id: "", label: "", frame: z, sheetOpen: true), false)
    t("no sheet open", isAcceptedSheetHit(row: "SCR-TEC-13", auditType: 2, hasElement: false, id: "", label: "", frame: z, sheetOpen: false), false)
    return bad
  }

  /// The audit of the screen now drawn: every type but .contrast (OA-84). Issues are printed and counted, never thrown.
  private func audit(_ row: String) {
    Thread.sleep(forTimeInterval: 2) // the screen's reads and its transition settle
    var n = 0
    var skipped = 0
    let sheetOpen = el("sheet.go").exists || el("photo.cancel").exists
    do {
      try app.performAccessibilityAudit(for: XCUIAccessibilityAuditType.all.subtracting(.contrast)) { issue in
        if Self.isAcceptedSheetHit(row: row, auditType: Int(issue.auditType.rawValue), hasElement: issue.element != nil, id: issue.element?.identifier ?? "", label: issue.element?.label ?? "", frame: issue.element?.frame ?? .zero, sheetOpen: sheetOpen) {
          skipped += 1
          print("NATIVE-A11Y-SKIPPED \(row) type=\(issue.auditType.rawValue) detail=\(issue.compactDescription) (df67d7bd, F-1642)")
          return true // skipped by the owner's ruling, counted below
        }
        n += 1
        let what = issue.element?.identifier ?? ""
        let label = issue.element?.label ?? ""
        print("NATIVE-A11Y-ISSUE \(row) type=\(issue.auditType.rawValue) id=\(what) label=\(label) detail=\(issue.compactDescription) kind=\(issue.element?.elementType.rawValue ?? 0) frame=\(issue.element?.frame ?? .zero) more=\(issue.detailedDescription)")
        return true // handled here: counted and printed, so 1 issue does not stop the walk
      }
    } catch {
      XCTFail("\(row): the audit did not run (\(error))")
    }
    // BW_A11Y_KEEP_SHOTS=<rows, comma separated> also keeps the screenshot of a named screen with no issue (evidence only: the count and the result are unchanged).
    let keep = (env["BW_A11Y_KEEP_SHOTS"] ?? "").split(separator: ",").map(String.init).contains(row)
    if n > 0 || keep { // the screen as drawn, kept with the result so an issue without an element can be placed by eye
      let shot = XCTAttachment(screenshot: app.screenshot())
      shot.name = "audit-\(row)"
      shot.lifetime = .keepAlways
      add(shot)
    }
    if skipped > 0 {
      skippedHits[row] = skipped
      mark("A11Y-SKIPPED \(row) count=\(skipped) max=\(Self.sheetSkipMax[row] ?? 0) (df67d7bd, F-1642)")
      if skipped > (Self.sheetSkipMax[row] ?? 0) { n += skipped - (Self.sheetSkipMax[row] ?? 0) } // more hidden text than measured: it does not ride the skip
    }
    issues += n
    mark("A11Y-SCREEN \(row) issues=\(n)")
  }

  private func launchApp() {
    app.launchArguments = baseArgs
    app.launch()
  }

  /// F-1627: the simulator's text size is set through the signal relay (xcrun simctl ui content_size on this Mac) and the app is closed and opened
  /// again: a running app does not redraw at a new size (measured), so the size takes effect on the launch. The session is kept on the phone.
  private func relaunchAt(_ size: String) {
    _ = get("/textsize?to=\(size)")
    app.terminate()
    launchApp()
  }

  private func textHeight() -> CGFloat { tree().filter { $0.elementType == .staticText }.reduce(0) { $0 + $1.frame.height } }

  /// The app closed and opened again (the session is kept on the phone), back on the next job's page.
  private func reopenJob() {
    app.terminate()
    launchApp()
    shown("today.title", within: 60)
    tapWhenReady("card.open")
    shown("job.bar.title")
  }

  // ---- the walk --------------------------------------------------------------------------------------------------------------------

  /// The walk of the 16 native screens (P7-A11Y); visit(row) runs on each screen once drawn. Ends signed out. A walk that does not reach all
  /// 16 screens fails (F-1627).
  /// finishUnsigned: the job is finished with no signature on the Finish screen (14.2 item 7); BW_A11Y_CUT_AFTER=<row> ends the walk after
  /// that row (the must-fail proof: a short walk is red).
  private func walk(finishUnsigned: Bool = false, _ visitRow: (String) -> Void) {
    let cutAfter = env["BW_A11Y_CUT_AFTER"] ?? ""
    func visit(_ row: String) -> Bool {
      visitRow(row)
      visited.append(row)
      if row == cutAfter { mark("WALK-CUT after \(row)") }
      return row == cutAfter
    }
    defer {
      XCTAssertEqual(visited.count, 16, "the walk reached \(visited.count) of 16 screens: \(visited.joined(separator: ","))")
      mark("WALK-SCREENS \(visited.count) of 16")
    }
    launchApp()
    shown("signin.submit", within: 60)
    if visit("SCR-TEC-01") { return }
    tapWhenReady("signin.server")
    shown("srv.field.value")
    if visit("SCR-TEC-12") { return }
    tapWhenReady("srv.cancel")
    tapWhenReady("signin.forgot")
    shown("forgot.bar.title")
    if visit("SCR-EML-03") { return }
    tapWhenReady("forgot.bar.back")
    XCTAssertTrue(el("fill.maria").waitForExistence(timeout: 20), "no fill seam for maria")
    el("fill.maria").tap()
    Thread.sleep(forTimeInterval: 1)
    el("signin.h2").tap()
    tapWhenReady("signin.submit")
    dismissSavePrompt()
    tapWhenReady("tab.me", within: 60)
    shown("me.profile.tx.b")
    if visit("SCR-TEC-10") { return }
    tapWhenReady("me.sync.tx.b")
    shown("wait.bar.title")
    if visit("SCR-TEC-09") { return }
    tapWhenReady("wait.bar.back")
    tapWhenReady("tab.parts")
    shown("parts.bar.title")
    if visit("SCR-TEC-16") { return }
    tapWhenReady("tab.map")
    shown("map.next", within: 60)
    if visit("SCR-TEC-15") { return }
    tapWhenReady("map.dir")
    shown("dir.time.tx.b", within: 60)
    if visit("SCR-TEC-08") { return }
    tapWhenReady("dir.bar.back")
    tapWhenReady("tab.today")
    shown("today.title", within: 60)
    shown("card.omw")
    if visit("SCR-TEC-02") { return }
    tapWhenReady("card.open")
    shown("job.bar.title")
    if visit("SCR-TEC-04") { return }
    tapWhenReady("job.addnote")
    shown("note.value")
    if visit("SCR-TEC-05") { return }
    tapWhenReady("note.discard")
    XCTAssertTrue(gone("note.value"))
    tapWhenReady("job.addphoto")
    shown("photo.cancel")
    if visit("SCR-TEC-06") { return }
    tapWhenReady("photo.cancel")
    XCTAssertTrue(gone("photo.cancel"))
    // A confirm sheet is audited, then the app is closed and opened again to take the step: after an audit the sheet's own buttons are off
    // the screen for a tap, and the dim area does not close it.
    tapWhenReady("job.omw")
    shown("sheet.go")
    if visit("SCR-TEC-03") { return }
    reopenJob()
    tapWhenReady("job.omw")
    tapWhenReady("sheet.go")
    XCTAssertTrue(gone("sheet.go"))
    tapWhenReady("job.arrived")
    shown("sheet.go")
    if visit("SCR-TEC-13") { return }
    reopenJob()
    tapWhenReady("job.arrived")
    tapWhenReady("sheet.go")
    XCTAssertTrue(gone("sheet.go"))
    tapWhenReady("job.noh")
    shown("sheet.go")
    if visit("SCR-TEC-14") { return }
    reopenJob()
    tapWhenReady("job.finish")
    shown("fin.bar.title")
    if visit("SCR-TEC-07") { return }
    if finishUnsigned {
      // 14.2 item 7 (plan item h): the pad is optional, so Finish succeeds with no signature on the Finish screen.
      XCTAssertFalse(el("fin.signed.text").exists, "the job is signed before the unsigned finish")
      let noParts = app.switches["fin.noparts.toggle"]
      XCTAssertTrue(noParts.waitForExistence(timeout: 10), "no No parts used switch")
      if noParts.value as? String != "1" { noParts.tap() }
      // Labor is the one other thing Finish needs: 2 hr 9 min typed in.
      tapWhenReady("fin.labor.row")
      for (id, text) in [("fin.labor.hours", "2"), ("fin.labor.minutes", "9")] {
        let f = el(id)
        XCTAssertTrue(f.waitForExistence(timeout: 10), "no \(id)")
        if f.frame.width > 120 { f.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap() } else { f.tap() }
        f.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: ((f.value as? String) ?? "").count + 2))
        f.typeText(text)
        el("fin.ghead.labor").tap()
      }
      tapWhenReady("fin.finish")
      tapWhenReady("fin.confirm.ok")
      XCTAssertTrue(waitFor(NSPredicate(format: "label == %@", "Done"), el("job.bar.status.text"), 30), "the job is not Done after Finish with no signature")
      mark("UNSIGNED-FINISHED job.bar.status.text=\(el("job.bar.status.text").label) fin.signed.text exists=\(el("fin.signed.text").exists)")
    } else {
      tapWhenReady("fin.bar.back")
    }
    mark("A11Y-WALK-DONE")
    // Signed out again, at the default text size: the next class on this install starts as it would alone.
    tapWhenReady("job.bar.back")
    tapWhenReady("tab.me")
    tapWhenReady("me.signout")
    shown("signin.submit")
  }

  /// F-1627 / 14.2 item 2: the walk at the largest accessibility text size. The phone is signed in at the default size (the sign-in form cannot be
  /// operated at the largest, F-1617), the size is raised and the app opened again, and every screen reachable by a tap is measured. A screen that
  /// cannot be reached is a NATIVE-TOOLS-ISSUE check=reach line (never a silent pass); all 16 screens must be measured or named as unreachable.
  private func walkLargest(_ visitRow: (String) -> Void) {
    var unreached = [String]()
    defer {
      XCTAssertEqual(visited.count + unreached.count, 16, "the walk accounted for \(visited.count + unreached.count) of 16 screens")
      mark("WALK-SCREENS measured \(visited.count) unreachable \(unreached.count) of 16: \(unreached.joined(separator: ","))")
    }
    func measure(_ row: String) { visitRow(row); visited.append(row) }
    func skip(_ row: String, _ why: String) {
      unreached.append(row)
      issue("reach", row, "the screen cannot be reached at the largest text size: \(why)")
    }
    /// A tap target usable at this size: it exists and can be tapped, after scrolling the screen up if it scrolls (the tab bar covers the rest).
    func usable(_ id: String, within s: TimeInterval = 20) -> Bool {
      guard reach(id, s) else { return false }
      for _ in 0..<6 where !el(id).isHittable { app.swipeUp() }
      return el(id).isHittable
    }
    func tapUsable(_ id: String) {
      XCTAssertTrue(usable(id), "\(id) cannot be tapped at the largest text size")
      el(id).tap()
    }
    launchApp()
    shown("signin.submit", within: 60)
    XCTAssertTrue(el("fill.maria").waitForExistence(timeout: 20), "no fill seam for maria")
    el("fill.maria").tap()
    Thread.sleep(forTimeInterval: 1)
    el("signin.h2").tap()
    tapWhenReady("signin.submit")
    dismissSavePrompt()
    shown("today.title", within: 60)
    let small = textHeight()
    relaunchAt(largest)
    shown("today.title", within: 60)
    let large = textHeight()
    mark("TEXT-SIZES today text height default=\(Int(small)) largest=\(Int(large))")
    XCTAssertGreaterThan(large, small * 1.2, "the app did not draw at the largest text size")
    // Signed out screens: the form cannot be reached once signed in, so these are measured from the signed-out state after the walk below.
    tapWhenReady("tab.me", within: 60)
    shown("me.profile.tx.b")
    measure("SCR-TEC-10")
    tapWhenReady("me.sync.tx.b")
    shown("wait.bar.title")
    measure("SCR-TEC-09")
    tapWhenReady("wait.bar.back")
    tapWhenReady("tab.parts")
    shown("parts.bar.title")
    measure("SCR-TEC-16")
    tapWhenReady("tab.map")
    shown("map.next", within: 60)
    measure("SCR-TEC-15")
    if usable("map.dir") {
      el("map.dir").tap()
      shown("dir.time.tx.b", within: 60)
      measure("SCR-TEC-08")
      tapWhenReady("dir.bar.back")
    } else { skip("SCR-TEC-08", "map.dir is under the tab bar") }
    tapWhenReady("tab.today")
    shown("today.title", within: 60)
    shown("card.omw")
    measure("SCR-TEC-02")
    tapWhenReady("card.open")
    shown("job.bar.title")
    measure("SCR-TEC-04")
    // The job's own screens, reached as the default walk reaches them, each control after scrolling the page to it (a control that still
    // cannot be tapped is a check=reach finding). A sheet is measured, then the app is opened again to take the step.
    func reopen() { reopenJob() }
    if usable("job.addnote") {
      el("job.addnote").tap()
      shown("note.value")
      measure("SCR-TEC-05")
      tapUsable("note.discard")
      XCTAssertTrue(gone("note.value"))
    } else { skip("SCR-TEC-05", "job.addnote cannot be tapped from the job page") }
    if usable("job.addphoto") {
      el("job.addphoto").tap()
      shown("photo.cancel")
      measure("SCR-TEC-06")
      tapUsable("photo.cancel")
      XCTAssertTrue(gone("photo.cancel"))
    } else { skip("SCR-TEC-06", "job.addphoto cannot be tapped from the job page") }
    if usable("job.omw") {
      el("job.omw").tap()
      shown("sheet.go")
      measure("SCR-TEC-03")
      reopen()
      tapUsable("job.omw")
      tapUsable("sheet.go")
      XCTAssertTrue(gone("sheet.go"))
    } else { skip("SCR-TEC-03", "job.omw cannot be tapped from the job page") }
    if usable("job.arrived") {
      el("job.arrived").tap()
      shown("sheet.go")
      measure("SCR-TEC-13")
      reopen()
      tapUsable("job.arrived")
      tapUsable("sheet.go")
      XCTAssertTrue(gone("sheet.go"))
    } else { skip("SCR-TEC-13", "job.arrived cannot be tapped from the job page") }
    if usable("job.noh") {
      el("job.noh").tap()
      shown("sheet.go")
      measure("SCR-TEC-14")
      reopen()
    } else { skip("SCR-TEC-14", "job.noh cannot be tapped from the job page") }
    if usable("job.finish") {
      el("job.finish").tap()
      shown("fin.bar.title")
      measure("SCR-TEC-07")
      tapWhenReady("fin.bar.back")
    } else { skip("SCR-TEC-07", "job.finish cannot be tapped from the job page") }
    tapWhenReady("job.bar.back")
    // Back at the default size: signed out, so the 2 signed-out screens and the sign-in form are measured where they can be.
    tapWhenReady("tab.me")
    tapWhenReady("me.signout")
    shown("signin.submit", within: 30)
    measure("SCR-TEC-01")
    if usable("signin.server") {
      el("signin.server").tap()
      shown("srv.field.value")
      measure("SCR-TEC-12")
      tapWhenReady("srv.cancel")
    } else { skip("SCR-TEC-12", "signin.server cannot be tapped from the sign-in form") }
    if usable("signin.forgot") {
      el("signin.forgot").tap()
      shown("forgot.bar.title")
      measure("SCR-EML-03")
      tapWhenReady("forgot.bar.back")
    } else { skip("SCR-EML-03", "signin.forgot cannot be tapped from the sign-in form") }
  }

  // why: NFR-06 the native accessibility audit (every audit type but .contrast, OA-84) finds no issue on any native screen; why: F-1642 the only skipped hit is the no-element text hit under a sheet on 4 screens (df67d7bd), counted and capped
  func test1AccessibilityAuditOfEveryNativeScreen() throws {
    XCTAssertEqual(Self.ruleSelfCheck(), [], "the sheet-hit skip rule decides wrongly")
    mark("A11Y-SKIP-RULE-SELFCHECK ok")
    walk { audit($0) }
    mark("A11Y-SKIPPED-TOTAL \(skippedHits.values.reduce(0, +)) \(skippedHits.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))")
    XCTAssertEqual(issues, 0, "the audit found \(issues) issue(s); each is a NATIVE-A11Y-ISSUE line")
  }

  // ---- the tools checks (P8-A11Y-TOOLS): BUILD_PLAN P8-A11Y-TOOLS items (e) to (h), UI-SPECIFICATION 14.2 items 1, 2, 4, 5, 6, 7 -------------
  // run.sh runs each in its own pass (BW_A11Y_METHOD) with the simulator's text size or Reduce Motion set around it (BW_A11Y_TEXT, BW_A11Y_REDUCE).
  // Every finding is a NATIVE-TOOLS-ISSUE line; a method fails after its walk when it printed any. BW_A11Y_METHOD=testPlants runs testPlants alone; BW_A11Y_CUT_AFTER=<row> ends a walk early (a short walk fails).

  private var toolIssues = 0
  private func issue(_ check: String, _ row: String, _ what: String) {
    toolIssues += 1
    print("NATIVE-TOOLS-ISSUE check=\(check) \(row) \(what)")
  }

  private func flat(_ s: XCUIElementSnapshot, _ into: inout [XCUIElementSnapshot]) {
    into.append(s)
    for c in s.children { flat(c, &into) }
  }

  private func tree() -> [XCUIElementSnapshot] {
    var all = [XCUIElementSnapshot]()
    if let s = try? app.snapshot() { flat(s, &all) }
    return all
  }

  private let controlTypes: Set<XCUIElement.ElementType> = [.button, .switch, .textField, .secureTextField, .slider, .searchField, .link, .tab]
  private let statusWords = ["Canceled", "Done", "No one home", "On site", "On the way", "Scheduled", "Late", "At risk"]
  private let backOf = ["SCR-EML-03": "forgot.bar.back", "SCR-TEC-09": "wait.bar.back", "SCR-TEC-08": "dir.bar.back", "SCR-TEC-04": "job.bar.back", "SCR-TEC-07": "fin.bar.back"]
  private let sheets = ["SCR-TEC-03", "SCR-TEC-13", "SCR-TEC-14"]

  /// 14.2 items 1, 4, 6, 7 on the screen now drawn.
  private func structureOf(_ row: String) {
    Thread.sleep(forTimeInterval: 1.5)
    let t = tree()
    mark("STRUCT-SCREEN \(row) elements=\(t.count)")
    for e in t where controlTypes.contains(e.elementType) && e.label.isEmpty && e.identifier != "" {
      issue("label", row, "control without a label: type=\(e.elementType.rawValue) id=\(e.identifier)")
    }
    for e in t {
      for text in [e.label, e.value as? String ?? "", e.placeholderValue ?? "", e.title] where text.lowercased().contains("demo") {
        issue("no-demo", row, "the word demo in id=\(e.identifier) text=\(text)")
      }
    }
    if let back = backOf[row], !el(back).exists { issue("navigation", row, "no Back button \(back) on a pushed screen") }
    if sheets.contains(row), !el("sheet.go").exists { issue("navigation", row, "the confirm step is not a sheet with its go button") }
    if ["SCR-TEC-02", "SCR-TEC-10", "SCR-TEC-15", "SCR-TEC-16"].contains(row) {
      let names = ["tab.map", "tab.me", "tab.parts", "tab.today"].map { "\($0)=\(el($0).exists ? el($0).label : "missing")" }
      mark("STRUCT-TABS \(row) \(names.joined(separator: ","))")
      let want = ["tab.map=Map", "tab.me=Me", "tab.parts=Parts", "tab.today=Today"]
      if names != want { issue("navigation", row, "tab bar is \(names), expected \(want)") }
    }
    if row == "SCR-TEC-02" || row == "SCR-TEC-04" {
      let carriers = t.filter { e in statusWords.contains { e.label.contains($0) } && (controlTypes.contains(e.elementType) || e.elementType == .staticText || e.elementType == .other) }
      mark("STRUCT-STATUS \(row) \(carriers.prefix(4).map { "\($0.elementType.rawValue):\($0.label)" }.joined(separator: " | "))")
      if carriers.isEmpty { issue("label", row, "no element carries a status word in its label") }
    }
    if row == "SCR-TEC-07" {
      let label = el("fin.sig").label
      mark("STRUCT-SIG label=\(label)")
      if !label.lowercased().contains("optional") { issue("signature", row, "the signature pad label does not say optional: \(label)") }
    }
  }

  // why: NFR-06 UI-SPECIFICATION 14.2 items 1, 4, 6, 7: label and trait on every control, the status word in a label, HIG navigation, no word demo, the signature pad optional
  func test2Structure() throws {
    walk(finishUnsigned: true) { structureOf($0) }
    XCTAssertEqual(toolIssues, 0, "the structure checks found \(toolIssues) issue(s); each is a NATIVE-TOOLS-ISSUE line")
  }

  /// 14.2 item 2 on the screen now drawn: the audit's clipped-text and Dynamic Type checks, and no text outside the screen's width.
  private func textSizeOf(_ row: String) {
    Thread.sleep(forTimeInterval: 2)
    var n = 0
    do {
      try app.performAccessibilityAudit(for: [.textClipped, .dynamicType]) { i in
        n += 1
        self.issue("text-size", row, "audit type=\(i.auditType.rawValue) id=\(i.element?.identifier ?? "") label=\(i.element?.label ?? "") detail=\(i.compactDescription)")
        return true
      }
    } catch { XCTFail("\(row): the audit did not run (\(error))") }
    let width = app.frame.width
    for e in tree() where [.staticText, .button, .textField].contains(e.elementType) && !e.label.isEmpty && e.frame.width > 0 && !e.identifier.hasPrefix("fill.") {
      if e.frame.minX < -1 || e.frame.maxX > width + 1 { issue("text-size", row, "off the screen sideways: id=\(e.identifier) \(Int(e.frame.minX)) to \(Int(e.frame.maxX)) of \(Int(width))") }
    }
    if row == "SCR-TEC-04" {
      // The job's step buttons must be operable at the largest size: reachable by a tap, after scrolling the page if it scrolls.
      for id in ["job.omw", "job.arrived", "job.noh", "job.finish"] where el(id).exists {
        for _ in 0..<3 where !el(id).isHittable { app.swipeUp() }
        if !el(id).isHittable { issue("text-size", row, "control \(id) cannot be tapped at the largest size (frame \(el(id).frame), screen height \(Int(app.frame.height)))") }
        for _ in 0..<3 { app.swipeDown() }
      }
    }
    mark("TEXT-SCREEN \(row) audit=\(n)")
  }

  // why: NFR-06 UI-SPECIFICATION 14.2 item 2 the largest accessibility Dynamic Type size shows no truncation on any native screen
  func test3LargestTextSize() throws {
    // F-1627: the size is raised after sign-in and the app opened again; it always puts the size back.
    defer { _ = get("/textsize?to=\(normal)") }
    walkLargest { textSizeOf($0) }
    XCTAssertEqual(toolIssues, 0, "the text-size checks found \(toolIssues) issue(s); each is a NATIVE-TOOLS-ISSUE line")
  }

  private func pixels(_ img: UIImage) -> [UInt8] {
    guard let cg = img.cgImage else { return [] }
    let w = cg.width, h = cg.height
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    buf.withUnsafeMutableBytes { p in
      let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      ctx?.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return buf
  }

  private func changed(_ a: UIImage, _ b: UIImage) -> Int {
    let x = pixels(a), y = pixels(b)
    guard x.count == y.count, !x.isEmpty else { return -1 }
    var n = 0
    for i in stride(from: 0, to: x.count, by: 4) where abs(Int(x[i]) - Int(y[i])) > 24 || abs(Int(x[i + 1]) - Int(y[i + 1])) > 24 || abs(Int(x[i + 2]) - Int(y[i + 2])) > 24 { n += 1 }
    return n
  }

  /// The busy ring on the server check's button (the kit's Spinner, the only animation in the app's source): frames 0.15 s apart; how many pixels differ.
  private func spinnerMovement() -> Int {
    app.launch()
    shown("signin.submit", within: 60)
    tapWhenReady("signin.server")
    shown("srv.field.value")
    _ = get("/delay?ms=8000") // the next request is held 8 s: the button stays busy
    tapWhenReady("srv.check")
    XCTAssertTrue(el("srv.check.spin").waitForExistence(timeout: 10), "the busy ring did not show")
    var shots = [UIImage]()
    for _ in 0..<6 { shots.append(el("srv.check").screenshot().image); Thread.sleep(forTimeInterval: 0.15) }
    let diffs = (1..<shots.count).map { changed(shots[$0 - 1], shots[$0]) }
    mark("MOTION-SPINNER diffs=\(diffs)")
    return diffs.max() ?? 0
  }

  // why: NFR-06 UI-SPECIFICATION 14.2 item 5 and 14.1 item 13 with Reduce Motion on nothing in the app animates but the map's van marker
  func test4ReduceMotion() throws {
    let on = UIAccessibility.isReduceMotionEnabled
    let expectOn = env["BW_A11Y_REDUCE"] == "on"
    mark("MOTION-SETTING reduce=\(on)")
    XCTAssertEqual(on, expectOn, "the simulator's Reduce Motion is \(on), the pass wants \(expectOn)")
    let moved = spinnerMovement()
    if on && moved > 12 { issue("reduce-motion", "SCR-TEC-12", "the busy ring still turns under Reduce Motion (\(moved) pixels changed between frames)") }
    if !on && moved <= 12 { issue("detector", "SCR-TEC-12", "the baseline (Reduce Motion off) saw no motion: the detector does not fire (\(moved))") }
    XCTAssertEqual(toolIssues, 0, "see NATIVE-TOOLS-ISSUE")
  }

  // why: NFR-06 each native tools check fires on a planted wrong expectation (BUILD_PLAN P8-A11Y-TOOLS must-fail rule)
  func testPlants() throws {
    continueAfterFailure = true
    app.launch()
    shown("signin.submit", within: 60)
    let cat = UIApplication.shared.preferredContentSizeCategory
    print("PLANT-text expects the default text size, sim is \(cat.rawValue)")
    XCTAssertEqual(cat, UIContentSizeCategory.large, "PLANT-text")
    print("PLANT-structure expects the sign-in button to say demo")
    XCTAssertTrue(el("signin.submit").label.lowercased().contains("demo"), "PLANT-structure")
    tapWhenReady("signin.server")
    shown("srv.field.value")
    _ = get("/delay?ms=8000")
    tapWhenReady("srv.check")
    XCTAssertTrue(el("srv.check.spin").waitForExistence(timeout: 10))
    let a = el("srv.check").screenshot().image
    Thread.sleep(forTimeInterval: 0.3)
    let moved = changed(a, el("srv.check").screenshot().image)
    print("PLANT-motion expects a still busy ring, pixels changed \(moved)")
    XCTAssertLessThanOrEqual(moved, 0, "PLANT-motion")
  }
}
