// SPDX-License-Identifier: AGPL-3.0-or-later
// why-file: FR-TECH-1, FR-TECH-2, FR-TECH-8, FR-TECH-9, FR-TECH-12, FR-TECH-13, FR-TECH-15, FR-TEXT-5, FR-AUTH-7, FR-AUTH-9, FR-AUTH-10, FR-IOS-1
// The native Today stack's XCUITest suite (P6-NATIVE-TODAY Acceptance), run by xcuitest/run.sh (BW_NATIVE_TESTS=TodayUITests) in the iOS
// Simulator on the owner's Mac against the Compose stack (Docker context desktop-linux). Like ShellUITests, the app's server is the signal
// relay (xcuitest/signal-relay.mjs): the test cuts the app's network path there, holds or drops one request of a path, answers one with
// 401, adds a late text to the day, answers a reset request as a server with the access code on, and reads what the relay forwarded (the
// API-102 sends: "On my way only after its confirm"; the Stay signed in flag of each sign-in; the in-app browser's GET of an email link).
// The tests run in name order on 1 install:
//   test0  the sign-in as shipped, typed: the secure password field, Show and Hide by what the field shows, Stay signed in on the sign-in
//   test1  SCR-TEC-01's states, SCR-EML-03 Forgot password (every result, Open the email in the in-app browser), the reviewer's empty day
//   test2  Maria Santos's day (SCR-TEC-02, -03, -13, -14): each state, the card's estimate and links (Directions, See history, Open job,
//          the list rows, Finish job), the late text, the waiting count's tap, the Notifications switch, the offline On my way sheet,
//          her items waiting, and every job walked to No one home
// Sign-ins after test0's are filled by the app's fill seam (SignIn.tsx, -bwLook with -bwProbeControl): the rig's sample sign-in in the fields
// as typed text would be, so no password is a launch argument; the fields are the shipped ones either way.
//
// Inputs (xcodebuild test environment, prefixed TEST_RUNNER_): BW_RELAY (the relay origin), BW_CONTROL (its control origin), BW_DEAD (unused here).
// Each step prints a NATIVE-<step> line; run.sh keeps them in the evidence log and reads the ledger against NATIVE-WALKED.
import XCTest

/// F-1782 (a): how far the sheet after the text shrinks may differ from the standard-text sheet, in points.
let SHEET_FIT_TOLERANCE: CGFloat = 8

final class TodayUITests: XCTestCase {
  private let env = ProcessInfo.processInfo.environment
  private var app: XCUIApplication!
  private var savePromptDismissed = false // this test's Save Password sheet has come and gone (F-1202)

  override func setUp() {
    continueAfterFailure = false
    app = XCUIApplication()
    app.launchArguments = ["-bwLook", "1", "-bwProbeControl", env["BW_CONTROL"] ?? "", "-bwServer", env["BW_RELAY"] ?? ""]
    _ = get("/signal/on") // a test that failed with the signal off leaves the next one a phone with signal
    _ = get("/rule/clear")
    _ = get("/textsize?to=large") // F-1743: a test that failed at the largest text leaves the next one the standard size
  }

  // ---- helpers -------------------------------------------------------------------------------------------------------------------

  private func need(_ name: String) -> String {
    guard let v = env[name], !v.isEmpty else { XCTFail("missing \(name)"); return "" }
    return v
  }

  private func mark(_ what: String) {
    print("NATIVE-\(what)")
  }

