// Swift helper for searching in eM Client
// Finds the search window's "件名:" field, pastes text, clicks "検索" button
// Usage: emclient-search "search query"

import Cocoa
import ApplicationServices

let running = NSWorkspace.shared.runningApplications
guard let emClient = running.first(where: { $0.localizedName == "eM Client" }) else {
    fputs("ERROR: eM Client not running\n", stderr); exit(1)
}

let searchText = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if searchText.isEmpty { fputs("ERROR: No search text\n", stderr); exit(1) }

// Set clipboard
let pb = NSPasteboard.general
pb.clearContents()
pb.setString(searchText, forType: .string)

let appElement = AXUIElementCreateApplication(emClient.processIdentifier)
var windowsRef: AnyObject?
AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef)
guard let windows = windowsRef as? [AXUIElement] else { fputs("ERROR: No windows\n", stderr); exit(1) }

// Find the LayeredBaseForm (search dialog)
var searchWin: AXUIElement? = nil
for win in windows {
    var titleRef: AnyObject?
    AXUIElementCopyAttributeValue(win, kAXTitleAttribute as CFString, &titleRef)
    if (titleRef as? String) == "LayeredBaseForm" { searchWin = win; break }
}
guard let sWin = searchWin else { fputs("ERROR: Search window not found\n", stderr); exit(1) }

var childrenRef: AnyObject?
AXUIElementCopyAttributeValue(sWin, kAXChildrenAttribute as CFString, &childrenRef)
guard let children = childrenRef as? [AXUIElement] else { fputs("ERROR: No children\n", stderr); exit(1) }

// Find "件名:" text area and "検索(S)" button
var subjectField: AXUIElement? = nil
var searchButton: AXUIElement? = nil

for child in children {
    var roleRef: AnyObject?
    AXUIElementCopyAttributeValue(child, kAXRoleAttribute as CFString, &roleRef)
    var titleRef2: AnyObject?
    AXUIElementCopyAttributeValue(child, kAXTitleAttribute as CFString, &titleRef2)
    let role = roleRef as? String ?? ""
    let title = titleRef2 as? String ?? ""
    if role == "AXTextArea" && title == "件名:" { subjectField = child }
    if role == "AXButton" && title == "検索(S)" { searchButton = child }
}

guard let field = subjectField else { fputs("ERROR: Subject field not found\n", stderr); exit(1) }
guard let btn = searchButton else { fputs("ERROR: Search button not found\n", stderr); exit(1) }

// Get position of the subject field for clicking
var posRef: AnyObject?
var sizeRef: AnyObject?
AXUIElementCopyAttributeValue(field, kAXPositionAttribute as CFString, &posRef)
AXUIElementCopyAttributeValue(field, kAXSizeAttribute as CFString, &sizeRef)

var point = CGPoint.zero
var size = CGSize.zero
AXValueGetValue(posRef as! AXValue, .cgPoint, &point)
AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)

let clickX = point.x + size.width / 2
let clickY = point.y + size.height / 2

// Ensure eM Client is frontmost
emClient.activate()
usleep(200000)

// Click on the subject field
let pos = CGPoint(x: clickX, y: clickY)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pos, mouseButton: .left)?.post(tap: .cghidEventTap)
CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: pos, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(200000)

// Cmd+A (select all existing text)
if let e = CGEvent(keyboardEventSource: nil, virtualKey: 0x00, keyDown: true) {
    e.flags = .maskCommand; e.post(tap: .cghidEventTap)
}
CGEvent(keyboardEventSource: nil, virtualKey: 0x00, keyDown: false)?.post(tap: .cghidEventTap)
usleep(50000)

// Cmd+V (paste from clipboard)
if let e = CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: true) {
    e.flags = .maskCommand; e.post(tap: .cghidEventTap)
}
CGEvent(keyboardEventSource: nil, virtualKey: 0x09, keyDown: false)?.post(tap: .cghidEventTap)
usleep(300000)

// Click "検索(S)" button to execute search
AXUIElementPerformAction(btn, kAXPressAction as CFString)
print("OK")
