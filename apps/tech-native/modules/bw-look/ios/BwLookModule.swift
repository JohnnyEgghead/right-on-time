// SPDX-License-Identifier: AGPL-3.0-or-later
// BwLook: reads what UIKit actually draws for each tagged view (accessibilityIdentifier, React Native's testID), for the look values
// comparator (P6-NATIVE-SHELL; ci/look-values/native-compare.ts). It reads, never writes, and runs only when JavaScript asks (the app's
// look mode, launch argument "-bwLook 1"). Per view: its size in points, its background color, its layer border when UIKit draws the
// border itself (a uniform border on a clipping view), and for text the first run's face (the typographic family and the OS/2 weight
// class read from the font file's own tables, so a face that failed to load and fell back to the system font shows as such), its
// point size, color and paragraph line height. A text field reports its UITextField's font and color; an icon its SVG view's color.
//
// F-988: the reader is compiled only into the XCUITest rig's build (the BW_RIG compilation flag, set by BwLook.podspec unless the project was
// generated for the TestFlight archive: BW_RELEASE=1 xcuitest/prebuild.sh). A release build keeps the module, empty, so the generated
// module list still names it, and holds no code that reads the view hierarchy.
#if BW_RIG
import CoreText
import ExpoModulesCore
import UIKit

public class BwLookModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BwLook")

    AsyncFunction("read") { (ids: [String]) -> [String: [String: Any]] in
      let wanted = Set(ids)
      var out: [String: [String: Any]] = [:]
      for window in BwLookModule.windows() {
        BwLookModule.walk(window) { view in
          guard let id = view.accessibilityIdentifier, wanted.contains(id), out[id] == nil, !view.isHidden, view.window != nil else { return }
          out[id] = BwLookModule.describe(view)
        }
      }
      return out
    }.runOnQueue(.main)
  }

  static func windows() -> [UIWindow] {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
  }

  static func walk(_ view: UIView, _ visit: (UIView) -> Void) {
    visit(view)
    for sub in view.subviews { walk(sub, visit) }
  }

  static func rgba(_ c: UIColor?, _ traits: UITraitCollection) -> [Double]? {
    guard let c = c?.resolvedColor(with: traits) else { return nil }
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    guard c.getRed(&r, green: &g, blue: &b, alpha: &a) else { return nil }
    return [Double(r) * 255, Double(g) * 255, Double(b) * 255, Double(a)]
  }

  static func cg(_ c: CGColor?) -> UIColor? {
    guard let c else { return nil }
    return UIColor(cgColor: c)
  }

  static func describe(_ view: UIView) -> [String: Any] {
    let t = view.traitCollection
    var d: [String: Any] = [
      "class": String(describing: type(of: view)),
      "width": Double(view.bounds.width),
      "height": Double(view.bounds.height),
    ]
    if let bg = rgba(view.backgroundColor, t) { d["background"] = bg }
    if view.layer.borderWidth > 0 {
      d["borderWidth"] = Double(view.layer.borderWidth)
      if let bc = rgba(cg(view.layer.borderColor), t) { d["borderColor"] = bc }
    }
    if let field = firstSubview(view, UITextField.self) {
      if let f = field.font { d["font"] = face(f) }
      if let c = rgba(field.textColor, t) { d["color"] = c }
      // F-988, F-1111: a secure (password) field's text is never written to the dump, nor is the text of any field typed as a password or a code
      // (Show password makes the field plain text; the dumps are evidence and a sample password must not reach them).
      let hidden = field.isSecureTextEntry || field.textContentType == .password || field.textContentType == .newPassword || field.textContentType == .oneTimeCode
      d["text"] = hidden ? "" : (field.text ?? "")
    } else if let area = firstSubview(view, UITextView.self) {
      // A multiline text input (SCR-TEC-05's note): UIKit's text view, its font and color as for a field (P6-NATIVE-JOB).
      if let f = area.font { d["font"] = face(f) }
      if let c = rgba(area.textColor, t) { d["color"] = c }
      d["text"] = area.text ?? ""
    } else if view.responds(to: Selector(("attributedText"))),
      let a = view.value(forKey: "attributedText") as? NSAttributedString, a.length > 0 {
      let attrs = a.attributes(at: 0, effectiveRange: nil)
      if let f = attrs[.font] as? UIFont { d["font"] = face(f) }
      if let c = rgba(attrs[.foregroundColor] as? UIColor, t) { d["color"] = c }
      if let p = attrs[.paragraphStyle] as? NSParagraphStyle {
        d["minLineHeight"] = Double(p.minimumLineHeight)
        d["maxLineHeight"] = Double(p.maximumLineHeight)
      }
      d["text"] = a.string
    }
    // An icon: react-native-svg keeps the color its strokes draw with (currentColor) as the SVG view's own color property.
    if String(describing: type(of: view)).hasPrefix("RNSVG"), view.responds(to: Selector(("color"))),
      let c = rgba(view.value(forKey: "color") as? UIColor, t) {
      d["tint"] = c
    }
    return d
  }

  static func firstSubview<T: UIView>(_ view: UIView, _ type: T.Type, where ok: (UIView) -> Bool = { _ in true }) -> T? {
    if let v = view as? T, ok(v) { return v }
    for sub in view.subviews { if let f = firstSubview(sub, type, where: ok) { return f } }
    return nil
  }

  /** The face drawn: typographic family (name ID 16, else 1), OS/2 weight class, PostScript name and point size. */
  static func face(_ font: UIFont) -> [String: Any] {
    let ct = font as CTFont
    var d: [String: Any] = ["size": Double(font.pointSize), "postScript": font.fontName, "uiFamily": font.familyName]
    if let fam = nameRecord(ct, 16) ?? nameRecord(ct, 1) { d["family"] = fam }
    if let w = weightClass(ct) { d["weight"] = w }
    return d
  }

  static func table(_ font: CTFont, _ tag: Int) -> Data? {
    CTFontCopyTable(font, CTFontTableTag(tag), []) as Data?
  }

  static func u16(_ d: Data, _ at: Int) -> Int? {
    guard at + 2 <= d.count else { return nil }
    return Int(d[d.startIndex + at]) << 8 | Int(d[d.startIndex + at + 1])
  }

  static func weightClass(_ font: CTFont) -> Int? {
    guard let os2 = table(font, kCTFontTableOS2) else { return nil }
    return u16(os2, 4)
  }

  /** A Windows Unicode (platform 3) record of the 'name' table, decoded as UTF-16 big-endian. */
  static func nameRecord(_ font: CTFont, _ nameID: Int) -> String? {
    guard let n = table(font, kCTFontTableName), let count = u16(n, 2), let base = u16(n, 4) else { return nil }
    for i in 0..<count {
      let r = 6 + i * 12
      guard let platform = u16(n, r), let id = u16(n, r + 6), let len = u16(n, r + 8), let off = u16(n, r + 10) else { return nil }
      guard platform == 3, id == nameID else { continue }
      let start = n.startIndex + base + off
      guard start + len <= n.endIndex else { return nil }
      return String(data: n.subdata(in: start..<(start + len)), encoding: .utf16BigEndian)
    }
    return nil
  }
}
#else
import ExpoModulesCore

public class BwLookModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BwLook")
  }
}
#endif
