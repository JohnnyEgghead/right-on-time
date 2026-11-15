// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-5, FR-TECH-3, FR-LANG-1, F-1233, F-1235, F-1236, F-1369, F-1371, FR-TECH-13, d6bfc18c
// The turn-by-turn Directions suite (P6-NATIVE-STEPS Acceptance), run by xcuitest/run.sh with BW_NATIVE_TESTS=StepsUITests in the iOS
// Simulator on the owner's Mac against the Compose stack (Docker context desktop-linux, built from this checkout: API-104's steps are newer
// than the phase 5 tag), with the routing service down (F-1392: live routing would answer Linda's leg), through the signal relay. run.sh sets the stack up for it: Maria Santos's profile
// language is Spanish (a Spanish-speaking technician), Harold Jenkins's job holds 5 stored photos (API-103: 1 more than the photo row
// shows in view), the baked legs into Linda Miller's job are removed (so the server has no track for it: the Approximate state), and the
// expected words, distances and turn points of the route from the van to Harold's job (Directions on a job is the drive to THAT job, F-1369:
// API-104 with no fromJob), worded by the shared step words (xcuitest/steps-expect.mjs). The tests run in
// name order on 1 fresh install:
//   test1  the relay's address saved and Maria signed in; the app follows her profile into Spanish
//   test2  Directions from Harold's job, in Spanish: the same steps in Spanish, the first marked Ahora, the Next turn card
//   test3  in English (Me's language control): every step in driving order with its words and distance, the first marked Now, the Next
//          turn card, the next-turn marker on the map, a picked step centers the map on its turn, Show the whole route; the look dump
//   test4  with no signal after that read: the kept steps under "Steps from <time>", no step marked Now, no Next turn card
//   test5  Directions from Linda's job (a later job of the day): the route ends at Linda's address, which no routing service answers
//          (it is not started, whatever the map folder holds) and the bake does not hold: the Approximate state
//   test6  Harold's job shows Photos (5) over a row of its own, 72 x 54 tiles, 4 in view, that scrolls to the 5th photo; every tile reads
//          the small copy, the viewer the whole file (run.sh counts the relay's RELAY-FILE lines); the look dump of SCR-TEC-04 Success
//   test7  Directions on Harold's job is the drive to his job: the button's minutes, the route's destination and last step, More's item
//   test8  the main button is pinned above the tab bar: On my way shows on the first view, and stays while the photos row scrolls in
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_): BW_RELAY, BW_CONTROL, BW_JOB (Harold's), BW_NEXT_JOB (Linda's), BW_MINUTES, BW_STREET (Harold's), BW_NEXT_STREET (Linda's), and from
// steps-expect.mjs BW_STEPS_EN, BW_STEPS_ES, BW_DIST_EN (each | separated), BW_NEXT_EN, BW_NEXT_ES, BW_TURN_AT, BW_PICK_AT ("lon,lat").
import XCTest

