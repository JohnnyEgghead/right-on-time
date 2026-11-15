// SPDX-License-Identifier: AGPL-3.0-or-later
// BwBrowser: the native app's in-app browser (UI-SPECIFICATION 8.1: "the email and set-password pages open in the in-app browser";
// CTL-EML-03-04 Open the email, native). It presents an http(s) page in SFSafariViewController over the app's top screen and answers once
// the browser is on screen; the page runs in Safari's own process, so the app shares no cookie or storage with it. Nothing else.
import ExpoModulesCore
import SafariServices
import UIKit

public class BwBrowserModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BwBrowser")

    // true: the browser is on screen; false: not an http(s) address, or no screen to present it over.
    AsyncFunction("open") { (address: String, promise: Promise) in
      guard let url = URL(string: address), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
            let top = BwBrowserModule.top() else {
        promise.resolve(false)
        return
      }
      let browser = SFSafariViewController(url: url)
      browser.dismissButtonStyle = .done
      top.present(browser, animated: true) { promise.resolve(true) }
    }.runOnQueue(.main)
  }

  static func top() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
    var vc = (windows.first { $0.isKeyWindow } ?? windows.first)?.rootViewController
    while let presented = vc?.presentedViewController { vc = presented }
    return vc
  }
}
