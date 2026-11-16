// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-IOS-4
// The App Store screenshots (P8-APPSTORE): the app signed in as Maria Santos on the Compose stack's sample world, 1 PNG per screen, written
// to the folder TEST_RUNNER_BW_SHOTS names (the Simulator shares this Mac's files). Run by xcuitest/run.sh with BW_NATIVE_TESTS=ScreenshotsUITests
// on a simulator of the size the listing needs (BW_SIM_UDID). Each screen is also checked: no text on it holds "demo" (FR-IOS-4).
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_): BW_RELAY (optional, F-1718), BW_CONTROL, BW_SHOTS.
import XCTest

final class ScreenshotsUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-bwLook", "1", "-bwProbeControl", env["BW_CONTROL"] ?? ""]
    // F-1718: with BW_RELAY the app's server is the local relay (the Me screen then shows its 127.0.0.1 address); with none the app keeps
    // its own default server, https://bw.j7l.io, and the Me screen shows that (xcuitest/shots-hosted.sh).
    if let relay = env["BW_RELAY"], !relay.isEmpty { app.launchArguments += ["-bwServer", relay] }
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

  /// The screen as a PNG named <n>-<name>.png, after a short settle (the map and the photos draw late), and no "demo" in any text on it.
  private func shot(_ n: Int, _ name: String, settle: TimeInterval = 3) {
    Thread.sleep(forTimeInterval: settle)
    let demo = NSPredicate(format: "label CONTAINS[c] 'demo' OR value CONTAINS[c] 'demo'")
    XCTAssertEqual(app.descendants(matching: .any).matching(demo).count, 0, "\(name): a text on the screen holds demo")
    let dir = env["BW_SHOTS"] ?? ""
    XCTAssertFalse(dir.isEmpty, "no BW_SHOTS folder")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let png = XCUIScreen.main.screenshot().pngRepresentation
    let path = "\(dir)/\(n)-\(name).png"
    XCTAssertTrue(FileManager.default.createFile(atPath: path, contents: png), "could not write \(path)")
    print("NATIVE-SHOT \(n)-\(name) \(png.count) bytes")
  }

  // why: FR-IOS-4 the App Store screenshots show the shipped screens with no demo wording on any of them
  func test0Shots() {
    app.launch()
    let fill = el("fill.maria")
    XCTAssertTrue(fill.waitForExistence(timeout: 60), "no sign-in screen or fill seam")
    fill.tap()
    Thread.sleep(forTimeInterval: 1)
    el("signin.h2").tap()
    el("signin.submit").tap()
    dismissSavePrompt()
    XCTAssertTrue(el("card.name").waitForExistence(timeout: 60), "Today did not show Maria's next job")
    shot(1, "today")

    // F-1718: Directions opens from Today's card too, and a job already On site (the hosted sample day is shared) has no Directions on its page
    if el("card.dir").waitForExistence(timeout: 10) {
      el("card.dir").tap()
      XCTAssertTrue(el("dir.bar.title").waitForExistence(timeout: 30), "Directions did not open")
      shot(3, "directions", settle: 8)
      let back = el("dir.bar.back")
      if back.exists { back.tap() }
      XCTAssertTrue(el("card.open").waitForExistence(timeout: 20), "Today did not come back from Directions")
    }

    el("card.open").tap()
    XCTAssertTrue(el("job.bar.title").waitForExistence(timeout: 30), "the job page did not open")
    shot(2, "job")

    let jobBack = el("job.bar.back")
    if jobBack.exists { jobBack.tap() }

    if el("tab.map").waitForExistence(timeout: 20) {
      el("tab.map").tap()
      shot(4, "map", settle: 8)
    }
    if el("tab.me").waitForExistence(timeout: 20) {
      el("tab.me").tap()
      shot(5, "me")
    }
  }
}
