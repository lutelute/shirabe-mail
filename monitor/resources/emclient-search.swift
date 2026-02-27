// emclient-search — All-in-one eM Client mail search
// Activates eM Client, opens search dialog, fills subject (+ optional sender), executes search
// Usage: emclient-search "subject" [--from "email@example.com"]

import Cocoa
import ApplicationServices

// MARK: - Arguments
var searchText = ""
var fromAddr = ""
var argIter = CommandLine.arguments.dropFirst().makeIterator()
while let arg = argIter.next() {
    if arg == "--from", let v = argIter.next() { fromAddr = v }
    else if searchText.isEmpty { searchText = arg }
}
guard !searchText.isEmpty else { fputs("Usage: emclient-search \"subject\" [--from email]\n", stderr); exit(1) }

// MARK: - Subject cleaning for reliable search
func cleanSubject(_ s: String) -> String {
    var r = s
    for p in ["Re: ", "RE: ", "Fwd: ", "FW: ", "Fw: ", "Re:", "RE:", "Fwd:", "FW:", "Fw:",
              "返信: ", "転送: "] {
        while r.hasPrefix(p) { r = String(r.dropFirst(p.count)).trimmingCharacters(in: .whitespaces) }
    }
    // Strip bracket prefixes like [ML-name]
    if r.hasPrefix("["), let idx = r.firstIndex(of: "]") {
        r = String(r[r.index(after: idx)...]).trimmingCharacters(in: .whitespaces)
    }
    // Truncate very long subjects
    if r.count > 60 { r = String(r.prefix(60)) }
    return r
}
let query = cleanSubject(searchText)

// MARK: - AX helpers
func attr(_ el: AXUIElement, _ a: String) -> AnyObject? {
    var r: AnyObject?; AXUIElementCopyAttributeValue(el, a as CFString, &r); return r
}
func children(_ el: AXUIElement) -> [AXUIElement] { attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func title(_ el: AXUIElement) -> String { attr(el, kAXTitleAttribute) as? String ?? "" }
func role(_ el: AXUIElement) -> String { attr(el, kAXRoleAttribute) as? String ?? "" }
func press(_ el: AXUIElement) { AXUIElementPerformAction(el, kAXPressAction as CFString) }

func find(_ parent: AXUIElement, role r: String? = nil, title t: String? = nil, depth: Int = 4) -> AXUIElement? {
    for c in children(parent) {
        if (r == nil || role(c) == r) && (t == nil || title(c) == t) { return c }
        if depth > 1, let f = find(c, role: r, title: t, depth: depth - 1) { return f }
    }
    return nil
}

func poll(_ seconds: Double, check: () -> Bool) -> Bool {
    let limit = Int(seconds * 10)
    for _ in 0..<limit { if check() { return true }; usleep(100_000) }
    return false
}

// MARK: - CGEvent helpers
func click(at p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
    usleep(20_000)
    CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}
func cmdKey(_ vk: UInt16) {
    if let e = CGEvent(keyboardEventSource: nil, virtualKey: vk, keyDown: true) { e.flags = .maskCommand; e.post(tap: .cghidEventTap) }
    usleep(20_000)
    CGEvent(keyboardEventSource: nil, virtualKey: vk, keyDown: false)?.post(tap: .cghidEventTap)
}
func escKey() {
    CGEvent(keyboardEventSource: nil, virtualKey: 0x35, keyDown: true)?.post(tap: .cghidEventTap)
    usleep(20_000)
    CGEvent(keyboardEventSource: nil, virtualKey: 0x35, keyDown: false)?.post(tap: .cghidEventTap)
}

func pasteIntoField(_ field: AXUIElement, text: String) -> Bool {
    // Get field center position
    guard let posRef = attr(field, kAXPositionAttribute), let szRef = attr(field, kAXSizeAttribute) else { return false }
    var pt = CGPoint.zero; var sz = CGSize.zero
    AXValueGetValue(posRef as! AXValue, .cgPoint, &pt)
    AXValueGetValue(szRef as! AXValue, .cgSize, &sz)

    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)

    click(at: CGPoint(x: pt.x + sz.width / 2, y: pt.y + sz.height / 2))
    usleep(80_000)
    cmdKey(0x00) // Cmd+A  (select all)
    usleep(30_000)
    cmdKey(0x09) // Cmd+V  (paste)
    usleep(150_000)
    return true
}