  /// Any element by its testID (a Pressable is a button, a Text a static text, a tab whatever UIKit calls it).
  private func el(_ id: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: id).firstMatch
  }

  private func exists(_ id: String, within s: TimeInterval = 20) -> Bool {
    if el(id).waitForExistence(timeout: min(s, 3)) { return true }
    dismissSavePrompt()
    return el(id).waitForExistence(timeout: max(s - 3, 1))
  }

  private func gone(_ id: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "exists == false")
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: el(id))], timeout: s) == .completed
  }

  private func get(_ path: String) -> String {
    let url = URL(string: need("BW_CONTROL") + path)!
    var out = ""
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: url) { data, _, _ in
      out = String(data: data ?? Data(), encoding: .utf8) ?? ""
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 10)
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func control(_ path: String) {
    _ = get(path)
    mark("CONTROL \(path)")
  }

  /// One-shot rule on a path of the stack: delay it, drop it, answer it 401, change the day it answers (relay: /rule).
  private func rule(_ path: String, _ action: String, ms: Int = 0, n: Int = 1) {
    _ = get("/rule?path=\(path)&do=\(action)&ms=\(ms)&n=\(n)")
    mark("RULE \(action) \(path)")
  }

  private func itemSends() -> Int {
    Int(get("/items/count")) ?? -1
  }

  /// The API-102 requests that reached the relay, counted on arrival (before a rule's delay), so a send made before a confirm is seen at once.
  private func itemArrivals() -> Int {
    Int(get("/items/arrived")) ?? -1
  }

  /// The Stay signed in flag of each API-03 sign-in the relay forwarded, in order.
  private func signins() -> [String] {
    get("/signins").split(separator: ",").map(String.init)
  }

  /// How many requests of a path prefix the relay forwarded.
  private func seen(_ prefix: String) -> Int {
    Int(get("/seen?prefix=\(prefix)")) ?? -1
  }

  private func credentials(_ who: String) -> (login: String, password: String, email: String) {
    let text = get("/probe/credentials?who=\(who)")
    let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: String] ?? [:]
    return (json["login"] ?? "", json["password"] ?? "", json["email"] ?? "")
  }

  private func label(_ id: String, is text: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "label == %@", text)
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: el(id))], timeout: s) == .completed
  }

  private func label(_ id: String, startsWith text: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "label BEGINSWITH %@", text)
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: el(id))], timeout: s) == .completed
  }

  private func label(_ id: String, matches regex: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "label MATCHES %@", regex)
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: el(id))], timeout: s) == .completed
  }

  private func value(_ id: String, is text: String, within s: TimeInterval = 20) -> Bool {
    let p = NSPredicate(format: "value == %@", text)
    return XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: p, object: el(id))], timeout: s) == .completed
  }

  /// Polls a condition (a count the relay keeps, a ledger step) until it holds or the time is up.
  private func eventually(_ s: TimeInterval = 30, _ cond: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(s)
    while Date() < end {
      if cond() { return true }
      Thread.sleep(forTimeInterval: 0.5)
    }
    return cond()
  }

  /// The look dump of the state on screen is written 0.9 s after it settles (src/ui/look.ts); 4 seconds cover it.
  private func settle() {
    Thread.sleep(forTimeInterval: 4)
  }

  private func shown(_ origin: String) -> String {
    origin.replacingOccurrences(of: "http://", with: "").replacingOccurrences(of: "https://", with: "")
  }

  /// iOS offers to save the password after a typed sign-in: a system sheet over the app (SafariViewService's, another process, shown in the
  /// app's window). Not Now, so the keyboard focus and the taps stay with the app. `within` 0 looks once, with no wait.
  /// F-1202 (the full suite's test0 reds, read frame by frame from the xcresult recordings): the sheet is in the accessibility tree about
  /// 0.2 s before its first frame and fades in for about 0.45 s, and a Not Now tap made in that entrance is dropped. The sheet then stays,
  /// with the app's elements still found under it, and the suite's next tap (tab.me) lands on the sheet's backdrop: it takes the sheet away
  /// and never reaches the app, so Me never opens. So the tap waits out the entrance, and the sheet must be gone after it: one still there
  /// is tapped once more (marked), and one that outlasts that fails here, by name.
  @discardableResult
  private func dismissSavePrompt(within s: TimeInterval = 1) -> Bool {
    let sheet = app.staticTexts["Save Password?"]
    guard (s > 0 ? sheet.waitForExistence(timeout: s) : sheet.exists) else { return false }
    Thread.sleep(forTimeInterval: 1) // the entrance is over (about 0.65 s from the first sight)
    for tap in 1...2 {
      let notNow = app.buttons["Not Now"]
      if notNow.exists { notNow.tap() } else {
        // the sheet is another process's: Not Now is at {51, 500.7} 140 x 48 on this phone
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 121, dy: 525)).tap()
      }
      let left = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: sheet)
      if XCTWaiter().wait(for: [left], timeout: 5) == .completed {
        mark("SAVE-PASSWORD-PROMPT dismissed (tap \(tap))")
        savePromptDismissed = true
        Thread.sleep(forTimeInterval: 1)
        return true
      }
      mark("SAVE-PASSWORD-PROMPT stayed after tap \(tap)")
    }
    XCTFail("the Save Password sheet stays over the app after 2 taps on Not Now")
    return false
  }

  /// Types into an empty field as a person does: a tap, the keyboard focus, then the keys. The focus is waited for (and the tap made again
  /// once), and a field that never takes it fails here, by name.
  /// Found in fix pass 1 (5 stack-free probes): the "no keyboard focus" of the earlier runs was the app's own, not the simulator's. Once a
  /// kit field had drawn its focus ring as a React Native `outline`, no field took the focus again; the ring is now a border (ui/kit.tsx).
  /// `blur` taps a plain element first (the keyboard goes) for a step that must start with no field focused.
  private func typeIn(_ field: XCUIElement, _ text: String, _ name: String, blur: String? = nil) {
    focusOn(field, name, blur: blur)
    // key by key at about a person's pace: a burst of XCUITest keys into a controlled React Native field can drop or reorder one
    // (run 3 typed "4012" for "40712"; fix pass 1 report)
    for key in text {
      field.typeText(String(key))
      Thread.sleep(forTimeInterval: 0.12)
    }
  }

  /// The tap that gives a field the keyboard focus (typeIn's first half).
  private func focusOn(_ field: XCUIElement, _ name: String, blur: String? = nil) {
    XCTAssertTrue(field.waitForExistence(timeout: 10), "\(name) is not shown")
    if let blur {
      el(blur).tap()
      _ = XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 0"), object: app.keyboards)], timeout: 5)
    }
    let focused = NSPredicate(format: "hasKeyboardFocus == true")
    for attempt in 1...2 {
      field.tap()
      if XCTWaiter().wait(for: [XCTNSPredicateExpectation(predicate: focused, object: field)], timeout: 5) == .completed { break }
      mark("NO-FOCUS \(name) tap \(attempt) keyboards=\(app.keyboards.count)")
    }
    XCTAssertTrue((field.value(forKey: "hasKeyboardFocus") as? Bool) == true, "\(name) never took the keyboard focus")
  }

  /// A new process with the same install: the server, the Keychain and the files stay; the sign-in form is empty.
  private func relaunch() {
    app.terminate()
    app.launch()
    XCTAssertTrue(exists("signin.submit", within: 30), "no sign-in screen after the relaunch")
  }

  private func submit(prompt: Bool = true) {
    el("signin.h2").tap() // the keyboard goes; the button is on screen
    let b = el("signin.submit")
    XCTAssertTrue(b.waitForExistence(timeout: 10))
    b.tap()
    if prompt { dismissSavePrompt() }
  }

  /// Fills the form with a sample sign-in the rig holds (SignIn.tsx fill seam), then the test presses Sign in as for a typed form.
  private func fill(_ who: String) {
    let b = el("fill.\(who)")
    XCTAssertTrue(b.waitForExistence(timeout: 10), "no fill seam for \(who)")
    b.tap()
    Thread.sleep(forTimeInterval: 1)
  }

  private func signOutIfSignedIn() {
    if el("signin.submit").waitForExistence(timeout: 8) { return }
    XCTAssertTrue(exists("tab.me", within: 20), "neither the sign-in screen nor the tabs")
    // F-1202: a Save Password sheet over the app takes the tab's tap for itself (its backdrop), so it goes first, and the tab must take taps
    dismissSavePrompt(within: 0)
    let me = el("tab.me")
    let reachable = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: me)
    XCTAssertTrue(XCTWaiter().wait(for: [reachable], timeout: 10) == .completed,
                  "tab.me takes no tap (covered; a Save Password sheet shown: \(app.staticTexts["Save Password?"].exists))")
    me.tap()
    XCTAssertTrue(exists("me.signout"))
    el("me.signout").tap()
    XCTAssertTrue(exists("signin.submit", within: 20), "sign-out did not open the sign-in screen")
  }

  /// The app's server is the relay (the Compose stack behind it): the launch passes it (-bwServer), as if SCR-TEC-12 had saved it; typing it is
  /// ShellUITests's. The Server row shows it.
  private func pointAtRelay() {
    let relay = need("BW_RELAY")
    XCTAssertTrue(exists("signin.server", within: 30), "sign-in screen not shown")
    XCTAssertTrue(value("signin.server", is: shown(relay), within: 10), "the Server row: \(String(describing: el("signin.server").value))")
  }

  /// A link by its identifier, else by its words as iOS names a link. See history and Open the email are their own Pressables (F-1105), so the
  /// identifier finds them; a link nested in a line of text is no accessibility element and is not reached this way.
  private func tapLink(_ id: String, _ words: String) {
    let byId = el(id)
    if byId.waitForExistence(timeout: 3) && byId.isHittable {
      byId.tap()
      return
    }
    let link = app.links[words]
    XCTAssertTrue(link.waitForExistence(timeout: 10), "no link \(words) (\(id))")
    link.tap()
  }

  /// The Job screen (SCR-TEC-04) is open on the job named; its Back returns to Today.
  private func jobOpened(_ name: String, _ ctl: String) -> CGFloat {
    XCTAssertTrue(exists("job.bar.title", within: 30), "\(ctl) did not open the job screen")
    XCTAssertTrue(eventually(20) { self.el("job.bar.title").label.hasSuffix(name) }, "\(ctl) opened \(el("job.bar.title").label), not \(name)")
    XCTAssertTrue(exists("job.ghead.hist", within: 30), "the job screen has no history heading")
    Thread.sleep(forTimeInterval: 1.5) // the See history scroll lands after the heading's layout
    return el("job.ghead.hist").frame.minY
  }

  private func backToToday(_ id: String) {
    XCTAssertTrue(exists(id, within: 10), "no \(id)")
    el(id).tap()
    XCTAssertTrue(exists("today.title", within: 20), "\(id) did not return to Today")
  }

  // ---- the sign-in as shipped, typed -----------------------------------------------------------------------------------------------

  // why: FR-AUTH-7, FR-AUTH-10, FR-IOS-1 the sign-in as shipped: the employee number and the password typed into the secure field, Show and Hide change what the field shows (the password as text, then hidden again), Stay signed in on this phone rides on the sign-in, and the typed sign-in opens Today
  func test0TypedSignInThroughTheShippedFields() throws {
    app.launch()
    pointAtRelay()
    let maria = credentials("maria")
    let login = app.textFields["signin.login.value"]
    let secure = app.secureTextFields["signin.password.value"]
    let plain = app.textFields["signin.password.value"]
    // CTL-TEC-01-02: the password field is a secure field, as shipped
    XCTAssertTrue(secure.waitForExistence(timeout: 10), "the password field is not a secure field")
    XCTAssertFalse(plain.exists, "the password field is plain text")
    Thread.sleep(forTimeInterval: 5) // a tap in the first seconds after a fresh install's launch gets no keyboard focus (KeyProbe run 1)

    // The email or employee number and the password, typed key by key (CTL-TEC-01-01 and -02)
    typeIn(login, maria.login, "the email or employee number field")
    XCTAssertEqual(login.value as? String, maria.login, "the typed employee number")
    typeIn(secure, maria.password, "the password field") // straight from the focused login field, as a person taps
    let hidden = (secure.value as? String) ?? ""
    XCTAssertEqual(hidden.count, maria.password.count, "the secure field holds \(hidden.count) characters, not the \(maria.password.count) typed")
    XCTAssertTrue(hidden != maria.password, "the secure field shows the password")
    mark("TYPED login and password")

    // CTL-TEC-01-03: Show turns the field into plain text with the typed password in it; Hide turns it back
    el("signin.show").tap()
    XCTAssertTrue(plain.waitForExistence(timeout: 5), "Show did not show the password as text")
    XCTAssertFalse(secure.exists, "Show left a secure field")
    XCTAssertTrue((plain.value as? String) == maria.password, "Show does not show the password typed")
    XCTAssertTrue(label("signin.show", is: "Hide", within: 5))
    el("signin.show").tap()
    XCTAssertTrue(secure.waitForExistence(timeout: 5), "Hide did not hide the password")
    XCTAssertFalse(plain.exists, "Hide left a plain field")
    XCTAssertTrue(((secure.value as? String) ?? "") != maria.password, "Hide still shows the password")
    XCTAssertTrue(label("signin.show", is: "Show", within: 5))
    mark("SHOW-HIDE by the field's type and value")

    // CTL-TEC-01-08: Stay signed in on this phone is off by default; on, the sign-in carries it (API-03 keepSignedIn)
    XCTAssertTrue(value("signin.stay", is: "0", within: 5), "Stay signed in is not off by default")
    el("signin.stay").tap()
    XCTAssertTrue(value("signin.stay", is: "1", within: 5), "Stay signed in did not turn on")
    let before = signins().count
    submit()
    XCTAssertTrue(exists("today.title", within: 45), "the typed sign-in did not open Today")
    // F-1202: iOS's Save Password sheet comes once the sign-in screen has gone, at times after submit()'s 1 s look for it (the full suite's
    // reds: seen 1.5 and 1.8 s after Sign in). Until it has come and gone, Today's elements are found under it but a tap meets the sheet.
    if !savePromptDismissed && !dismissSavePrompt(within: 10) { mark("SAVE-PASSWORD-PROMPT none in 10 s on Today") }
    XCTAssertTrue(eventually(10) { self.signins().count == before + 1 }, "the relay saw \(signins().count - before) sign-ins")
    XCTAssertEqual(signins().last, "true", "the sign-in did not carry Stay signed in")
    mark("TYPED-SIGNIN stay=\(signins().last ?? "?")")
    signOutIfSignedIn()
  }

  // ---- sign in (SCR-TEC-01), Forgot password (SCR-EML-03) and the reviewer's empty day ----------------------------------------------------------------------------

  /// SCR-EML-03 from Forgot password? (CTL-TEC-01-07): the native screen, its field empty and in focus.
  private func openForgot() {
    XCTAssertTrue(exists("signin.forgot", within: 20))
    el("signin.forgot").tap()
    XCTAssertTrue(exists("forgot.bar.title", within: 20), "Forgot password? opened no screen")
    XCTAssertTrue(label("forgot.bar.title", is: "Forgot password", within: 5))
  }

  /// Types an address and sends it (CTL-EML-03-01, -02); the result line is what the test reads.
  private func askReset(_ address: String) {
    typeIn(app.textFields["forgot.email.value"], address, "the reset email field")
    el("forgot.send").tap()
  }

  /// Leaves SCR-EML-03 by Back to sign in (CTL-EML-03-05) or by the bar's Sign in button.
  private func leaveForgot(bar: Bool = false) {
    el(bar ? "forgot.bar.back" : "forgot.back").tap()
    XCTAssertTrue(exists("signin.submit", within: 20), "\(bar ? "the bar's Sign in" : "Back to sign in") did not return to the sign-in screen")
  }

  // why: FR-AUTH-7, FR-AUTH-9, FR-IOS-1 the native sign-in takes an email or employee number and a password, shows each state of SCR-TEC-01 (empty fields, wrong details, turned off, no server), has no Sign in as list, Forgot password? opens the native SCR-EML-03 with each of its results and opens a sent email once in the in-app browser, and the reviewer (no technician row) meets an empty day on Today, not an error (F-252 item 7)
  func test1SignInStatesForgotPasswordAndTheReviewersEmptyDay() throws {
    app.launch()
    signOutIfSignedIn() // F-1209: a red test0 that left Maria signed in (Stay signed in on) must not make this a second red
    pointAtRelay()
    XCTAssertTrue(exists("signin.submit"), "no Sign in button")
    XCTAssertFalse(app.staticTexts["Sign in as"].exists, "a Sign in as list on the native sign-in")
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS[c] 'demo'")).firstMatch.exists, "demo wording on the native sign-in")

    // CTL-TEC-01-04: empty fields get field messages, nothing is sent
    let sends = itemSends()
    el("signin.submit").tap()
    XCTAssertTrue(exists("signin.login.msg.text", within: 5), "no message for the empty email or employee number")
    XCTAssertTrue(label("signin.login.msg.text", is: "Type your email or employee number."))
    XCTAssertTrue(exists("signin.password.msg.text", within: 5), "no message for the empty password")
    mark("EMPTY-FIELDS")

    // the Default frame: the form filled (the rig's wrong password for employee 40712), the password field in focus
    fill("wrong") // the Default dump's password focus comes from SignIn.tsx's pwFocus look seam (a filled form draws it), not from the fill
    XCTAssertEqual(app.textFields["signin.login.value"].value as? String, "40712")
    settle()
    mark("DEFAULT")

    // Signing in (the answer is held), then Wrong details
    rule("/api/v1/sessions", "delay", ms: 5000)
    submit(prompt: false)
    XCTAssertTrue(label("signin.submit", is: "Signing in", within: 5), "busy: \(el("signin.submit").label)")
    settle()
    mark("SIGNING-IN")
    XCTAssertTrue(label("signin.error.text", is: "That email, employee number or password is not right. Check them and try again.", within: 30))
    settle()
    mark("WRONG-DETAILS")

    // Turned off (employee 40713, whose account run.sh turned off)
    relaunch()
    fill("off")
    submit()
    XCTAssertTrue(label("signin.error.text", is: "This account is turned off. Ask your manager.", within: 30))
    settle()
    mark("TURNED-OFF")

    // Server unreachable: no signal
    relaunch()
    fill("off")
    control("/signal/off")
    submit()
    XCTAssertTrue(label("signin.error.text", startsWith: "Cannot reach the server at", within: 30), "unreachable: \(el("signin.error.text").label)")
    settle()
    mark("SERVER-UNREACHABLE")
    control("/signal/on")
    XCTAssertEqual(itemSends(), sends, "a sign-in attempt sent items")
    XCTAssertTrue(signins().allSatisfy { $0 == "false" || $0 == "true" }, "a sign-in the relay could not read: \(signins())")

    // The Forgot password screen (SCR-EML-03): its Default frame (the field empty and in focus), then a typed value that is not an email (the field message, CTL-EML-03-01), and Back to sign in
    relaunch()
    openForgot()
    focusOn(app.textFields["forgot.email.value"], "the reset email field")
    settle()
    mark("FORGOT-DEFAULT")
    askReset("not-an-address")
    XCTAssertTrue(label("forgot.email.msg.text", is: "Type an email address, like name@example.com.", within: 10), "no field message for an address that is not one")
    mark("FORGOT-NOT-AN-EMAIL")
    leaveForgot()
    // an address no account uses (CTL-EML-03-03), and the bar's Sign in button
    openForgot()
    askReset("nobody.here@brightwater.example")
    XCTAssertTrue(label("forgot.result.text", is: "No account uses that address. No email was sent.", within: 20), "no account: \(el("forgot.result.text").label)")
    mark("FORGOT-NO-ACCOUNT")
    leaveForgot(bar: true)
    // the turned-off account's address
    let off = credentials("off")
    openForgot()
    askReset(off.email)
    XCTAssertTrue(label("forgot.result.text", is: "This account is turned off. No email was sent. Ask your manager.", within: 20), "turned off: \(el("forgot.result.text").label)")
    mark("FORGOT-TURNED-OFF")
    leaveForgot()
    // Not available: the server refuses a signed-out phone before the access code (the relay answers as a server with the code on)
    let maria = credentials("maria")
    openForgot()
    rule("/api/v1/password-resets", "accesscode")
    askReset(maria.email)
    XCTAssertTrue(label("forgot.result.text", is: "Password reset is not available here. Ask your manager to reset it.", within: 20), "not available: \(el("forgot.result.text").label)")
    settle()
    mark("FORGOT-NOT-AVAILABLE")
    leaveForgot()
    // Sent: the reset email is in the on-screen inbox; Open the email opens its one-time link once, in the in-app browser (CTL-EML-03-04)
    openForgot()
    askReset(maria.email)
    XCTAssertTrue(label("forgot.result.text", startsWith: "We put a reset email in the on-screen email inbox for \(maria.email).", within: 20), "sent: \(el("forgot.result.text").label)")
    settle()
    mark("FORGOT-SENT")
    let opened = seen("/email/")
    tapLink("forgot.result.link", "Open the email")
    XCTAssertTrue(eventually(30) { self.seen("/email/") > opened }, "the in-app browser never asked the server for the email link")
    let done = app.buttons["Done"]
    XCTAssertTrue(done.waitForExistence(timeout: 30), "no in-app browser (its Done button)")
    mark("FORGOT-OPENED-IN-APP")
    done.tap()
    XCTAssertTrue(label("forgot.result.text", matches: "(?s).*This link was used\\.$", within: 20), "the link is offered again: \(el("forgot.result.text").label)")
    XCTAssertFalse(app.links["Open the email"].exists, "Open the email is still a link")
    mark("FORGOT-LINK-USED")
    leaveForgot()

    // the reviewer: signed in, Today answers an empty day, not an error
    relaunch()
    fill("reviewer")
    submit()
    XCTAssertTrue(exists("today.empty.text", within: 45), "Today did not answer for the reviewer")
    XCTAssertTrue(label("today.empty.text", is: "You have no jobs today.", within: 10), "reviewer Today: \(el("today.empty.text").label)")
    XCTAssertFalse(el("today.error").exists, "an error panel on the reviewer's Today")
    XCTAssertFalse(el("card.name").exists, "a next job card on the reviewer's Today")
    settle()
    mark("REVIEWER-EMPTY-DAY")
    signOutIfSignedIn()
  }

  // ---- Maria Santos's day -----------------------------------------------------------------------------------------------------------

  /// Fills Maria's sign-in and presses Sign in; `hold` is a one-shot rule on the next read of the day, set after the sign-in's own calls.
  private func signInMaria(hold: (action: String, ms: Int)? = nil, n: Int = 1) {
    fill("maria")
    if let hold { rule("/api/v1/tech/day", hold.action, ms: hold.ms, n: n) }
    submit()
  }

  /// One status action of the next job card: the button, the sheet's primary button, the status the card then shows.
  private func confirm(_ button: String, status: String) {
    XCTAssertTrue(exists(button, within: 20), "\(button) not shown")
    el(button).tap()
    XCTAssertTrue(exists("sheet.go", within: 20), "the confirm sheet for \(button) not shown")
    el("sheet.go").tap()
    XCTAssertTrue(gone("sheet.go", within: 20), "the sheet for \(button) stays after its confirm")
    XCTAssertTrue(exists("card.st.text", within: 20))
    XCTAssertTrue(label("card.st.text", is: status, within: 20), "after \(button): \(el("card.st.text").label)")
  }

  /// F-1743: the height of the On my way sheet (opened and cancelled); the sheet's own frame.
  private func sheetHeight() -> CGFloat {
    el("card.omw").tap()
    XCTAssertTrue(exists("sheet.go", within: 20), "no On my way sheet")
    settle()
    let h = el("sheet").frame.height
    el("sheet.cancel").tap()
    XCTAssertTrue(gone("sheet.go", within: 20), "Cancel did not close the sheet")
    return h
  }

  private func tab(_ name: String) {
    XCTAssertTrue(exists("tab.\(name)", within: 20), "no \(name) tab")
    el("tab.\(name)").tap()
  }

  /// The Me screen's Notifications switch (CTL-TEC-10-08) to on or off.
  private func notifications(_ on: Bool) {
    tab("me")
    let sw = el("me.notices.switch")
    XCTAssertTrue(sw.waitForExistence(timeout: 30))
    if (sw.value as? String) != (on ? "1" : "0") { sw.tap() }
    XCTAssertTrue(value("me.notices.switch", is: on ? "1" : "0", within: 5), "the Notifications switch did not turn \(on ? "on" : "off")")
    tab("today")
    XCTAssertTrue(exists("today.title", within: 20))
  }

  // why: F-1743, F-1782 the sheet at the largest text is the tall detent and the sheet after the text shrinks is the fitted height; UC-12, FR-TECH-1, FR-TECH-2, FR-TECH-8, FR-TECH-9, FR-TECH-12, FR-TECH-13, FR-TECH-15, FR-TEXT-5 Today shows each state of SCR-TEC-02 and the card's arrival estimate, its links open their screens (Directions, See history, Open job, the list rows, Finish job), a late text shows on the card, the waiting count opens Waiting to send, day-changed notices follow the Me switch, On my way / Arrived / No one home send only after their confirm (with the drive minutes and miles online, the no-signal line offline), a session ended with items waiting asks for the same technician, and every job can be walked to No one home; UC-12: Maria works her day end to end in the native app, from sign-in to All done, each status in the server's ledger once (run.sh), against the Compose stack from p5-checkpoint, the plan's stand-in for the hosted demo (installed by xcodebuild, not the Unlisted link)
  func test2TodayAndTheConfirmSteps() throws {
    app.launch()
    signOutIfSignedIn()
    pointAtRelay()

    // Offline, nothing saved: the first read of the day gets no answer
    // the sign-in's own send makes more reads of the day within a second: the reads of that second get no answer
    signInMaria(hold: ("drop", 0), n: 12)
    XCTAssertTrue(exists("today.empty.text", within: 45))
    XCTAssertTrue(label("today.empty.text", is: "No signal and no saved job list. Connect once to load today."))
    XCTAssertTrue(el("today.nosig").exists, "no No signal card")
    settle()
    mark("OFFLINE-NOTHING-SAVED")
    _ = get("/rule/clear") // the drops left over

    // The Refresh button reads the day again (CTL-TEC-02-08)
    el("today.refresh").tap()
    XCTAssertTrue(exists("card.name", within: 45), "Refresh did not load the day")
    XCTAssertFalse(el("today.nosig").exists, "the No signal card stays after the read")
    signOutIfSignedIn()

    // Loading: the first read of the day is held
    signInMaria(hold: ("delay", 6000))
    XCTAssertTrue(exists("today.skel", within: 20), "no Loading state")
    settle()
    mark("LOADING")
    XCTAssertTrue(exists("card.name", within: 45))

    // Success: the header, the card, the controls of the card
    XCTAssertTrue(label("sync.count", is: "All synced", within: 60))
    XCTAssertTrue(el("today.sub").label.contains("Van"), "header: \(el("today.sub").label)")
    XCTAssertTrue(el("today.sub").label.contains("done"), "header: \(el("today.sub").label)")
    XCTAssertTrue(el("card.dir").label.hasPrefix("Directions"), "Directions: \(el("card.dir").label)")
    XCTAssertTrue(el("card.call").exists, "no Call button")
    XCTAssertTrue(el("card.open").exists, "no Open job button")
    XCTAssertTrue(el("card.omw").isEnabled, "On my way is off for the first job")
    XCTAssertFalse(el("card.noh").isEnabled, "No one home is on before Arrived")
    XCTAssertFalse(el("card.finish").isEnabled, "Finish job is on before Arrived")
    // F-1106, CTL-TEC-02-02: the arrival estimate when online
    XCTAssertTrue(label("card.eta.text", matches: "^Arrive about [0-9]{1,2}:[0-9]{2} [AP]M if you leave now$", within: 20), "the card's estimate: \(el("card.eta.text").label)")
    mark("CARD-ETA \(el("card.eta.text").label)")
    mark("DIRECTIONS \(el("card.dir").label)")
    let name = el("card.name").label

    // CTL-TEC-02-03 Directions: SCR-TEC-08 for the next job, and back
    el("card.dir").tap()
    XCTAssertTrue(exists("dir.bar.title", within: 30), "Directions did not open SCR-TEC-08")
    XCTAssertTrue(label("dir.bar.title", is: "Directions", within: 10))
    mark("DIRECTIONS-OPENED")
    backToToday("dir.bar.back")
    // CTL-TEC-02-12 Open job: SCR-TEC-04 for the next job, at its top
    el("card.open").tap()
    let topY = jobOpened(name, "Open job")
    mark("OPEN-JOB history heading at \(Int(topY))")
    backToToday("job.bar.back")
    // CTL-TEC-02-13 See history: the same job, at its service history
    tapLink("card.history", "See history")
    let historyY = jobOpened(name, "See history")
    XCTAssertTrue(historyY < topY - 40, "See history did not open at the service history (heading at \(Int(historyY)), at \(Int(topY)) from Open job)")
    mark("SEE-HISTORY history heading at \(Int(historyY))")
    backToToday("job.bar.back")
    // CTL-TEC-02-01: a row of Later today opens its job
    let later = el("today.later.0.name").label
    el("today.later.0").tap()
    _ = jobOpened(later, "a Later today row")
    mark("LATER-ROW \(later)")
    backToToday("job.bar.back")
    // CTL-CMP-10-02: the waiting count opens Waiting to send (SCR-TEC-09, on Me's stack)
    el("sync.count").tap()
    XCTAssertTrue(exists("wait.bar.title", within: 20), "the waiting count did not open Waiting to send")
    mark("WAITING-OPENED \(el("wait.bar.title").label)")
    el("wait.bar.back").tap()
    tab("today")
    XCTAssertTrue(exists("card.omw", within: 20))
    mark("TODAY-SUCCESS")

    // CTL-TEC-02-07 and -02-15: a late text on the next job (as FR-TEXT-5's worker sends one): the card says the new time and when the
    // customer was told
    rule("/api/v1/tech/day", "late", n: 3)
    el("today.refresh").tap()
    XCTAssertTrue(label("card.late.text", matches: "^New arrival time +About [0-9]{1,2}:[0-9]{2} [AP]M, 25 min late, was [0-9]{1,2}:[0-9]{2} [AP]M$", within: 30),
                  "the late card: \(el("card.late.text").label)")
    XCTAssertTrue(label("card.texted.text", matches: "^.+ was texted the new time automatically at [0-9]{1,2}:[0-9]{2} [AP]M\\. Only 1 late text per visit\\.$", within: 10),
                  "the late notice: \(el("card.texted.text").label)")
    // the label is drawn in capitals (DK-117 .lab), so iOS reads it so
    XCTAssertTrue(label("card.label", is: "NEXT JOB - RUNNING LATE", within: 5), "the card's label: \(el("card.label").label)")
    mark("LATE \(el("card.late.text").label)")
    _ = get("/rule/clear")
    el("today.refresh").tap()
    XCTAssertTrue(gone("card.late.text", within: 30), "the late text stays after a read without one")

    // CTL-TEC-02-14 with the Me switch off: a changed day raises no notice. This is CTL-TEC-10-08's proof on Today (F-1072 item 4): the Me
    // switch is the shared reads' noticesOn, and Today shows only the notices those reads raise (1 read of the day, item 5).
    notifications(false)
    rule("/api/v1/tech/day", "dropjob")
    el("today.refresh").tap()
    Thread.sleep(forTimeInterval: 8)
    XCTAssertFalse(el("today.notice.text").exists, "a day-changed notice with Notifications off")
    el("today.refresh").tap() // the job comes back, again with no notice
    Thread.sleep(forTimeInterval: 5)
    XCTAssertFalse(el("today.notice.text").exists, "a day-changed notice with Notifications off")
    mark("NOTICES-OFF none shown")
    notifications(true)
    // CTL-TEC-02-14: the day changed notice (a job left the day, then came back)
    rule("/api/v1/tech/day", "dropjob")
    el("today.refresh").tap()
    XCTAssertTrue(exists("today.notice.text", within: 30), "no day changed notice")
    XCTAssertTrue(el("today.notice.text").label.hasPrefix("Your day changed:"), el("today.notice.text").label)
    mark("DAY-CHANGED \(el("today.notice.text").label)")
    // the next read (the app's own, or this Refresh) brings the job back: a notice says it was added; each notice leaves after 6 s
    el("today.refresh").tap()
    XCTAssertTrue(eventually(40) { self.el("today.notice.text").exists && self.el("today.notice.text").label.hasSuffix("was added.") }, "no notice for the job that came back: \(el("today.notice.text").label)")
    XCTAssertTrue(gone("today.notice.text", within: 20), "the notice stays")

    // the first job: On my way only after its confirm
    var walked = 0
    let base = itemSends()
    let arrivedBase = itemArrivals()
    rule("/api/v1/tech/items", "delay", ms: 18000)
    el("card.omw").tap()
    XCTAssertTrue(exists("sheet.go", within: 20), "no On my way sheet")
    XCTAssertTrue(exists("sheet.title"))
    // F-1106, CTL-TEC-03-04 and -05: the arrival, the drive minutes and miles from the van, and the text the customer gets
    XCTAssertTrue(label("sheet.eta.text", matches: "^Arriving about [0-9]{1,2}:[0-9]{2} [AP]M$", within: 10), "the sheet's arrival: \(el("sheet.eta.text").label)")
    XCTAssertTrue(label("sheet.eta.small", matches: "^[0-9]+ min drive, [0-9]+\\.[0-9] mi - (inside|outside) the .+ window$", within: 10), "the sheet's drive line: \(el("sheet.eta.small").label)")
    XCTAssertTrue(el("sheet.preview.bubble").label.contains("bw.j7l.io/m/"), "the text preview: \(el("sheet.preview.bubble").label)")
    mark("SHEET-OMW-ETA \(el("sheet.eta.text").label) / \(el("sheet.eta.small").label)")
    settle()
    mark("SHEET-OMW")
    XCTAssertEqual(itemSends(), base, "On my way sent before its confirm")
    XCTAssertEqual(itemArrivals(), arrivedBase, "On my way reached the relay before its confirm")
    el("sheet.cancel").tap()
    XCTAssertTrue(gone("sheet.go", within: 20), "Cancel did not close the sheet")
    Thread.sleep(forTimeInterval: 3)
    XCTAssertEqual(itemSends(), base, "Cancel sent something")
    XCTAssertEqual(itemArrivals(), arrivedBase, "Cancel sent a request")
    XCTAssertTrue(label("card.st.text", is: "Scheduled", within: 5), "Cancel changed the job: \(el("card.st.text").label)")
    XCTAssertFalse(el("card.wait.text").exists, "Cancel saved an item")

    // F-1743: the sheet's detent at the largest text. Standard text: the fitted height; the largest text: the tall detent (0.92), scrolling.
    // The phone's size is set through the relay and the app is closed and opened again (a running app does not redraw at a new size).
    let standardH = sheetHeight()
    _ = get("/textsize?to=accessibility-extra-extra-extra-large")
    app.terminate()
    app.launch()
    XCTAssertTrue(exists("card.omw", within: 60), "no Today at the largest text")
    let bigH = sheetHeight()
    let window = app.windows.firstMatch.frame.height
    mark("SHEET-DETENT standard=\(Int(standardH)) big=\(Int(bigH)) window=\(Int(window))")
    _ = get("/textsize?to=large")
    app.terminate()
    app.launch()
    XCTAssertTrue(exists("card.omw", within: 60), "no Today after the text size went back")
    // F-1782 (a), F-1743: after the text shrinks the sheet is measured again and is the fitted height, not only not tall
    // F-1792: this measurement follows a cold relaunch, so it repeats standardH; a fail-before run reds at an earlier step. The in-place shrink
    // path (Sheets.tsx setOptions effect on big) cannot be walked on the simulator: a running app does not redraw on a live text-size change
    // (measured in P8-A11Y-TOOLS, F-1627 fix pass; the size reaches useWindowDimensions().fontScale only by a relaunch). That path reads
    // correct (big comes from fontScale and the effect depends on big); the walk that covers the size change is this relaunch one.
    let afterH = sheetHeight()
    mark("SHEET-DETENT-AFTER after=\(Int(afterH)) standard=\(Int(standardH)) tolerance=\(SHEET_FIT_TOLERANCE)")
    XCTAssertEqual(afterH, standardH, accuracy: SHEET_FIT_TOLERANCE, "the sheet after the text shrank is not the fitted height: \(afterH) against \(standardH)")
    XCTAssertGreaterThan(bigH, standardH + 60, "the sheet at the largest text is not taller than the fitted one")
    XCTAssertGreaterThan(bigH, window * 0.8, "the sheet at the largest text is not at the tall detent: \(bigH) of \(window)")
    XCTAssertLessThan(standardH, window * 0.8, "the sheet at standard text is at the tall detent: \(standardH) of \(window)")
    mark("SHEET-DETENT-BIG")

    confirm("card.omw", status: "On the way")
    XCTAssertTrue(exists("card.wait.text", within: 10), "no Waiting to send")
    XCTAssertTrue(label("card.wait.text", is: "Waiting to send", within: 5))
    settle()
    mark("PENDING-STATUS")
    XCTAssertEqual(itemSends(), base, "the held send already arrived")
    XCTAssertTrue(eventually(60) { itemSends() == base + 1 }, "On my way never reached the server")

    // Arrived: Cancel saves nothing, Arrived sends
    XCTAssertTrue(gone("card.wait.text", within: 30) || label("card.wait.text", is: "Sent", within: 5))
    el("card.arrived").tap()
    XCTAssertTrue(exists("sheet.go", within: 20), "no Arrived sheet")
    settle()
    mark("SHEET-ARRIVED")
    el("sheet.cancel").tap()
    XCTAssertTrue(gone("sheet.go", within: 20))
    Thread.sleep(forTimeInterval: 2)
    XCTAssertEqual(itemSends(), base + 1, "Cancel on Arrived sent something")
    rule("/api/v1/tech/items", "delay", ms: 1000)
    confirm("card.arrived", status: "On site")
    XCTAssertTrue(eventually(60) { itemSends() == base + 2 }, "Arrived never reached the server")
    XCTAssertTrue(el("card.finish").isEnabled, "Finish job is off On site")
    XCTAssertTrue(el("card.noh").isEnabled, "No one home is off On site")
    // CTL-TEC-02-06 Finish job: SCR-TEC-07 for the job, and back by its Job button
    el("card.finish").tap()
    XCTAssertTrue(exists("fin.bar.title", within: 30), "Finish job did not open SCR-TEC-07")
    XCTAssertTrue(label("fin.bar.title", is: "Finish job", within: 10))
    mark("FINISH-OPENED")
    backToToday("fin.bar.back")
    XCTAssertTrue(exists("card.noh", within: 10))

    // No one home, online: the sheet, Cancel
    el("card.noh").tap()
    XCTAssertTrue(exists("sheet.go", within: 20), "no No one home sheet")
    settle()
    mark("SHEET-NOH")
    el("sheet.cancel").tap()
    XCTAssertTrue(gone("sheet.go", within: 20))
    Thread.sleep(forTimeInterval: 2)
    XCTAssertEqual(itemSends(), base + 2, "Cancel on No one home sent something")

    // Offline, saved day: no signal, the job's No one home waits on the phone (the sheet's no-signal line, CTL-TEC-14-01)
    control("/signal/off")
    el("today.refresh").tap()
    XCTAssertTrue(exists("today.nosig", within: 30), "no No signal card")
    el("card.noh").tap()
    XCTAssertTrue(exists("sheet.go", within: 20))
    XCTAssertTrue(label("sheet.offline", is: "It is saved on this phone and sends when the signal returns.", within: 5), "the No one home sheet's no-signal line: \(el("sheet.offline").label)")
    el("sheet.go").tap()
    XCTAssertTrue(exists("today.done.0", within: 20), "the job is not in the done list")
    XCTAssertTrue(exists("today.savedline.pill.text", within: 20), "no waiting count in the saved line")
    settle()
    mark("OFFLINE-SAVED")
    Thread.sleep(forTimeInterval: 3)
    XCTAssertEqual(itemSends(), base + 2, "No one home left with no signal")
    control("/signal/on")
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 2)
    app.activate()
    XCTAssertTrue(eventually(90) { itemSends() == base + 3 }, "No one home never reached the server after the signal returned")
    XCTAssertTrue(gone("today.nosig", within: 60), "the No signal card stays after the signal returned")
    walked = 1
    mark("FIRST-JOB-DONE")

    // Success with a done row; a done row opens its job (CTL-TEC-02-01)
    XCTAssertTrue(exists("card.omw", within: 30), "no next job after the first")
    settle()
    mark("SUCCESS-WITH-DONE")
    let doneName = el("today.done.0.name").label
    el("today.done.0").tap()
    _ = jobOpened(doneName, "a done row")
    mark("DONE-ROW \(doneName)")
    backToToday("job.bar.back")

    // CTL-TEC-03-01 offline: On my way with no signal shows the no-signal lines and no estimate; Cancel sends nothing
    let offBase = itemSends()
    control("/signal/off")
    el("today.refresh").tap()
    XCTAssertTrue(exists("today.nosig", within: 30), "no No signal card")
    el("card.omw").tap()
    XCTAssertTrue(exists("sheet.go", within: 20), "no On my way sheet offline")
    XCTAssertTrue(label("sheet.offline", is: "The text goes out when your phone sends this. If you tap Arrived first, no text goes out.", within: 5), "the offline On my way line: \(el("sheet.offline").label)")
    XCTAssertFalse(el("sheet.eta").exists, "an arrival estimate with no signal")
    mark("SHEET-OMW-OFFLINE")
    el("sheet.cancel").tap()
    XCTAssertTrue(gone("sheet.go", within: 20))
    control("/signal/on")
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 2)
    app.activate()
    XCTAssertTrue(gone("today.nosig", within: 60), "the No signal card stays after the signal returned")
    XCTAssertEqual(itemSends(), offBase, "Cancel on the offline On my way sent something")

    // the New day state (the answer carries the next date, then the list is read again)
    let before = el("today.sub").label
    rule("/api/v1/tech/day", "nextday")
    rule("/api/v1/tech/day", "delay", ms: 15000)
    // the app coming back to the foreground reads the day (a tap on Refresh waits for the app to idle, which the held read does not allow)
    XCUIDevice.shared.press(.home)
    Thread.sleep(forTimeInterval: 1)
    app.activate()
    XCTAssertTrue(exists("today.skel", within: 20), "no New day state")
    XCTAssertNotEqual(el("today.sub").label, before, "the header kept the old date")
    settle()
    mark("NEW-DAY \(el("today.sub").label)")
    XCTAssertTrue(exists("card.omw", within: 45), "the list did not come back after the new day")

    // the second job: its On my way waits, and the session ends with 401 on the send (items waiting, UD-20)
    rule("/api/v1/tech/items", "unauth")
    el("card.omw").tap()
    XCTAssertTrue(exists("sheet.go", within: 20))
    el("sheet.go").tap()
    XCTAssertTrue(exists("signin.submit", within: 60), "the 401 did not end the session")
    XCTAssertTrue(exists("signin.info.text", within: 20), "no Items waiting notice")
    XCTAssertTrue(label("signin.info.text", is: "1 item is waiting to send. Sign in as Maria Santos to send it."), el("signin.info.text").label)
    XCTAssertEqual(app.textFields["signin.login.value"].value as? String, "Maria Santos", "the sign-in name is not the waiting technician's")
    settle()
    mark("ITEMS-WAITING")
    fill("maria")
    submit()
    XCTAssertTrue(exists("card.name", within: 60), "no Today after signing in again")
    XCTAssertTrue(eventually(90) { itemSends() == base + 4 }, "the waiting On my way never reached the server")
    XCTAssertTrue(label("card.st.text", is: "On the way", within: 30), el("card.st.text").label)

    // every job to No one home (the second one is already On the way)
    var onTheWay = true
    var rounds = 0
    while el("card.name").exists && rounds < 20 {
      rounds += 1
      if !onTheWay { confirm("card.omw", status: "On the way") }
      confirm("card.arrived", status: "On site")
      el("card.noh").tap()
      XCTAssertTrue(exists("sheet.go", within: 20))
      el("sheet.go").tap()
      walked += 1
      onTheWay = false
      // the card moves on to the next job (Scheduled), or leaves when the day is done
      XCTAssertTrue(eventually(40) { !self.el("card.st.text").exists || self.el("card.st.text").label == "Scheduled" }, "No one home did not move the card on")
    }
    XCTAssertTrue(exists("today.empty.text", within: 60), "no All done state")
    XCTAssertTrue(label("today.empty.text", startsWith: "All ", within: 10), el("today.empty.text").label)
    settle()
    mark("ALL-DONE \(el("today.empty.text").label)")
    let jobs = Int(el("today.empty.text").label.split(separator: " ").dropFirst().first ?? "0") ?? 0
    XCTAssertEqual(walked, jobs, "walked \(walked) of \(jobs) jobs")
    XCTAssertTrue(eventually(90) { self.itemSends() == base + 3 * jobs }, "the ledger is not complete: \(self.itemSends()) of \(base + 3 * jobs)")
    mark("WALKED jobs=\(jobs)")
  }
}
