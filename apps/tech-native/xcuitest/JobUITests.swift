// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-3, FR-TECH-4, FR-TECH-8, FR-TECH-14, FR-BILL-3, FR-DISP-27, FR-IOS-1, F-985
// The native job screens' XCUITest suite (P6-NATIVE-JOB Acceptance), run by xcuitest/run.sh with BW_NATIVE_TESTS=JobUITests in the iOS
// Simulator on the owner's Mac against the Compose stack (Docker context desktop-linux), through the signal relay
// (xcuitest/signal-relay.mjs): the simulator has no airplane mode, so the test cuts the app's only network path at the relay. The tests
// run in name order on 1 fresh install, on Harold Jenkins's Sep 15 job (BW_JOB, Maria Santos's 24830), and each runs the control rows
// of its screen:
//   test1  the relay's address saved (SCR-TEC-12) and Maria signed in through the app's probe seam (the simulator gives a secure
//          field no keyboard focus under XCUITest; P6-NATIVE-SHELL)
//   test2  SCR-TEC-06: Cancel, No photo, camera permission refused (Open Settings), then with no signal a photo chosen in the system
//          picker (the simulator's photo library: run.sh adds a 3200 x 1200 PNG over 10 MB), previewed, Retake, Save photo; it waits
//          through a terminate and relaunch with no signal and is sent once when the signal returns (run.sh's photo ledger check)
//   test3  SCR-TEC-04 (FR-DISP-27, F-703): an office note saved with Add note (API-140, as the dispatcher) shows with its author and
//          time; the header, Call, Directions, customer note, equipment, history, More, the photo viewer, Back
//   test4  SCR-TEC-05: Type a note first, typing kept as a draft through a terminate (the job's draft link), Discard asks, Save
//   test5  SCR-TEC-04 status moves and SCR-TEC-07: On my way, Arrived, No one home (Cancel), a finish refused with neither parts
//          nor No parts used, the parts picker (find, quantity, Remove), No parts used, work-done lines, labor, the signature and
//          Clear, Cancel keeping the entries, the confirm step's Go back, then Finish and send to billing
//   test6  SCR-TEC-09 with no signal (the list, Send now dim with No signal and still pressable, how sending works), Send now when the
//          signal returns, and F-985 and F-1093: a damaged item file counts in the header (not All synced), is listed, Sign out warns
//          that it will be lost, and Sign out anyway signs out
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_ so they reach the runner): BW_RELAY, BW_CONTROL, BW_JOB (as ShellUITests).
// Each step prints a NATIVE-<step> line; run.sh keeps them in the evidence log.
import XCTest