// MARK: - Main flow

// 1. Find or launch eM Client
var emApp = NSWorkspace.shared.runningApplications.first { $0.localizedName == "eM Client" }
if emApp == nil {
    NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/eM Client.app"))
    _ = poll(5) { emApp = NSWorkspace.shared.runningApplications.first { $0.localizedName == "eM Client" }; return emApp != nil }
}
guard let em = emApp else { fputs("eM Client not found\n", stderr); exit(1) }

// 2. Activate and wait
em.activate()
_ = poll(2) { em.isActive }

let ax = AXUIElementCreateApplication(em.processIdentifier)

// 3. Raise main window (restores full menu bar)
func raiseMain() {
    guard let wins = attr(ax, kAXWindowsAttribute) as? [AXUIElement] else { return }
    for w in wins {
        let t = title(w)
        if t.contains("eM Client") || t.contains("受信トレイ") || t.contains("Inbox") {
            AXUIElementPerformAction(w, "AXRaise" as CFString)
            return
        }
    }
    // Fallback: raise largest window
    if let w = wins.first { AXUIElementPerformAction(w, "AXRaise" as CFString) }
}
raiseMain()
usleep(200_000)

// 4. Close existing search dialog if present
if let wins = attr(ax, kAXWindowsAttribute) as? [AXUIElement] {
    for w in wins where title(w) == "LayeredBaseForm" {
        escKey()
        usleep(200_000)
        break
    }
}

// 5. Open search via AX menu action
func openSearch() -> Bool {
    guard let mbRef = attr(ax, kAXMenuBarAttribute) else { return false }
    let mb = (mbRef as! AXUIElement)
    for bi in children(mb) where title(bi) == "編集(E)" {
        press(bi)
        usleep(150_000)
        for m in children(bi) {
            if let item = find(m, role: "AXMenuItem", title: "検索(F)") {
                press(item); return true
            }
        }
        escKey() // close menu if item not found
    }
    return false
}

if !openSearch() {
    raiseMain(); usleep(400_000)
    if !openSearch() { fputs("Cannot open search menu\n", stderr); exit(1) }
}

// 6. Wait for search dialog (polling — no fixed delays)
var searchWin: AXUIElement?
let dialogOK = poll(3) {
    guard let wins = attr(ax, kAXWindowsAttribute) as? [AXUIElement] else { return false }
    searchWin = wins.first { title($0) == "LayeredBaseForm" }
    return searchWin != nil
}
guard dialogOK, let sWin = searchWin else { fputs("Search dialog did not appear\n", stderr); exit(1) }
usleep(150_000)

// 7. Find subject field and search button
guard let subjectField = find(sWin, role: "AXTextArea", title: "件名:") else {
    fputs("Subject field not found\n", stderr); exit(1)
}
guard let searchBtn = find(sWin, role: "AXButton", title: "検索(S)") else {
    fputs("Search button not found\n", stderr); exit(1)
}

// 8. Paste subject into field
guard pasteIntoField(subjectField, text: query) else {
    fputs("Failed to paste into subject field\n", stderr); exit(1)
}

// 9. If fromAddress provided, fill sender field too
if !fromAddr.isEmpty {
    // Try common field titles for sender
    let senderField = find(sWin, role: "AXTextArea", title: "差出人:")
        ?? find(sWin, role: "AXTextArea", title: "From:")
    if let sf = senderField {
        _ = pasteIntoField(sf, text: fromAddr)
    }
}

// 10. Click search button
usleep(100_000)
press(searchBtn)

// Restore clipboard to subject (for user's convenience)
usleep(50_000)
NSPasteboard.general.clearContents()
NSPasteboard.general.setString(searchText, forType: .string)

print("OK")
