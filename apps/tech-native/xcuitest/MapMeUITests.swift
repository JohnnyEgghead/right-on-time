// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-10, FR-TECH-11, FR-TECH-15, FR-MAP-1, FR-MAP-2, NFR-12, FR-IOS-1
// The native Map, Directions, Parts and Me suite (P6-NATIVE-MAP-ME Acceptance), run by xcuitest/run.sh with BW_NATIVE_TESTS=MapMeUITests in the iOS
// Simulator on the owner's Mac against the Compose stack (Docker context desktop-linux). As in ShellUITests the app's server address is the signal
// relay (xcuitest/signal-relay.mjs): the simulator has no airplane mode, so "signal off" cuts the app's only network path there.
// The tests run in name order on 1 install: test01 saves the relay's address and signs in; the rest open the 4 screens and run their control rows.
//
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_): BW_RELAY, BW_CONTROL, BW_DEAD, BW_JOB (as ShellUITests).
// Each step prints a NATIVE-<step> line; run.sh keeps them in the evidence log, and marks the relay log (/mark) around the map phases so it can
// show that the map asked the network for nothing but the branch file from the app's own server.
import XCTest

final class MapMeUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = launched([])
  }

  private func launched(_ extra: [String]) -> XCUIApplication {
    let a = XCUIApplication()
    a.launchArguments = ["-bwLook", "1", "-bwProbe", "1", "-bwProbeJob", env["BW_JOB"] ?? "0", "-bwProbeControl", env["BW_CONTROL"] ?? ""] + extra
    return a
  }

  private func need(_ name: String) -> String {
    guard let v = env[name], !v.isEmpty else { XCTFail("missing \(name)"); return "" }
    return v
  }

  private func mark(_ what: String) {
    print("NATIVE-\(what)")
  }

  /// The relay's control: /signal/on, /signal/off, /mark?name=<word>.
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

  /// Any element with the id (a Text, a Pressable, a View: the type XCUITest gives each differs).
  private func el(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  private func label(_ element: XCUIElement, contains text: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "label CONTAINS %@", text)
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: element)], timeout: s) == .completed
  }

  private func value(_ element: XCUIElement, is text: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "value == %@", text)
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: element)], timeout: s) == .completed
  }

  /// The look dump of the state on screen is written 0.9 s after it settles (src/ui/look.ts).
  private func settle() {
    Thread.sleep(forTimeInterval: 2.5)
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

  /// The map's status line: "streets=<n> places=<n> water=<n> shields=<n> stops=<n> base=<n>" (NativeMap.tsx), counted from the features the
  /// map actually rendered.
  private func counts(_ status: String) -> [String: Int] {
    var out: [String: Int] = [:]
    for part in status.split(separator: " ") {
      let kv = part.split(separator: "=")
      if kv.count == 2, let n = Int(kv[1]) { out[String(kv[0])] = n }
    }
    return out
  }

  /// Waits for a status line whose counts say the map drew its base shapes, then returns the counts. The check a blank map or a map with no
  /// names must fail: `base` > 0 (tiles drawn) and, for a named map, `streets` > 0.
  private func drawn(_ id: String, names: Bool, within s: TimeInterval = 120) -> [String: Int] {
    let status = el("\(id).status")
    XCTAssertTrue(status.waitForExistence(timeout: s), "\(id) did not start drawing (the branch file may not have arrived)")
    let deadline = Date().addingTimeInterval(s)
    var last: [String: Int] = [:]
    var zoomed = 0
    var quiet = 0
    while Date() < deadline {
      var now = counts(status.label)
      quiet = now == last ? quiet + 1 : 0
      // The stops drawn are read at the framing the route opens in; a zoom in to read the street names moves them out of view.
      now["stops"] = max(now["stops", default: 0], last["stops", default: 0])
      last = now
      if (last["base"] ?? 0) > 0 && (!names || (last["streets"] ?? 0) > 0) { break }
      // The route frames every stop, a view in which a city's street names are too small to draw (the web map is the same); the street names
      // are read after zooming in, as a technician would, once the map has settled with none.
      if names && quiet >= 3 && (last["base"] ?? 0) > 0 && zoomed < 6 {
        // 3 double taps, 1 zoom level each, on the middle of the map
        for _ in 0..<3 {
          el(id).coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).doubleTap()
          Thread.sleep(forTimeInterval: 1)
        }
        zoomed += 1
        quiet = 0
      }
      Thread.sleep(forTimeInterval: 1.5)
    }
    return last
  }

  // why: FR-IOS-3, FR-AUTH-7 the suite's install points at the relay and signs in as Maria Santos (the shell's own flow, F-994)
  func test01SignInThroughTheRelay() throws {
    let relay = need("BW_RELAY")
    // F-1075: from the first read on, the day's route is answered with its first stop done (the Map frame's Done row, signal-relay.mjs do=firstdone);
    // n covers every read this suite makes, so the kept copy and the Map dump both hold it
    control("/rule?path=/api/v1/tech/day-route&do=firstdone&n=400")
    app.launch()
    let row = app.buttons["signin.server"]
    XCTAssertTrue(row.waitForExistence(timeout: 30), "sign-in screen not shown")
    row.tap()
    let field = app.textFields["srv.field.value"]
    replace(field, with: relay)
    app.buttons["srv.check"].tap()
    XCTAssertTrue(label(app.staticTexts["srv.ok.text"], contains: "Connected to Right On Time", within: 30))
    app.buttons["srv.save"].tap()
    let signIn = app.buttons["probe.signin"]
    XCTAssertTrue(signIn.waitForExistence(timeout: 20), "probe sign-in not shown")
    signIn.tap()
    XCTAssertTrue(el("tab.today").waitForExistence(timeout: 60), "Today not shown after sign-in")
    mark("SIGNED-IN")
  }

  // why: FR-TECH-10, FR-BILL-3 CTL-TEC-16-01 to -03 the parts search works on the phone's copy with the signal off, lists code and price, and clears
  func test02PartsSearchWorksWithTheSignalOff() throws {
    app.launch()
    tab("parts")
    let input = el("parts.input")
    XCTAssertTrue(input.waitForExistence(timeout: 90), "the parts list never reached the phone (no search field)")
    XCTAssertTrue(label(el("parts.bar.sub"), contains: "Search only", within: 10), "CTL-TEC-16 sub line")
    // With signal: a search lists matches, the count line says how many, each row shows name, code and price.
    input.tap()
    input.typeText("filter")
    let first = el("parts.row.0")
    XCTAssertTrue(first.waitForExistence(timeout: 15), "no part matches 'filter'")
    XCTAssertTrue(label(el("parts.count"), contains: "parts match"))
    XCTAssertTrue(el("parts.row.0.price").label.hasPrefix("$"), "row shows the price: \(el("parts.row.0.price").label)")
    let code = el("parts.row.0.code").label
    XCTAssertFalse(code.isEmpty, "row shows the code")
    let online = el("parts.count").label
    settle()
    mark("PARTS-ONLINE \(online)")
    // Clear (CTL-TEC-16-03) empties the search.
    el("parts.clear").tap()
    XCTAssertTrue(el("parts.empty").waitForExistence(timeout: 10), "Clear did not empty the search")
    // The signal off and the app opened again (F-1074): the same search answers from the copy kept on the phone, not the one in memory, the same count.
    control("/signal/off")
    app.terminate()
    app.launch()
    tab("parts")
    // CTL-CMP-10-01 (F-1070): the screen says so once a read finds no signal (the open's read fails).
    XCTAssertTrue(el("nosig").waitForExistence(timeout: 90), "CTL-CMP-10-01 Parts shows no No signal card with the signal off")
    XCTAssertTrue(label(el("nosig"), contains: "No signal", within: 5), "CTL-CMP-10-01 text: \(el("nosig").label)")
    let offInput = el("parts.input")
    XCTAssertTrue(offInput.waitForExistence(timeout: 30), "the kept parts list did not come back after an offline relaunch (no search field)")
    offInput.tap()
    offInput.typeText("filter")
    XCTAssertTrue(el("parts.row.0").waitForExistence(timeout: 15), "no results with the signal off")
    XCTAssertEqual(el("parts.count").label, online, "the offline search differs from the online one")
    mark("PARTS-OFFLINE \(el("parts.count").label)")
    // No match: its own line, naming what was typed.
    el("parts.clear").tap()
    offInput.typeText("zzqx")
    XCTAssertTrue(el("parts.nomatch").waitForExistence(timeout: 10), "no-match line not shown")
    el("parts.clear").tap()
    // A search by code finds a part too.
    offInput.typeText(code.lowercased())
    XCTAssertTrue(el("parts.row.0").waitForExistence(timeout: 10), "search by code '\(code)' found nothing")
    control("/signal/on")
    mark("PARTS-DONE")
  }

  // why: FR-TECH-11, FR-MAP-1, FR-MAP-2, NFR-12 CTL-TEC-15-01 and CTL-CMP-05-01/-04 the map draws street names from the bundled glyphs, shows the OpenStreetMap credit, and asks the network for nothing but the branch file
  func test03MapDrawsStreetNamesAndTheCredit() throws {
    app.launch()
    control("/mark?name=MAP-START")
    tab("map")
    XCTAssertTrue(el("map.view").waitForExistence(timeout: 60), "the Map tab shows no map")
    let c = drawn("map.view", names: true)
    XCTAssertGreaterThan(c["base"] ?? 0, 0, "the map is blank: \(c)")
    XCTAssertGreaterThan(c["streets"] ?? 0, 0, "the map draws no street names: \(c)")
    XCTAssertGreaterThan(c["stops"] ?? 0, 0, "the map draws no stops: \(c)")
    XCTAssertTrue(el("map.view.osm").exists, "the OpenStreetMap credit is missing")
    XCTAssertEqual(el("map.view.osm").label, "© OpenStreetMap")
    settle()
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "map-with-street-names"
    shot.lifetime = .keepAlways
    add(shot)
    mark("MAP-DRAWN streets=\(c["streets"] ?? 0) places=\(c["places"] ?? 0) water=\(c["water"] ?? 0) shields=\(c["shields"] ?? 0) stops=\(c["stops"] ?? 0) base=\(c["base"] ?? 0)")
    control("/mark?name=MAP-DRAWN")
    // With the signal off and the app opened again the map still draws: the branch file and the day are on the phone, nothing is asked of the network.
    control("/signal/off")
    app.terminate()
    app.launch()
    control("/mark?name=MAP-OFFLINE-START")
    tab("map")
    let off = drawn("map.view", names: true, within: 90)
    XCTAssertGreaterThan(off["streets"] ?? 0, 0, "the map draws no street names with the signal off: \(off)")
    XCTAssertTrue(el("map.view.osm").exists)
    XCTAssertTrue(el("nosig").waitForExistence(timeout: 60), "CTL-CMP-10-01 Map shows no No signal card with the signal off")
    mark("MAP-OFFLINE-DRAWN streets=\(off["streets"] ?? 0) base=\(off["base"] ?? 0) stops=\(off["stops"] ?? 0)")
    control("/mark?name=MAP-END")
    control("/signal/on")
  }

  // why: FR-TECH-11, FR-TECH-13 CTL-TEC-15-02 to -10 the Map tab's stops list, summary, Next stop card, Directions, Show the whole route, Show the stop list, legend, drive time and Open job
  func test04MapControlRows() throws {
    app.launch()
    tab("map")
    XCTAssertTrue(el("map.next").waitForExistence(timeout: 60), "CTL-TEC-15-03 Next stop card not shown")
    let sub = el("map.bar.sub").label
    XCTAssertTrue(sub.hasPrefix("Today's route - "), "CTL-TEC-15-08 summary: \(sub)")
    let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier MATCHES %@", "map\\.stop\\.(done|next|later)\\.[0-9]+")).count
    let nStops = Int(sub.components(separatedBy: " ")[3]) ?? -1
    XCTAssertEqual(rows, nStops, "CTL-TEC-15-02 the stops list has \(rows) rows, the summary says \(nStops)")
    XCTAssertTrue(el("map.stop.next.0").exists, "CTL-TEC-15-02 the Next stop's row")
    XCTAssertTrue(el("map.stop.next.0").label.contains("Next"))
    XCTAssertTrue(el("map.legend").exists, "CTL-TEC-15-07 legend")
    XCTAssertTrue(el("map.legend").label.contains("Done") && el("map.legend").label.contains("Next") && el("map.legend").label.contains("Later"))
    // CTL-TEC-15-09 (F-1074): the drive time, the miles and the service, as "12 min, 5.3 mi - furnace tune-up"
    XCTAssertTrue(label(el("map.next.dist.text"), contains: "min", within: 10), "CTL-TEC-15-09 drive time and service")
    XCTAssertNotNil(el("map.next.dist.text").label.range(of: "^[0-9]+ min, [0-9]+(\\.[0-9]+)? mi - [^ ].*$", options: .regularExpression), "CTL-TEC-15-09 minutes, miles and service: \(el("map.next.dist.text").label)")
    let minutes = el("map.dir").label
    XCTAssertTrue(minutes.hasPrefix("Directions, "), "CTL-TEC-15-04 the button carries the drive time: \(minutes)")
    // CTL-TEC-15-05 Show the whole route reads nothing and keeps the map drawn.
    _ = drawn("map.view", names: true)
    el("map.fit").tap()
    Thread.sleep(forTimeInterval: 2)
    XCTAssertGreaterThan(counts(el("map.view.status").label)["stops", default: 0], 0, "the map lost its stops after Show the whole route")
    // CTL-TEC-15-06 Show the stop list scrolls to the list.
    el("map.list").tap()
    Thread.sleep(forTimeInterval: 1)
    XCTAssertTrue(el("map.stop.next.0").isHittable, "CTL-TEC-15-06 the stop list is not in view")
    // CTL-TEC-15-06 (F-1070): focus moved to the first stop (the app's own record of where it put focus: XCUITest cannot read VoiceOver's cursor).
    XCTAssertTrue(label(el("map.list.focus"), contains: "focus=stop ", within: 5), "CTL-TEC-15-06 focus did not move to the first stop: \(el("map.list.focus").label)")
    settle()
    mark("MAP-ROWS stops=\(nStops) sub=\(sub)")
    // CTL-TEC-15-10 Open job opens SCR-TEC-04 for the next stop, on Today's stack (F-1072 item 2); its Back returns to Today.
    let nextName = el("map.next.name").label
    el("map.open").tap()
    jobOpened(nextName, "CTL-TEC-15-10 Open job")
    XCTAssertTrue(el("tab.today").isSelected, "CTL-TEC-15-10 the job screen is not on the Today tab")
    el("job.bar.back").tap()
    XCTAssertFalse(el("job.bar.title").waitForExistence(timeout: 3), "the job screen's Back did not leave it")
    mark("MAP-OPEN-JOB \(nextName)")
  }

  /// SCR-TEC-04 is open on the job of the customer named (F-1072 item 2): its bar's title is the customer's name.
  private func jobOpened(_ name: String, _ ctl: String) {
    XCTAssertFalse(name.isEmpty, "\(ctl): no customer name to look for")
    XCTAssertTrue(el("job.bar.title").waitForExistence(timeout: 30), "\(ctl) did not open the job screen (SCR-TEC-04)")
    let p = NSPredicate(format: "label ENDSWITH %@", name)
    XCTAssertTrue(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: el("job.bar.title"))], timeout: 20) == .completed,
      "\(ctl) opened \(el("job.bar.title").label), not \(name)'s job")
  }

  // why: FR-TECH-11, FR-TECH-8 CTL-TEC-15-02 each stop row of the Map tab's list opens SCR-TEC-04 for that stop's job (F-1072 item 2)
  func test04bStopRowOpensTheJob() throws {
    app.launch()
    tab("map")
    let row = el("map.stop.next.0")
    XCTAssertTrue(row.waitForExistence(timeout: 60), "CTL-TEC-15-02 the Next stop's row not shown")
    let name = el("map.next.name").label
    el("map.list").tap()
    Thread.sleep(forTimeInterval: 1)
    row.tap()
    jobOpened(name, "CTL-TEC-15-02 stop row")
    XCTAssertTrue(el("tab.today").isSelected, "CTL-TEC-15-02 the job screen is not on the Today tab")
    el("job.bar.back").tap()
    mark("MAP-STOP-ROW-OPENS-JOB \(name)")
  }

  // why: FR-TECH-5, FR-TECH-13, FR-MAP-1, FR-MAP-3 CTL-TEC-08-01 to -04 and CTL-CMP-09-01 Directions opens in the app, on the app's own map, with the destination, the drive time, Open the job and Back (DK-117's Back is CTL-CMP-09-01)
  func test05DirectionsInTheApp() throws {
    control("/rules/clear") // the Map frame's done stop (test01's rule) is for the Map dump; Directions reads the day as the server has it
    app.launch()
    tab("map")
    XCTAssertTrue(el("map.dir").waitForExistence(timeout: 60), "CTL-TEC-15-04 Directions button not shown")
    el("map.dir").tap()
    XCTAssertTrue(el("dir.bar.title").waitForExistence(timeout: 20), "CTL-TEC-08 Directions did not open in the app")
    XCTAssertTrue(label(el("dir.bar.title"), contains: "Directions"))
    XCTAssertTrue(el("dir.dest.who").waitForExistence(timeout: 20), "CTL-TEC-08-02 destination")
    XCTAssertFalse(el("dir.dest.who.tx.b").label.isEmpty, "CTL-TEC-08-02 the customer's name")
    XCTAssertTrue(label(el("dir.time.tx.b"), contains: "About", within: 30), "CTL-TEC-08-03 drive time")
    XCTAssertTrue(el("dir.map.osm").waitForExistence(timeout: 30), "CTL-TEC-08-01 the map and its credit")
    let c = drawn("dir.map", names: true)
    XCTAssertGreaterThan(c["base"] ?? 0, 0, "the Directions map is blank: \(c)")
    XCTAssertGreaterThan(c["streets"] ?? 0, 0, "the Directions map draws no street names: \(c)")
    XCTAssertGreaterThan(c["stops"] ?? 0, 0, "the Directions map shows no destination")
    settle()
    mark("DIRECTIONS \(el("dir.time.tx.b").label) streets=\(c["streets"] ?? 0)")
    // CTL-TEC-08-04 Open the job opens SCR-TEC-04 for the destination job (F-1072 item 2; Back, CTL-CMP-09-01, is checked below).
    let dest = el("dir.dest.who.tx.b").label
    el("dir.open").tap()
    jobOpened(dest, "CTL-TEC-08-04 Open the job")
    XCTAssertTrue(el("tab.today").isSelected, "CTL-TEC-08-04 the job screen is not on the Today tab")
    el("job.bar.back").tap()
    mark("DIRECTIONS-OPEN-JOB \(dest)")
    // CTL-CMP-09-01 (F-1074, DK-117's Back): Directions opened again, Back is there and opens Today; never skipped.
    tab("map")
    // the Directions screen stays on the Map tab's stack after Open the job; if it has gone, it is opened again
    if !el("dir.bar.back").waitForExistence(timeout: 5) {
      XCTAssertTrue(el("map.dir").waitForExistence(timeout: 30), "CTL-TEC-15-04 Directions button not shown for the Back check")
      el("map.dir").tap()
    }
    XCTAssertTrue(el("dir.bar.back").waitForExistence(timeout: 20), "CTL-CMP-09-01 Directions has no Back")
    el("dir.bar.back").tap()
    XCTAssertTrue(el("tab.today").waitForExistence(timeout: 10))
    XCTAssertTrue(el("tab.today").isSelected, "Back did not open Today")
    // F-1075: the route is answered with its first stop done again, so the last Map dump (test11's) is the frame's Done row state
    control("/rule?path=/api/v1/tech/day-route&do=firstdone&n=400")
    mark("DIRECTIONS-BACK")
  }

  // why: FR-TECH-15, FR-TECH-4, FR-TECH-7 CTL-TEC-10-01 to -03, -05 to -07, -10, -11 the Me screen's profile, van, hours, sync (a link to SCR-TEC-09, F-1072 item 3), server, call and version rows
  func test06MeDisplayRows() throws {
    app.launch()
    tab("me")
    XCTAssertTrue(el("me.profile.tx.b").waitForExistence(timeout: 60))
    XCTAssertTrue(label(el("me.profile.tx.b"), contains: "Maria Santos", within: 30), "CTL-TEC-10-01 profile name")
    XCTAssertEqual(el("me.avatar.text").label, "MS", "CTL-TEC-10-01 initials")
    XCTAssertTrue(el("me.profile.tx.small").label.hasPrefix("Technician"), "CTL-TEC-10-01 role line: \(el("me.profile.tx.small").label)")
    XCTAssertTrue(el("me.van.tx.b").label.hasPrefix("Van"), "CTL-TEC-10-06 van: \(el("me.van.tx.b").label)")
    XCTAssertTrue(el("me.hours.tx.b").label.hasPrefix("Started") || el("me.hours.tx.b").label == "Not started yet", "CTL-TEC-10-07 hours: \(el("me.hours.tx.b").label)")
    XCTAssertTrue(el("me.hours.tx.small").label.contains("Jobs done"), "CTL-TEC-10-07 jobs done")
    XCTAssertTrue(label(el("me.sync.tx.b"), contains: "All synced", within: 30), "CTL-TEC-10-02 sync: \(el("me.sync.tx.b").label)")
    XCTAssertFalse(el("me.sendnow").isEnabled, "CTL-TEC-10-03 Send now is on with nothing waiting")
    // CTL-TEC-10-02 (F-1072 item 3): the sync line is a link to SCR-TEC-09 Waiting to send, whose Back returns to Me.
    el("me.sync.tx.b").tap()
    XCTAssertTrue(el("wait.bar.title").waitForExistence(timeout: 20), "CTL-TEC-10-02 the sync row did not open Waiting to send")
    el("wait.bar.back").tap()
    XCTAssertTrue(el("me.sync.tx.b").waitForExistence(timeout: 20), "Waiting to send's Back did not return to Me")
    mark("ME-SYNC-OPENS-WAITING")
    XCTAssertEqual(el("me.server").value as? String, shown(need("BW_RELAY")), "CTL-TEC-10-05 server")
    XCTAssertEqual(el("me.call").value as? String, "(614) 555-0100", "CTL-TEC-10-10 Call dispatch number")
    XCTAssertTrue((el("me.version").value as? String ?? "").hasPrefix("Right On Time "), "CTL-TEC-10-11 version: \(String(describing: el("me.version").value))")
    settle()
    mark("ME-ROWS \(el("me.profile.tx.b").label) | \(el("me.van.tx.b").label) | \(el("me.hours.tx.b").label) | \(el("me.sync.tx.b").label)")
  }

  private func shown(_ origin: String) -> String {
    origin.replacingOccurrences(of: "http://", with: "").replacingOccurrences(of: "https://", with: "")
  }

  // why: FR-TECH-15, UD-43 CTL-TEC-10-08 the Notifications switch turns the in-app notices off and on, and the phone keeps the choice after the app closes
  func test07NotificationsSwitchIsKept() throws {
    app.launch()
    tab("me")
    let sw = el("me.notices.switch")
    XCTAssertTrue(sw.waitForExistence(timeout: 60))
    XCTAssertTrue(value(sw, is: "1"), "Notifications start on: \(String(describing: sw.value))")
    sw.tap()
    XCTAssertTrue(value(sw, is: "0"), "the switch did not turn off")
    app.terminate()
    app.launch()
    tab("me")
    XCTAssertTrue(value(el("me.notices.switch"), is: "0"), "the choice was not kept after the app closed")
    mark("NOTICES-KEPT off")
    el("me.notices.switch").tap()
    XCTAssertTrue(value(el("me.notices.switch"), is: "1"))
    mark("NOTICES-KEPT on")
  }

  // why: FR-TECH-15, NFR-06 CTL-TEC-10-09 Text size enlarges the app's text (the Me screen and, F-1072 item 6, the job screen on Today's stack) and the choice stays set after the app closes
  func test08TextSizeIsKeptAndEnlargesText() throws {
    app.launch()
    tab("me")
    let size = el("me.size")
    XCTAssertTrue(size.waitForExistence(timeout: 60))
    XCTAssertTrue(value(size, is: "Standard"), "Text size starts at Standard: \(String(describing: size.value))")
    let before = el("me.bar.title").frame.height
    let jobBefore = jobTitleHeight()
    tab("me")
    XCTAssertTrue(size.waitForExistence(timeout: 30))
    size.tap()
    let large = app.sheets.buttons["Large"].exists ? app.sheets.buttons["Large"] : app.buttons["Large"]
    XCTAssertTrue(large.waitForExistence(timeout: 10), "the size choices are not shown")
    large.tap()
    XCTAssertTrue(value(el("me.size"), is: "Large"))
    Thread.sleep(forTimeInterval: 1)
    let after = el("me.bar.title").frame.height
    XCTAssertGreaterThan(after, before, "Large did not enlarge the title (\(before) -> \(after))")
    // F-1072 item 6: the choice is the app's (its provider at the root), so the job screen on Today's stack is drawn at it too.
    let jobAfter = jobTitleHeight()
    XCTAssertGreaterThan(jobAfter, jobBefore, "CTL-TEC-10-09 Large did not enlarge the job screen's title (\(jobBefore) -> \(jobAfter))")
    mark("TEXT-SIZE-JOB-SCREEN \(jobBefore) -> \(jobAfter)")
    tab("me")
    app.terminate()
    app.launch()
    tab("me")
    XCTAssertTrue(value(el("me.size"), is: "Large", within: 30), "the size was not kept after the app closed")
    mark("TEXT-SIZE-KEPT Large \(before) -> \(after)")
    el("me.size").tap()
    let standard = app.sheets.buttons["Standard"].exists ? app.sheets.buttons["Standard"] : app.buttons["Standard"]
    XCTAssertTrue(standard.waitForExistence(timeout: 10))
    standard.tap()
    XCTAssertTrue(value(el("me.size"), is: "Standard"))
  }

  /// The job screen's title height (SCR-TEC-04, opened by the Next stop card's Open job), then back to the Map tab.
  private func jobTitleHeight() -> CGFloat {
    tab("map")
    XCTAssertTrue(el("map.open").waitForExistence(timeout: 60), "CTL-TEC-15-10 Open job not shown")
    el("map.open").tap()
    XCTAssertTrue(el("job.bar.title").waitForExistence(timeout: 30), "Open job did not open the job screen")
    Thread.sleep(forTimeInterval: 1)
    let h = el("job.bar.title").frame.height
    el("job.bar.back").tap()
    return h
  }

  // why: FR-LANG-1 CTL-CMP-03-01 the language control on Me re-renders the screen in Spanish at once and back
  func test09LanguageSwitchOnMe() throws {
    app.launch()
    tab("me")
    XCTAssertTrue(el("me.lang.es").waitForExistence(timeout: 60))
    el("me.lang.es").tap()
    XCTAssertTrue(label(el("tab.today"), contains: "Hoy", within: 10), "the tab bar did not re-render in Spanish: \(el("tab.today").label)")
    el("me.lang.en").tap()
    XCTAssertTrue(label(el("tab.today"), contains: "Today", within: 10))
    mark("LANGUAGE es-en")
  }

  /// The probe's note, saved on the phone (the confirm sheet's OK): 1 more item waits.
  private func queueNote(_ text: String) {
    let note = app.textViews["probe.note"].exists ? app.textViews["probe.note"] : app.textFields["probe.note"]
    XCTAssertTrue(note.waitForExistence(timeout: 30), "the probe's note box is not shown")
    note.tap()
    note.typeText(text)
    app.buttons["probe.queue"].tap()
    let ok = app.buttons["confirm.ok"]
    XCTAssertTrue(ok.waitForExistence(timeout: 10), "confirm sheet not shown")
    ok.tap()
    XCTAssertTrue(label(app.staticTexts["probe.count"], contains: "1", within: 20), "note not queued")
  }

  // why: FR-TECH-15, UD-20 CTL-TEC-10-03, -04 Send now is on with the signal on and a note waiting and sends it, off with no signal, Sign out is refused while a note waits, and Sign out works once it is sent
  func test10SignOutIsRefusedWhileAnItemWaits() throws {
    app.launch()
    tab("today")
    // CTL-TEC-10-03 (F-1074): Send now driven enabled. The relay holds the next send 40 s, so the note waits with the signal on; the button is on, a tap sends.
    control("/rule?path=/api/v1/tech/items&do=delay&ms=40000&n=1")
    queueNote("P6 map and Me: note for the Send now check.")
    tab("me")
    XCTAssertTrue(label(el("me.sync.tx.b"), contains: "waiting", within: 20), "CTL-TEC-10-02 sync says a note waits: \(el("me.sync.tx.b").label)")
    let enabled = NSPredicate(format: "isEnabled == true")
    XCTAssertEqual(XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: enabled, object: el("me.sendnow"))], timeout: 20), .completed, "CTL-TEC-10-03 Send now is off with the signal on and a note waiting")
    el("me.sendnow").tap()
    XCTAssertTrue(label(el("me.sync.tx.b"), contains: "All synced", within: 120), "Send now did not send the held note: \(el("me.sync.tx.b").label)")
    mark("SEND-NOW-ENABLED")
    tab("today")
    control("/signal/off")
    queueNote("P6 map and Me: note waiting for the sign-out check.")
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 2)
    app.activate()
    tab("me")
    XCTAssertTrue(el("nosig").waitForExistence(timeout: 60), "CTL-CMP-10-01 Me shows no No signal card with the signal off")
    XCTAssertTrue(label(el("me.sync.tx.b"), contains: "waiting", within: 20), "CTL-TEC-10-02 sync says what waits: \(el("me.sync.tx.b").label)")
    XCTAssertFalse(el("me.sendnow").isEnabled, "CTL-TEC-10-03 Send now is on with no signal")
    XCTAssertTrue(el("me.sendnow.why").waitForExistence(timeout: 5), "CTL-TEC-10-03 the reason (No signal)")
    el("me.signout").tap()
    XCTAssertTrue(label(el("me.refused.text"), contains: "still waiting to send", within: 10), "CTL-TEC-10-04 sign-out refusal: \(el("me.refused.text").label)")
    settle()
    mark("SIGNOUT-REFUSED \(el("me.refused.text").label)")
    control("/signal/on")
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 2)
    app.activate()
    tab("me")
    XCTAssertTrue(label(el("me.sync.tx.b"), contains: "All synced", within: 90), "the note was not sent once the signal returned")
    el("me.signout").tap()
    XCTAssertTrue(app.buttons["signin.server"].waitForExistence(timeout: 30), "Sign out did not open the sign-in screen")
    mark("SIGNED-OUT")
    // F-1069: after sign-out no read runs with the old token. Mark the relay, send the app home and back, wait longer than the 60 s timer, and
    // run.sh requires no bearer request between the 2 marks (and some before the first, so the reading can see one).
    control("/mark?name=SIGNOUT-PROBE-START")
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 3)
    app.activate()
    XCTAssertTrue(app.buttons["signin.server"].waitForExistence(timeout: 30), "the sign-in screen is not showing after the app came back")
    Thread.sleep(forTimeInterval: 65)
    control("/mark?name=SIGNOUT-PROBE-END")
    mark("SIGNOUT-PROBE waited 65 s")
  }

  // why: FR-MAP-1 the known-bad run: a map drawn without its lettering reports no street names, so the check test03 and test05 make cannot pass on a label-less map
  func test11KnownBadMapWithoutNamesFailsTheCheck() throws {
    app = launched(["-bwMapNames", "0"])
    app.launch()
    let signIn = app.buttons["probe.signin"]
    if signIn.waitForExistence(timeout: 20) { signIn.tap() }
    tab("map")
    XCTAssertTrue(el("map.view").waitForExistence(timeout: 60))
    // F-1074: the same check test03 makes (its zoom loop is what finds the names), run on the label-less map: it must come back with none.
    let c = drawn("map.view", names: true, within: 120)
    XCTAssertGreaterThan(c["base"] ?? 0, 0, "the known-bad map should still draw its shapes: \(c)")
    XCTAssertEqual(c["streets"] ?? -1, 0, "the label-less map reports street names: \(c)")
    mark("KNOWN-BAD-NO-NAMES streets=\(c["streets"] ?? -1) base=\(c["base"] ?? 0)")
  }

  // why: F-1368 CTL-TEC-10-04 the owner's build 4 case: signed in to a server that accepts the connection and never answers, Sign out on Me reaches the sign-in screen within 5 s, and a relaunch stays signed out
  func test12SignOutWithAServerThatNeverAnswers() throws {
    app.launch()
    let signIn = app.buttons["probe.signin"]
    if !el("tab.me").waitForExistence(timeout: 30) && signIn.exists { signIn.tap() }
    tab("me")
    let out = el("me.signout")
    XCTAssertTrue(out.waitForExistence(timeout: 20), "Sign out not shown on Me")
    // nothing waits (else CTL-TEC-10-04 refuses, which test10 covers)
    XCTAssertTrue(label(el("me.sync.tx.b"), contains: "All synced", within: 90), "an item waits before the silent-server sign-out: \(el("me.sync.tx.b").label)")
    // From here API-06 is accepted by the relay and never answered (signal-relay.mjs do=hold); run.sh checks the relay held exactly 1.
    control("/rule?path=/api/v1/sessions/current&do=hold&n=5")
    let start = Date()
    out.tap()
    let reached = app.buttons["signin.server"].waitForExistence(timeout: 30)
    let took = Date().timeIntervalSince(start)
    mark(String(format: "SIGNOUT-SILENT-SERVER reached=%@ seconds=%.2f", reached ? "yes" : "no", took))
    XCTAssertTrue(reached, "Sign out with a server that never answers did not open the sign-in screen")
    XCTAssertLessThan(took, 5, "Sign out with a server that never answers took \(took) s (the bound is 5 s)")
    // The phone's session is gone, not only the screen: a relaunch opens signed out.
    app.terminate()
    app.launch()
    XCTAssertTrue(app.buttons["signin.server"].waitForExistence(timeout: 30), "the relaunch after the silent-server sign-out is still signed in")
    control("/rule/clear")
    mark("SIGNOUT-SILENT-SERVER relaunch signed out")
  }
}