final class JobUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-bwLook", "1", "-bwProbe", "1", "-bwProbeJob", env["BW_JOB"] ?? "0", "-bwProbeControl", env["BW_CONTROL"] ?? ""]
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------------------

  private func need(_ name: String) -> String {
    guard let v = env[name], !v.isEmpty else { XCTFail("missing \(name)"); return "" }
    return v
  }

  private func mark(_ what: String) {
    print("NATIVE-\(what)")
  }

  /// Any element by its identifier (the app's testID), whatever its type.
  private func el(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  /// The relay's control: /signal/on, /signal/off, /office/note; answers the body.
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
  private func label(_ el: XCUIElement, is text: String, within s: TimeInterval = 20) -> Bool { waitFor("label == '\(text.replacingOccurrences(of: "'", with: "\\'"))'", el, s) }
  private func value(_ el: XCUIElement, is text: String, within s: TimeInterval = 20) -> Bool { waitFor("value == '\(text)'", el, s) }
  private func gone(_ el: XCUIElement, within s: TimeInterval = 10) -> Bool { waitFor("exists == false", el, s) }

  /// The look dump of the state on screen is written 0.9 s after it settles (src/ui/look.ts).
  private func settle() {
    Thread.sleep(forTimeInterval: 2)
  }

  private func tapWhenReady(_ id: String, within s: TimeInterval = 15) {
    let e = el(id)
    XCTAssertTrue(e.waitForExistence(timeout: s), "\(id) not shown")
    e.tap()
  }

  /// Replaces a text field's text (the cursor to the end, every character deleted, then the new text typed).
  private func replace(_ field: XCUIElement, with text: String) {
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    if field.frame.width > 120 { field.coordinate(withNormalizedOffset: CGVector(dx: 0.97, dy: 0.5)).tap() } else { field.tap() }
    let current = (field.value as? String) ?? ""
    field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count + 2))
    field.typeText(text)
  }

  /// A button of the iOS action sheet (ActionSheetIOS) or alert.
  private func sheetButton(_ label: String) -> XCUIElement {
    let s = app.sheets.buttons[label]
    return s.waitForExistence(timeout: 5) ? s : app.buttons[label]
  }

  private func launchToToday(signal: Bool = true) {
    if signal { control("/signal/on") } // a test that failed with the signal off leaves it off: each test starts with signal
    app.launch()
    XCTAssertTrue(el("probe.openJob").waitForExistence(timeout: 40), "Today with the probe not shown")
  }

  private func openJob() {
    tapWhenReady("probe.openJob")
    XCTAssertTrue(label(el("job.bar.title"), is: "Harold Jenkins", within: 30), "SCR-TEC-04 not shown: \(el("job.bar.title").label)")
  }

  /// "7:05 AM" of a wire time ("2026-09-15T07:05:31-04:00[America/New_York]"), as the screens write it (UD-16).
  private func clock(_ wire: String) -> String {
    let t = wire.split(separator: "T")[1]
    let h = Int(t.prefix(2))!, m = String(t.dropFirst(3).prefix(2))
    return "\(h % 12 == 0 ? 12 : h % 12):\(m) \(h >= 12 ? "PM" : "AM")"
  }

  /// The system photo picker (PHPickerViewController): the newest photo, the one run.sh added (this year's).
  private func pickNewestLibraryPhoto() {
    let deadline = Date().addingTimeInterval(30)
    var images = app.images.matching(NSPredicate(format: "label CONTAINS[c] 'photo'"))
    while images.count == 0 && Date() < deadline {
      Thread.sleep(forTimeInterval: 1)
      images = app.images.matching(NSPredicate(format: "label CONTAINS[c] 'photo'"))
    }
    if images.count == 0 {
      print("NATIVE-PICKER-TREE \(app.debugDescription.prefix(6000))")
      XCTFail("the system photo picker showed no photo")
      return
    }
    mark("PICKER \(images.count) photo(s): \((0..<images.count).map { images.element(boundBy: $0).label }.joined(separator: " | "))")
    // The picker lists the newest first, and writes no year for a photo of this year: run.sh's photo is the first such one.
    let pick = images.element(boundBy: 0)
    XCTAssertNil(pick.label.range(of: #"\d{4}"#, options: .regularExpression), "the newest photo is not this year's: \(pick.label)")
    // The newest photo sits in the grid's first row, which the picker's own bar can overlap: a swipe there can dismiss the picker
    // (run 11), so the photo is tapped at its lower half, below the bar.
    mark("PICKED \(pick.label) hittable=\(pick.isHittable)")
    if pick.isHittable { pick.tap() } else { pick.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).tap() }
  }

  /// The springboard's permission alert, answered Don't Allow (the camera, CTL-TEC-06-06); none when iOS already knows the answer.
  private func refuseSystemAlert() {
    let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let refuse = sb.alerts.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Don'")).firstMatch
    if refuse.waitForExistence(timeout: 8) {
      refuse.tap()
      mark("CAMERA-PERMISSION refused")
    } else {
      mark("CAMERA-PERMISSION no prompt")
    }
  }

  // ---- the suite -----------------------------------------------------------------------------------------------------------------

  // why: FR-IOS-3 the app's server is the relay in front of the stack, and Maria signs in through it
  func test1ServerAndSignIn() throws {
    let relay = need("BW_RELAY")
    app.launch()
    let row = app.buttons["signin.server"]
    XCTAssertTrue(row.waitForExistence(timeout: 30))
    row.tap()
    replace(app.textFields["srv.field.value"], with: relay)
    app.buttons["srv.check"].tap()
    XCTAssertTrue(label(app.staticTexts["srv.ok.text"], is: "Connected to Right On Time, version 1.0.", within: 30))
    app.buttons["srv.save"].tap()
    tapWhenReady("probe.signin", within: 20)
    XCTAssertTrue(label(el("sync.count"), is: "All synced", within: 60), "first sync not done: \(el("sync.count").label)")
    mark("SIGNED-IN")
  }

  // why: FR-TECH-3, FR-TECH-4, FR-IOS-1, F-978 a photo picked in the system picker is SD-32's JPEG, queued with no signal, kept through terminate and relaunch, sent once
  func test2PhotoQueuedOfflineSentOnceAfterRelaunch() throws {
    launchToToday()
    XCTAssertTrue(label(el("sync.count"), is: "All synced", within: 60))
    openJob()
    // CTL-TEC-06-05 Cancel closes with nothing saved; the No photo state (CTL-TEC-06-01 shown).
    tapWhenReady("job.addphoto")
    XCTAssertTrue(el("photo.take").waitForExistence(timeout: 10))
    settle()
    mark("PHOTO-NONE")
    tapWhenReady("photo.cancel")
    XCTAssertTrue(gone(el("photo.take")))
    // CTL-TEC-06-01 Take photo with the camera refused: the message and CTL-TEC-06-06 Open Settings.
    tapWhenReady("job.addphoto")
    tapWhenReady("photo.take")
    sheetButton("Take photo").tap()
    refuseSystemAlert()
    XCTAssertTrue(label(el("photo.denied.text"), is: "Right On Time cannot use the camera. Allow it in Settings."), "denied state not shown")
    settle()
    mark("PHOTO-DENIED")
    tapWhenReady("photo.settings")
    let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
    XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 15), "Open Settings did not open the Settings app")
    mark("OPEN-SETTINGS")
    app.activate()
    // With no signal: Choose from library, the preview (CTL-TEC-06-02), Retake (CTL-TEC-06-04) opens the sources again, Save photo.
    control("/signal/off")
    tapWhenReady("photo.take")
    sheetButton("Choose from library").tap()
    pickNewestLibraryPhoto()
    if !el("photo.preview").waitForExistence(timeout: 90) { print("NATIVE-PREVIEW-TREE \(app.debugDescription.prefix(6000))") }
    XCTAssertTrue(el("photo.preview").exists, "preview not shown")
    settle()
    mark("PHOTO-PREVIEW")
    tapWhenReady("photo.retake")
    XCTAssertTrue(sheetButton("Choose from library").waitForExistence(timeout: 5), "Retake did not open the sources")
    sheetButton("Cancel").tap()
    XCTAssertTrue(el("photo.preview").exists, "Retake canceled lost the preview")
    tapWhenReady("photo.save")
    let waiting = app.buttons.matching(NSPredicate(format: "value BEGINSWITH 'waiting '")).firstMatch
    XCTAssertTrue(waiting.waitForExistence(timeout: 20), "the photo does not show Waiting to send on the job")
    let key = String((waiting.value as? String ?? "").dropFirst("waiting ".count))
    XCTAssertEqual(key.count, 36, "photo key: \(key)")
    mark("PHOTO-QUEUED key=\(key)")
    Thread.sleep(forTimeInterval: 3)
    XCTAssertTrue(value(waiting, is: "waiting \(key)", within: 2), "the photo left with no signal")

    app.terminate()
    mark("TERMINATED")
    launchToToday(signal: false)
    openJob()
    let thumb = app.buttons.matching(NSPredicate(format: "value ENDSWITH %@", key)).firstMatch
    XCTAssertTrue(thumb.waitForExistence(timeout: 30), "the photo is not on the job after the relaunch")
    XCTAssertTrue(value(thumb, is: "waiting \(key)"))
    Thread.sleep(forTimeInterval: 5)
    XCTAssertTrue(value(thumb, is: "waiting \(key)", within: 2), "the photo left while the signal was still off")
    mark("PHOTO-RELAUNCHED-STILL-QUEUED key=\(key)")

    control("/signal/on")
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 2)
    app.activate()
    XCTAssertTrue(value(thumb, is: "sent \(key)", within: 120), "not sent after the signal returned: \(String(describing: thumb.value))")
    mark("PHOTO-SENT key=\(key)")
  }

  // why: FR-DISP-27, FR-TECH-8, FR-AUTH-4, F-1095 on Harold's Sep 15 job an office note saved with Add note (API-140) shows with its author and time (F-703)
  func test3OfficeNoteAndJobControls() throws {
    launchToToday()
    XCTAssertTrue(label(el("sync.count"), is: "All synced", within: 60))
    let words = "P6 native: the gate code is 1942"
    let q = words.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
    let body = control("/office/note?job=\(need("BW_JOB"))&text=\(q)", status: 201)
    let json = try JSONSerialization.jsonObject(with: body) as! [String: Any]
    let note = (json["data"] as! [String: Any])["note"] as! [String: Any]
    let id = (note["id"] as! String).lowercased(), author = note["author"] as! String, at = note["at"] as! String
    mark("OFFICE-NOTE-SAVED id=\(id) author=\(author) at=\(at)")
    openJob()
    let row = el("job.note.\(id)")
    XCTAssertTrue(row.waitForExistence(timeout: 30), "the office note is not on SCR-TEC-04")
    // The time as the Job screen (SCR-TEC-04) writes it in the job's zone: exact when the office note's save (API-140) answered in that zone, else its form.
    XCTAssertTrue(row.label.hasPrefix("\(words). Office note - \(author) - "), row.label)
    if at.contains("-04:00") { XCTAssertTrue(row.label.hasSuffix(" - \(clock(at))"), "\(row.label) vs \(clock(at))") }
    XCTAssertNotNil(row.label.range(of: #" - \d{1,2}:\d{2} (AM|PM)$"#, options: .regularExpression), row.label)
    mark("OFFICE-NOTE-SHOWN \(row.label)")

    // CTL-TEC-04-02, -19: the header; -03 Call (the job is today); -05 to -07 the customer note, equipment and history.
    XCTAssertTrue(label(el("job.bar.status.text"), is: "Scheduled"))
    XCTAssertTrue(el("job.position").label.contains("#\(need("BW_JOB"))"), "position: \(el("job.position").label)")
    XCTAssertTrue(el("job.bar.sub").label.contains(" - "), "header line: \(el("job.bar.sub").label)")
    XCTAssertEqual(el("job.call").label, "Call Harold")
    for id in ["job.cnote.text", "job.eq.b", "job.hist.b"] { XCTAssertTrue(el(id).exists, "\(id) not shown") }
    // CTL-TEC-04-04 Directions, shown on a job that is today and not yet On site (F-1369: the drive from the van to this job), with the
    // route's minutes (API-104); StepsUITests test7 taps it and checks the screen it opens, Directions (SCR-TEC-08).
    XCTAssertTrue(el("job.dir").exists, "Directions not shown")
    XCTAssertTrue(el("job.dir").label.hasPrefix("Directions"), el("job.dir").label)
    mark("DIRECTIONS \(el("job.dir").label)")
    // CTL-TEC-04-18 More: the actions this screen has.
    tapWhenReady("job.more")
    for a in ["Call", "Add note", "Add photo"] { XCTAssertTrue(sheetButton(a).waitForExistence(timeout: 5), "More has no \(a)") }
    sheetButton("Cancel").tap()
    // F-1095 (d): each of More's items is tapped and opens what it names (Call is the device run's: tel: has no handler in the simulator).
    tapWhenReady("job.more")
    sheetButton("Add note").tap()
    XCTAssertTrue(el("note.value").waitForExistence(timeout: 10), "More > Add note did not open SCR-TEC-05")
    tapWhenReady("note.discard")
    XCTAssertTrue(gone(el("note.value")), "Discard on an empty note did not close SCR-TEC-05")
    tapWhenReady("job.more")
    sheetButton("Add photo").tap()
    XCTAssertTrue(el("photo.cancel").waitForExistence(timeout: 10), "More > Add photo did not open SCR-TEC-06")
    tapWhenReady("photo.cancel")
    XCTAssertTrue(gone(el("photo.cancel")), "Cancel did not close SCR-TEC-06")
    tapWhenReady("job.more")
    let toJob = sheetButton("Directions")
    XCTAssertTrue(toJob.waitForExistence(timeout: 5), "More has no Directions (Harold's job is today and Scheduled)")
    toJob.tap()
    XCTAssertTrue(el("dir.bar.title").waitForExistence(timeout: 20), "More > Directions did not open SCR-TEC-08")
    tapWhenReady("dir.bar.back")
    // Back leaves SCR-TEC-08 (to the job it was opened from, on Today's stack); the job screen is opened again if Back went to Today.
    if !label(el("job.bar.title"), is: "Harold Jenkins", within: 5) { openJob() }
    mark("JOB-MORE-ITEMS-TAPPED add-note add-photo directions")
    // The photo on the job opens its viewer, and Close shuts the viewer (CTL-TEC-04-10, -11).
    let sent = app.buttons.matching(NSPredicate(format: "value BEGINSWITH 'sent '")).firstMatch
    XCTAssertTrue(sent.waitForExistence(timeout: 10), "no photo on the job")
    sent.tap()
    XCTAssertTrue(el("viewer.alt").waitForExistence(timeout: 10), "photo viewer not shown")
    XCTAssertTrue(el("viewer.alt").label.hasPrefix("Photo by"), "alt: \(el("viewer.alt").label)")
    tapWhenReady("viewer.close")
    XCTAssertTrue(gone(el("viewer.alt")))
    settle()
    mark("JOB")
    // The Back button returns to Today (CTL-TEC-04-01).
    tapWhenReady("job.bar.back")
    XCTAssertTrue(el("probe.openJob").waitForExistence(timeout: 10))
  }

  // why: FR-TECH-3, FR-TECH-4 a typed note is kept as a draft through a terminate, Discard asks first, and Save shows it on the job
  func test4NoteDraftDiscardAndSave() throws {
    launchToToday()
    openJob()
    tapWhenReady("job.addnote")
    let field = el("note.value")
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    tapWhenReady("note.save")
    XCTAssertTrue(label(el("note.why"), is: "Type a note first"))
    let words = "Replaced 6 ft of condensate hose. Heat exchanger looks clean, no cra"
    field.tap()
    field.typeText(words)
    XCTAssertTrue(el("note.kept.text").waitForExistence(timeout: 10), "Saved on this phone as you type not shown")
    settle()
    mark("NOTE-TYPING")
    tapWhenReady("note.discard")
    XCTAssertTrue(app.alerts.buttons["Keep writing"].waitForExistence(timeout: 5), "Discard did not ask")
    app.alerts.buttons["Keep writing"].tap()
    XCTAssertTrue(value(field, is: words, within: 5))

    app.terminate()
    launchToToday()
    openJob()
    XCTAssertTrue(el("job.draft").waitForExistence(timeout: 20), "the draft link is not on the job after the relaunch")
    settle()
    mark("JOB-DRAFT")
    el("job.draft").tap()
    XCTAssertTrue(value(el("note.value"), is: words, within: 10), "the draft did not reopen")
    tapWhenReady("note.save")
    let saved = app.otherElements.matching(NSPredicate(format: "label BEGINSWITH %@", words)).firstMatch
    XCTAssertTrue(saved.waitForExistence(timeout: 20), "the saved note is not on the job")
    XCTAssertTrue(gone(el("job.draft")))
    mark("NOTE-SAVED")

    tapWhenReady("job.addnote")
    el("note.value").tap()
    el("note.value").typeText("Throwaway words")
    tapWhenReady("note.discard")
    app.alerts.buttons["Discard"].tap()
    XCTAssertTrue(gone(el("note.value")))
    XCTAssertFalse(el("job.draft").exists, "a discarded note left a draft")
    mark("NOTE-DISCARDED")
  }

  // why: UC-12, FR-BILL-3, FR-TECH-14, FR-TECH-2, FR-TECH-3 the status moves, a finish refused with neither parts nor No parts used, the Photos strip, the notes list and Add note beside the finish (CTL-TEC-07-16 to -18), and the full finish with parts, lines, labor and a signature; UC-12: a job of the day worked on site to Done, from On my way to the finish, against the Compose stack
  func test5StatusMovesAndFinish() throws {
    launchToToday()
    openJob()
    tapWhenReady("job.omw")
    XCTAssertTrue(label(el("sheet.go"), is: "Send", within: 10))
    el("sheet.go").tap()
    XCTAssertTrue(label(el("job.bar.status.text"), is: "On the way", within: 20))
    tapWhenReady("job.arrived")
    XCTAssertTrue(label(el("sheet.go"), is: "Arrived", within: 10))
    el("sheet.go").tap()
    XCTAssertTrue(label(el("job.bar.status.text"), is: "On site", within: 20))
    mark("ON-SITE")
    tapWhenReady("job.noh")
    XCTAssertTrue(label(el("sheet.go"), is: "No one home", within: 10))
    tapWhenReady("sheet.cancel")
    XCTAssertTrue(label(el("job.bar.status.text"), is: "On site"))

    tapWhenReady("job.finish")
    XCTAssertTrue(label(el("fin.bar.title"), is: "Finish job", within: 20))
    XCTAssertTrue(el("fin.labor.small").waitForExistence(timeout: 30), "labor's From Arrived line not shown")
    let line = el("fin.line.value")
    line.tap()
    line.typeText("Furnace tune-up, all readings normal")
    el("fin.ghead.work").tap()
    settle()
    mark("FINISH-EDITING")
    // CTL-TEC-07-06 with neither parts nor No parts used: refused on the screen.
    tapWhenReady("fin.finish")
    XCTAssertTrue(label(el("fin.err.text"), is: "Add the parts you used, or turn on No parts used."), "the refused finish message is not shown")
    XCTAssertFalse(el("fin.confirm.ok").exists, "the confirm step opened with neither")
    settle()
    mark("FINISH-REFUSED")
    // CTL-TEC-07-02 to -04: find a part, quantity, Remove.
    let find = el("fin.find.value")
    find.tap()
    find.typeText("filter")
    tapWhenReady("fin.result.0")
    XCTAssertTrue(el("fin.part.name").waitForExistence(timeout: 10))
    el("fin.ghead.parts").tap()
    settle()
    mark("FINISH-PART \(el("fin.part.name").label)")
    tapWhenReady("fin.part.more")
    XCTAssertTrue(label(el("fin.part.n"), is: "2", within: 5))
    tapWhenReady("fin.part.less")
    tapWhenReady("fin.part.less")
    XCTAssertTrue(label(el("fin.part.n"), is: "1", within: 5), "quantity under 1")
    tapWhenReady("fin.part.remove")
    XCTAssertTrue(gone(el("fin.part.name")))
    // The No parts used switch goes on and off (CTL-TEC-07-05).
    let noParts = app.switches["fin.noparts.toggle"]
    XCTAssertTrue(noParts.waitForExistence(timeout: 5))
    noParts.tap()
    XCTAssertTrue(value(noParts, is: "1", within: 5))
    noParts.tap()
    XCTAssertTrue(value(noParts, is: "0", within: 5))
    find.tap()
    find.typeText("filter")
    tapWhenReady("fin.result.0")
    XCTAssertTrue(el("fin.part.name").waitForExistence(timeout: 10))
    // CTL-TEC-07-12, -13: a work-done line added and removed.
    tapWhenReady("fin.addline")
    let second = el("fin.line.value.1")
    XCTAssertTrue(second.waitForExistence(timeout: 5))
    second.typeText("Replaced the filter")
    tapWhenReady("fin.line.remove.1")
    XCTAssertTrue(gone(second))
    // The labor row takes hours and minutes (CTL-TEC-07-07).
    tapWhenReady("fin.labor.row")
    replace(el("fin.labor.hours"), with: "2")
    el("fin.ghead.labor").tap() // the number pad has no return key: the keyboard goes before the next field
    replace(el("fin.labor.minutes"), with: "9")
    XCTAssertTrue(value(el("fin.labor.row"), is: "2 hr 9 min", within: 5), "labor: \(String(describing: el("fin.labor.row").value))")
    el("fin.ghead.labor").tap()
    // CTL-TEC-07-14, -15: the signature, Clear, signed again.
    let pad = el("fin.sig")
    // A drag is given by coordinates, which XCUITest does not scroll to: the pad is scrolled into reach first.
    var swipes = 0
    while (!pad.isHittable || pad.frame.maxY > app.frame.height - 120) && swipes < 6 {
      el("fin.ghead.labor").exists && el("fin.ghead.labor").isHittable ? el("fin.ghead.labor").swipeUp() : app.swipeUp()
      swipes += 1
    }
    mark("PAD at \(pad.frame)")
    pad.coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.6)).press(forDuration: 0.2, thenDragTo: pad.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.3)), withVelocity: .slow, thenHoldForDuration: 0.1)
    if !el("fin.signed.text").waitForExistence(timeout: 10) { print("NATIVE-PAD-TREE windows=\(app.windows.count) \(app.debugDescription.prefix(14000))") }
    XCTAssertTrue(el("fin.signed.text").exists, "the Signed line is not shown")
    XCTAssertTrue(el("fin.signed.text").label.hasPrefix("Harold Jenkins signed "), el("fin.signed.text").label)
    settle()
    mark("FINISH-SIGNED \(el("fin.signed.text").label)")
    tapWhenReady("fin.signed.clear")
    XCTAssertTrue(gone(el("fin.signed.text")))
    pad.coordinate(withNormalizedOffset: CGVector(dx: 0.15, dy: 0.5)).press(forDuration: 0.2, thenDragTo: pad.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.5)), withVelocity: .slow, thenHoldForDuration: 0.1)
    XCTAssertTrue(el("fin.signed.text").waitForExistence(timeout: 10))
    // CTL-TEC-07-10: back to the job and in again: the entries stayed on the phone.
    tapWhenReady("fin.bar.back")
    tapWhenReady("job.finish")
    XCTAssertTrue(el("fin.part.name").waitForExistence(timeout: 20), "the part row did not stay")
    XCTAssertTrue(el("fin.signed.text").exists, "the signature did not stay")
    XCTAssertTrue(value(el("fin.labor.row"), is: "2 hr 9 min", within: 5))
    // CTL-TEC-07-16 Photos: a thumbnail of each of the job's photos (test2 leaves 1 on the job, sent), counted in the header.
    let photoHead = el("fin.ghead.photos")
    XCTAssertTrue(photoHead.waitForExistence(timeout: 10), "the Photos strip is not shown (test2 leaves a sent photo on the job)")
    let thumbs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'fin.photo.'"))
    let shownPhotos = thumbs.count
    XCTAssertGreaterThan(shownPhotos, 0, "no thumbnail in the Photos strip")
    XCTAssertEqual(photoHead.label, "Photos (\(shownPhotos))".uppercased(), "the Photos count is not the strip's") // GHead draws its text in capitals
    let sentThumb = thumbs.matching(NSPredicate(format: "value BEGINSWITH 'sent '")).firstMatch
    XCTAssertTrue(sentThumb.exists, "test2's sent photo has no thumbnail: \(thumbs.allElementsBoundByIndex.map { String(describing: $0.value) })")
    mark("FINISH-PHOTOS \(photoHead.label)")
    // CTL-TEC-07-17 Technician notes: the list with its count, each note with its time.
    let noteHead = el("fin.ghead.notes")
    let noteRows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'fin.note.' AND identifier ENDSWITH '.b'"))
    let notesBefore = noteRows.count
    XCTAssertEqual(noteHead.label, "Technician notes (\(notesBefore))".uppercased(), "the notes count is not the list's")
    // CTL-TEC-07-18 Add note opens SCR-TEC-05 for this job; Save comes back here, the note is listed with its time, the entries stayed.
    let finWords = "Finish screen note \(Int(Date().timeIntervalSince1970) % 100000)"
    tapWhenReady("fin.addnote")
    let noteField = el("note.value")
    XCTAssertTrue(noteField.waitForExistence(timeout: 10), "Add note did not open SCR-TEC-05")
    noteField.tap()
    noteField.typeText(finWords)
    tapWhenReady("note.save")
    XCTAssertTrue(gone(noteField), "the note sheet did not close")
    XCTAssertTrue(label(el("fin.bar.title"), is: "Finish job", within: 10), "Save did not come back to the finish screen")
    XCTAssertTrue(label(noteHead, is: "Technician notes (\(notesBefore + 1))".uppercased(), within: 20), "notes count after Add note: \(noteHead.label)")
    let added = noteRows.matching(NSPredicate(format: "label == %@", finWords)).firstMatch
    XCTAssertTrue(added.waitForExistence(timeout: 20), "the added note is not listed on the finish screen")
    let addedTime = el(String(added.identifier.dropLast(2)) + ".small")
    XCTAssertTrue(addedTime.exists && addedTime.label.hasSuffix("M"), "the added note has no time: \(addedTime.label)")
    XCTAssertTrue(el("fin.part.name").exists, "the part row did not stay after Add note")
    XCTAssertTrue(el("fin.signed.text").exists, "the signature did not stay after Add note")
    XCTAssertTrue(value(el("fin.labor.row"), is: "2 hr 9 min", within: 5), "labor did not stay after Add note")
    mark("FINISH-NOTE-ADDED \(noteHead.label)")
    // CTL-TEC-07-08, -09: the confirm step, Go back, then Finish and send to billing.
    tapWhenReady("fin.finish")
    XCTAssertTrue(el("fin.confirm.ok").waitForExistence(timeout: 5))
    settle()
    mark("FINISH-CONFIRM")
    tapWhenReady("fin.confirm.back")
    XCTAssertTrue(gone(el("fin.confirm.ok")))
    tapWhenReady("fin.finish")
    tapWhenReady("fin.confirm.ok")
    XCTAssertTrue(label(el("job.bar.status.text"), is: "Done", within: 20), "the job is not Done")
    mark("FINISHED")
  }

  // why: FR-TECH-4, FR-TECH-6, F-985 SCR-TEC-09 lists what waits with no signal and sends on Send now; a damaged item counts in the header, is listed, and refuses sign-out
  func test6WaitingToSendAndDamagedItem() throws {
    launchToToday()
    XCTAssertTrue(label(el("sync.count"), is: "All synced", within: 90), "not synced before the test: \(el("sync.count").label)")
    // CTL-CMP-10-02 (F-1091 d): the header count is a button, so VoiceOver says it opens Waiting to send
    XCTAssertEqual(el("sync.count").elementType, .button, "the header count is not a button: \(el("sync.count").elementType.rawValue)")
    control("/signal/off")
    openJob()
    for words in ["Flame sensor cleaned", "Hose cracked at trap"] {
      tapWhenReady("job.addnote")
      el("note.value").tap()
      el("note.value").typeText(words)
      tapWhenReady("note.save")
      XCTAssertTrue(gone(el("note.value")))
    }
    tapWhenReady("job.bar.back")
    XCTAssertTrue(label(el("sync.count"), is: "2 waiting", within: 20), "header: \(el("sync.count").label)")
    el("sync.count").tap()
    XCTAssertTrue(label(el("wait.bar.title"), is: "Waiting to send", within: 10))
    // The app learns No signal from a call that fails; a background upload with no route keeps trying a while first.
    XCTAssertTrue(el("wait.nosig.title").waitForExistence(timeout: 120), "No signal not shown")
    XCTAssertTrue(el("wait.row.b").exists && el("wait.row2.b").exists, "the 2 waiting notes are not listed")
    XCTAssertEqual(el("wait.why").label, "No signal")
    XCTAssertTrue(el("wait.how.text").label.hasPrefix("Items send while the app is open with signal"))
    settle()
    mark("WAITING-OFFLINE")
    // CTL-TEC-09-02 Send now once the signal is back.
    control("/signal/on")
    tapWhenReady("wait.send")
    // Sent: the waiting rows go (the screen then lists what was just sent).
    XCTAssertTrue(gone(el("wait.row.b"), within: 150), "Send now did not send")
    mark("SEND-NOW")
    tapWhenReady("wait.bar.back")

    // F-985: a waiting-item file that does not parse.
    tapWhenReady("tab.today")
    tapWhenReady("probe.damage")
    XCTAssertTrue(label(el("sync.count"), is: "1 waiting", within: 20), "a damaged item reads: \(el("sync.count").label)")
    mark("F985-HEADER \(el("sync.count").label)")
    el("sync.count").tap()
    XCTAssertTrue(el("wait.damaged.item.0").waitForExistence(timeout: 10), "the damaged item is not listed on SCR-TEC-09")
    XCTAssertEqual(el("wait.damaged.item.0").label, "An item this phone cannot read")
    mark("F985-LISTED")
    tapWhenReady("wait.bar.back")
    tapWhenReady("me.signout")
    XCTAssertTrue(el("me.refused.text").waitForExistence(timeout: 10), "sign-out was not refused")
    // F-1093 (owner ruling "Allow sign-out, warn"): with only a damaged item left, Sign out warns that it is lost; Sign out anyway signs out.
    XCTAssertTrue(el("me.refused.text").label.hasPrefix("1 item this phone cannot read will be lost if you sign out."), el("me.refused.text").label)
    mark("F1093-SIGNOUT-WARNED \(el("me.refused.text").label)")
    tapWhenReady("me.refused.link")
    XCTAssertTrue(el("signin.server").waitForExistence(timeout: 30), "Sign out anyway did not open the sign-in screen")
    mark("F1093-SIGNED-OUT")
  }
}