final class StepsUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    launchFor(env["BW_JOB"] ?? "0")
  }

  private func launchFor(_ job: String) {
    app.launchArguments = ["-bwLook", "1", "-bwProbe", "1", "-bwProbeJob", job, "-bwProbeControl", env["BW_CONTROL"] ?? ""]
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------------------

  private func need(_ name: String) -> String {
    guard let v = env[name], !v.isEmpty else { XCTFail("missing \(name)"); return "" }
    return v
  }

  private func mark(_ what: String) {
    print("NATIVE-\(what)")
  }

  private func el(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  @discardableResult
  private func control(_ path: String, status: Int = 200) -> Data {
    let url = URL(string: need("BW_CONTROL") + path)!
    let done = expectation(description: path)
    var body = Data()
    URLSession.shared.dataTask(with: url) { d, r, e in
      XCTAssertNil(e, "control \(path)")
      XCTAssertEqual((r as? HTTPURLResponse)?.statusCode, status, "control \(path): \(String(data: d ?? Data(), encoding: .utf8) ?? "")")
      body = d ?? Data()
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 20)
    mark("CONTROL \(path.components(separatedBy: "?")[0])")
    return body
  }

  private func waitFor(_ p: String, _ el: XCUIElement, _ s: TimeInterval) -> Bool {
    XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: p), object: el)], timeout: s) == .completed
  }
  private func labelIs(_ el: XCUIElement, _ text: String, within s: TimeInterval = 20) -> Bool {
    XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", text), object: el)], timeout: s) == .completed
  }
  private func gone(_ el: XCUIElement, within s: TimeInterval = 10) -> Bool { waitFor("exists == false", el, s) }

  /// The look dump of the state on screen is written 0.9 s after it settles (src/ui/look.ts).
  private func settle() {
    Thread.sleep(forTimeInterval: 2.5)
  }

  private func tapWhenReady(_ id: String, within s: TimeInterval = 20) {
    let e = el(id)
    XCTAssertTrue(e.waitForExistence(timeout: s), "\(id) not shown")
    e.tap()
  }

  private func tab(_ name: String) {
    let t = el("tab.\(name)")
    XCTAssertTrue(t.waitForExistence(timeout: 60), "tab \(name) not shown")
    for _ in 0..<4 {
      t.tap()
      if t.isSelected { break }
      Thread.sleep(forTimeInterval: 1)
    }
  }

  private func replace(_ field: XCUIElement, with text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap()
    let current = (field.value as? String) ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
    field.typeText(text)
  }

  private func launchToToday(signal: Bool = true) {
    if signal { control("/signal/on") }
    app.launch()
    XCTAssertTrue(el("probe.openJob").waitForExistence(timeout: 60), "Today with the probe not shown")
  }

  /// The probe's job (Harold Jenkins's, or the job launchFor named), then its Directions (CTL-TEC-04-04: the drive from the van to that job).
  private func openDirections(customer: String?) {
    tapWhenReady("probe.openJob", within: 60)
    if let c = customer { XCTAssertTrue(labelIs(el("job.bar.title"), c, within: 30), "SCR-TEC-04 not shown: \(el("job.bar.title").label)") }
    tapWhenReady("job.dir", within: 60)
    XCTAssertTrue(el("dir.bar.title").waitForExistence(timeout: 20), "CTL-TEC-08 Directions did not open")
  }

  /// The words of every step row shown, in driving order (dir.step.<i>.words, then the arrival's).
  private func shownWords(count: Int) -> [String] {
    var out: [String] = []
    for i in 0..<(count - 1) { out.append(el("dir.step.\(i).words").label) }
    out.append(el("dir.step.arrive.words").label)
    return out
  }

  private func shownDistances(count: Int) -> [String] {
    var out: [String] = []
    for i in 0..<(count - 1) { out.append(el("dir.step.\(i).v").label) }
    out.append(el("dir.step.arrive.v").exists ? el("dir.step.arrive.v").label : "")
    return out
  }

  /// The map's status line (NativeMap.tsx): "... center=<lon>,<lat> turn=<lon>,<lat>|none".
  private func status(_ key: String) -> String? {
    for part in el("dir.map.status").label.split(separator: " ") {
      let kv = part.split(separator: "=", maxSplits: 1)
      if kv.count == 2 && kv[0] == Substring(key) { return String(kv[1]) }
    }
    return nil
  }

  private func point(_ s: String?) -> (Double, Double)? {
    guard let s else { return nil }
    let p = s.split(separator: ",").compactMap { Double($0) }
    return p.count == 2 ? (p[0], p[1]) : nil
  }

  /// Waits until the map's center is within `tol` degrees of `at` (or, `away`, further than that).
  private func centered(on at: (Double, Double), away: Bool = false, tol: Double = 0.0006, within s: TimeInterval = 30) -> Bool {
    let deadline = Date().addingTimeInterval(s)
    while Date() < deadline {
      if let c = point(status("center")) {
        let near = abs(c.0 - at.0) < tol && abs(c.1 - at.1) < tol
        if near != away { return true }
      }
      Thread.sleep(forTimeInterval: 1)
    }
    mark("MAP-STATUS \(el("dir.map.status").label)")
    return false
  }

  // ---- the suite -----------------------------------------------------------------------------------------------------------------

  // why: FR-IOS-3, FR-LANG-1 the app's server is the relay in front of the stack, and Maria, whose profile says Spanish, signs in through it
  func test1ServerAndSignIn() throws {
    control("/signal/on")
    control("/rules/clear")
    app.launch()
    let row = app.buttons["signin.server"]
    XCTAssertTrue(row.waitForExistence(timeout: 30), "sign-in screen not shown")
    row.tap()
    replace(app.textFields["srv.field.value"], with: need("BW_RELAY"))
    app.buttons["srv.check"].tap()
    XCTAssertTrue(waitFor("label CONTAINS 'Right On Time'", app.staticTexts["srv.ok.text"], 30))
    app.buttons["srv.save"].tap()
    tapWhenReady("probe.signin", within: 20)
    XCTAssertTrue(el("tab.today").waitForExistence(timeout: 60), "Today not shown after sign-in")
    XCTAssertTrue(waitFor("label CONTAINS 'Hoy'", el("tab.today"), 20), "the app did not follow Maria's Spanish profile: \(el("tab.today").label)")
    mark("SIGNED-IN es")
  }

  // why: FR-TECH-5, FR-LANG-1 CTL-TEC-08-05, -06 signed in as a Spanish-speaking technician, the same steps read in Spanish, the first marked Now (Ahora)
  func test2StepsInSpanish() throws {
    launchToToday()
    openDirections(customer: "Harold Jenkins")
    let want = need("BW_STEPS_ES").components(separatedBy: "|")
    XCTAssertTrue(el("dir.steps").waitForExistence(timeout: 60), "CTL-TEC-08-06 no Steps list")
    XCTAssertTrue(el("dir.step.arrive.words").waitForExistence(timeout: 20), "the arrival step is not listed")
    XCTAssertEqual(shownWords(count: want.count), want, "the steps in Spanish")
    XCTAssertFalse(el("dir.step.\(want.count - 1).words").exists, "more steps than the leg holds")
    XCTAssertTrue(labelIs(el("dir.step.0.now.text"), "Ahora"), "the first step is not marked Ahora")
    XCTAssertFalse(el("dir.step.1.now").exists, "a second step is marked Now")
    XCTAssertTrue(labelIs(el("dir.next"), need("BW_NEXT_ES")), "CTL-TEC-08-05 Next turn: \(el("dir.next").label)")
    XCTAssertTrue(labelIs(el("dir.bar.title"), "Cómo llegar"))
    mark("STEPS-ES \(want.count) steps")
  }

  // why: FR-TECH-5, FR-MAP-1 CTL-TEC-08-01, -05, -06, -07 the steps in driving order with words and distances, the first marked Now, the Next turn card, the next-turn marker, a picked step centers the map and Show the whole route frames it again
  func test3StepsInEnglishMapAndLook() throws {
    launchToToday()
    tab("me")
    tapWhenReady("me.lang.en", within: 60)
    XCTAssertTrue(waitFor("label CONTAINS 'Today'", el("tab.today"), 20), "the language control did not switch to English")
    tab("today")
    openDirections(customer: "Harold Jenkins")
    let want = need("BW_STEPS_EN").components(separatedBy: "|")
    let dist = need("BW_DIST_EN").components(separatedBy: "|")
    XCTAssertTrue(el("dir.step.arrive.words").waitForExistence(timeout: 60), "CTL-TEC-08-06 the Steps list is not shown")
    XCTAssertEqual(shownWords(count: want.count), want, "the steps, in driving order")
    XCTAssertEqual(shownDistances(count: want.count), dist, "each step's distance (the arrival has none)")
    XCTAssertTrue(labelIs(el("dir.step.0.now.text"), "Now"), "the first step is not marked Now")
    XCTAssertEqual(el("dir.step.0").value as? String, "now")
    XCTAssertEqual(el("dir.step.1").value as? String, "step")
    XCTAssertTrue(labelIs(el("dir.next"), need("BW_NEXT_EN")), "CTL-TEC-08-05 Next turn: \(el("dir.next").label)")
    XCTAssertTrue(waitFor("label BEGINSWITH 'About '", el("dir.time.tx.b"), 20), "CTL-TEC-08-03 drive time")
    // the map: drawn, with its next-turn marker at the second step's turn
    XCTAssertTrue(el("dir.map.status").waitForExistence(timeout: 90), "the map did not start drawing")
    XCTAssertTrue(waitFor("label CONTAINS 'turn=\(need("BW_TURN_AT"))'", el("dir.map.status"), 60), "CTL-TEC-08-01 next-turn marker: \(el("dir.map.status").label)")
    settle() // the look dump of the Route frame's state
    mark("STEPS-EN \(want.count) steps, \(el("dir.next").label)")
    // CTL-TEC-08-06: a picked step centers the map on its turn; CTL-TEC-08-07 frames the whole route again
    let pick = point(need("BW_PICK_AT"))!
    XCTAssertTrue(el("dir.step.2").isHittable, "the third step is not in view (3 steps show above the tab bar)")
    el("dir.step.2").tap()
    XCTAssertTrue(centered(on: pick), "the map did not center on the picked step's turn")
    tapWhenReady("dir.fit")
    XCTAssertTrue(centered(on: pick, away: true), "Show the whole route did not move the map back")
    mark("PICKED-STEP centered, fit")
  }

  // why: FR-TECH-5 UI-SPECIFICATION 4.5 rule 11 after a read and then no signal, the kept steps show under Steps from that read's time, with no step marked Now and no Next turn card
  func test4KeptStepsWithNoSignal() throws {
    launchToToday()
    openDirections(customer: "Harold Jenkins") // a read with signal: the route is kept for this destination
    XCTAssertTrue(el("dir.step.arrive.words").waitForExistence(timeout: 60))
    el("dir.bar.back").tap() // Back leaves Directions for the Today tab, whose stack still holds Harold's job
    control("/signal/off")
    if !el("job.dir").waitForExistence(timeout: 10) { tapWhenReady("probe.openJob", within: 30) }
    tapWhenReady("job.dir", within: 60)
    let want = need("BW_STEPS_EN").components(separatedBy: "|")
    // the head is drawn in capitals (.ghead text-transform), which its label carries: compared in any case
    XCTAssertTrue(waitFor("label BEGINSWITH[c] 'Steps from '", el("dir.ghead"), 60), "Offline, steps saved: the head is \(el("dir.ghead").label)")
    XCTAssertNotNil(el("dir.ghead").label.range(of: #"^Steps from \d{1,2}:\d{2} (AM|PM)$"#, options: [.regularExpression, .caseInsensitive]), el("dir.ghead").label)
    XCTAssertEqual(shownWords(count: want.count), want, "the kept steps")
    XCTAssertFalse(el("dir.step.0.now").exists, "a kept step is marked Now")
    XCTAssertFalse(el("dir.next").exists, "the Next turn card shows with no signal")
    XCTAssertTrue(waitFor("label BEGINSWITH 'The map needs signal'", el("dir.need"), 20), "the map's no-signal words")
    mark("KEPT-STEPS \(el("dir.ghead").label)")
    control("/signal/on")
  }

  // why: FR-TECH-5, FR-MAP-3 a leg the routing service cannot answer and the bake does not hold shows the Approximate state: the labeled line, no drive time, no Next turn, the not-available words
  func test5ApproximateLeg() throws {
    launchFor(need("BW_NEXT_JOB"))
    launchToToday()
    openDirections(customer: nil)
    XCTAssertTrue(waitFor("label BEGINSWITH 'Turn-by-turn steps are not available right now. Head to '", el("dir.noturn.text"), 60),
                  "the Approximate state's words: \(el("dir.noturn.text").label)")
    // F-1369: from a later job of the day the route ends at THAT job's address (Linda's), not the job after it
    XCTAssertTrue(labelIs(el("dir.dest.who.tx.b"), "Linda Miller"), "the destination: \(el("dir.dest.who.tx.b").label)")
    XCTAssertTrue(el("dir.noturn.text").label.contains(need("BW_NEXT_STREET")), "the route does not end at Linda's address: \(el("dir.noturn.text").label)")
    XCTAssertTrue(labelIs(el("dir.approx"), "Approximate route"), "CTL-CMP-05-05 the line's label")
    XCTAssertFalse(el("dir.time").exists, "a drive time shows on an approximate route")
    XCTAssertFalse(el("dir.next").exists, "a Next turn card shows on an approximate route")
    XCTAssertFalse(el("dir.steps").exists, "steps show on an approximate route")
    mark("APPROXIMATE \(el("dir.noturn.text").label)")
  }

  // why: F-1371 FR-TECH-3 F-1236, F-1235 CTL-TEC-04-10 the photo row has a row of its own and names its count, Photos (5); 72 x 54 tiles, 4 in view and a peek of the 5th, scroll to the last; each tile reads the small copy and the viewer the whole file
  func test6PhotoCountStripAndThumbs() throws {
    launchToToday()
    // the frame's first note is an office note (the look dump's state)
    control("/office/note?job=\(need("BW_JOB"))&text=The%20doorbell%20does%20not%20work.", status: 201)
    tapWhenReady("probe.openJob", within: 30)
    XCTAssertTrue(labelIs(el("job.bar.title"), "Harold Jenkins", within: 30))
    XCTAssertTrue(labelIs(el("job.phs.count"), "Photos (5)", within: 30), "CTL-TEC-04-10 the count: \(el("job.phs.count").label)")
    let strip = el("job.strip")
    XCTAssertTrue(strip.waitForExistence(timeout: 10))
    // the photo row is below the first screen: the job screen is scrolled up until the strip is in view
    for _ in 0..<6 where !(strip.isHittable && app.frame.contains(strip.frame)) { app.swipeUp() }
    XCTAssertTrue(strip.isHittable, "the photo strip is not in view")
    let ids = ["job.thumb", "job.thumb.1", "job.thumb.2", "job.thumb.3", "job.thumb.4"]
    for id in ids { XCTAssertTrue(el(id).waitForExistence(timeout: 20), "\(id) not on the strip") }
    XCTAssertFalse(el("job.thumb.5").exists, "a 6th tile")
    // each tile is a sent photo (read from the server as its small copy), 72 x 54 pt
    for id in ids { XCTAssertTrue(waitFor("value BEGINSWITH 'sent '", el(id), 20), "\(id): \(String(describing: el(id).value))") }
    XCTAssertEqual(el("job.thumb.4").frame.width, 72, accuracy: 0.5, "tile width")
    XCTAssertEqual(el("job.thumb.4").frame.height, 54, accuracy: 0.5, "tile height")
    // the Photos row is its own row: Add note and Add photo are above it, not beside the strip
    XCTAssertLessThan(el("job.addnote").frame.maxY, strip.frame.minY, "Add note is not above the photo row")
    XCTAssertLessThan(el("job.addphoto").frame.maxY, strip.frame.minY, "Add photo is not above the photo row")
    settle()
    // the strip rests at its end (the 5th in view), scrolls back to the 1st (4 in view, 72 pt tiles 8 pt apart), then to the 5th again
    let inView = { (id: String) -> Bool in self.el(id).isHittable }
    XCTAssertTrue(inView("job.thumb.4"), "the strip does not rest at its end")
    XCTAssertLessThan(el("job.thumb").frame.minX, strip.frame.minX, "the first tile is not scrolled out of the strip with the strip at its end")
    strip.swipeRight()
    XCTAssertTrue(waitFor("isHittable == true", el("job.thumb"), 5), "the strip did not scroll back to the 1st photo")
    for id in ids.prefix(4) { XCTAssertTrue(inView(id), "\(id) is not in view with the strip at its start (4 tiles show)") }
    XCTAssertGreaterThanOrEqual(el("job.thumb").frame.minX, strip.frame.minX - 0.5, "the first tile is not at the strip's start")
    XCTAssertEqual(el("job.thumb.1").frame.minX - el("job.thumb").frame.maxX, 8, accuracy: 0.5, "the tiles' gap")
    strip.swipeLeft()
    Thread.sleep(forTimeInterval: 1)
    XCTAssertTrue(inView("job.thumb.4"), "the strip did not scroll to the 5th photo")
    mark("PHOTO-STRIP 4 in view, scrolled 1st and 5th")
    // the viewer: the only whole-file read (run.sh counts RELAY-FILE size=full against this mark)
    el("job.thumb.4").tap()
    XCTAssertTrue(el("viewer.close").waitForExistence(timeout: 20), "the photo viewer did not open")
    mark("VIEWER-OPENED")
    Thread.sleep(forTimeInterval: 3)
  }

  // why: F-1369 FR-TECH-13 CTL-TEC-04-04, -18 Directions on Harold's job is the drive from the van to HIS job: the button's minutes are API-104's, SCR-TEC-08 opens on his address with the arrival there as its last step, and More's Directions item opens the same route
  func test7DirectionsIsTheDriveToThisJob() throws {
    launchToToday()
    tapWhenReady("probe.openJob", within: 60)
    XCTAssertTrue(labelIs(el("job.bar.title"), "Harold Jenkins", within: 30))
    let minutes = need("BW_MINUTES")
    XCTAssertTrue(labelIs(el("job.dir"), "Directions, \(minutes) min", within: 60), "the button's minutes are not API-104's \(minutes): \(el("job.dir").label)")
    for via in ["button", "more"] {
      if via == "button" {
        tapWhenReady("job.dir")
      } else {
        tapWhenReady("job.more")
        let item = app.sheets.buttons["Directions"]
        XCTAssertTrue(item.waitForExistence(timeout: 5), "More has no Directions")
        item.tap()
      }
      XCTAssertTrue(el("dir.step.arrive.words").waitForExistence(timeout: 60), "\(via): the arrival step is not listed")
      XCTAssertTrue(labelIs(el("dir.dest.who.tx.b"), "Harold Jenkins"), "\(via): the route's destination is \(el("dir.dest.who.tx.b").label)")
      let last = el("dir.step.arrive.words").label
      XCTAssertTrue(last.hasPrefix("Arrive at") && last.contains(need("BW_STREET")), "\(via): the last step is \(last)")
      XCTAssertTrue(labelIs(el("dir.time.tx.b"), "About \(minutes) minutes", within: 30), "\(via): the drive time is \(el("dir.time.tx.b").label)")
      tapWhenReady("dir.bar.back")
      if !labelIs(el("job.bar.title"), "Harold Jenkins", within: 5) { tapWhenReady("probe.openJob", within: 30) }
      mark("DIRECTIONS-TO-THIS-JOB \(via) \(minutes) min \(last)")
    }
  }

  // why: d6bfc18c FR-TECH-2 the owner answered "Pin it (Recommended)": "On my way, Arrived and Finish always show above the tab bar. Small extra layout change in build 5; easy to undo." On Harold's job with 1 more photo than the row shows in view, On my way is hittable on the first view without scrolling, above the tab bar, and the photos row's last tile is reachable by scrolling
  func test8MainButtonPinnedAboveTabBar() throws {
    launchToToday()
    tapWhenReady("probe.openJob", within: 60)
    XCTAssertTrue(labelIs(el("job.bar.title"), "Harold Jenkins", within: 30))
    XCTAssertTrue(labelIs(el("job.phs.count"), "Photos (5)", within: 30), "the job holds 5 photos: \(el("job.phs.count").label)")
    let omw = el("job.omw")
    XCTAssertTrue(omw.waitForExistence(timeout: 20), "On my way is not shown")
    settle()
    XCTAssertTrue(omw.isHittable, "On my way is not hittable on the first view (without scrolling)")
    XCTAssertLessThanOrEqual(omw.frame.maxY, el("tab.today").frame.minY + 0.5, "On my way is not above the tab bar")
    // the last photo tile is reachable by scrolling, and the pinned button stays in view while it is
    let last = el("job.thumb.4")
    for _ in 0..<8 where !last.isHittable { app.swipeUp() }
    XCTAssertTrue(last.isHittable, "the photos row's last tile cannot be reached by scrolling")
    XCTAssertTrue(omw.isHittable, "On my way left the view while the photos row scrolled in")
    XCTAssertLessThanOrEqual(last.frame.maxY, omw.frame.minY + 0.5, "the last tile is under the pinned bar")
    XCTAssertTrue(el("job.arrived").isHittable, "Arrived is not in the pinned bar")
    mark("PINNED omw=\(omw.frame.minY)-\(omw.frame.maxY) tab=\(el("tab.today").frame.minY) last=\(last.frame.maxY)")
  }
}
