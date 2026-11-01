import Foundation
import SwiftUI

/// Rendering of stored mention tokens: `<@userId>` (user mentions) and
/// `<!channel|here|everyone>` (group mentions). Bodies keep tokens on the wire
/// so renames stay correct (phase2.md §4); clients translate at display time.
enum MentionRendering {
    /// User ids are Flow UUIDs.
    static var userToken: Regex<(Substring, Substring)> { /<@([0-9a-fA-F-]{36})>/ }
    static var groupToken: Regex<(Substring, Substring)> { /<!(channel|here|everyone)>/ }

    /// Token-free plain text (banners, notification previews).
    static func plainText(_ body: String, names: [String: String] = [:]) -> String {
        var out = body
        for match in body.matches(of: userToken).reversed() {
            let id = String(match.1)
            out = out.replacingOccurrences(
                of: String(match.0),
                with: "@\(names[id] ?? "someone")"
            )
        }
        out = out.replacing(groupToken) { "@\($0.1)" }
        return out
    }

    private static var anyToken: Regex<Substring> { /<[@!][^<>\s]{1,40}>/ }

    /// Markdown-rendered body with mention pills. Highlights mentions of the
    /// current user (and group mentions) more strongly. Built by splitting the
    /// body into plain segments (markdown-rendered) and token segments
    /// (styled pills) — index-safe by construction. Markdown spans crossing a
    /// mention boundary are intentionally not supported.
    /// `scale` is the caller's text zoom (#105): pills carry their own font, so
    /// they have to be told, or they stay put while the prose around them grows.
    /// `codeChips` styles `` `code` `` spans as web does (#387); it is opt-in
    /// because this file is compiled into the iOS app too, and iOS has not
    /// adopted the treatment yet.
    static func attributed(
        _ body: String,
        names: [String: String],
        currentUserId: String?,
        scale: CGFloat = 1,
        codeChips: Bool = false
    ) -> AttributedString {
        var result = AttributedString()
        var rest = Substring(body)
        let render = { (text: String) in markdown(text, codeChips: codeChips, scale: scale) }
        while let match = rest.firstMatch(of: anyToken) {
            let token = String(rest[match.range])
            if let pillFor = pill(
                token: token, names: names, currentUserId: currentUserId, scale: scale
            ) {
                if match.range.lowerBound > rest.startIndex {
                    result += render(String(rest[rest.startIndex..<match.range.lowerBound]))
                }
                result += pillFor
            } else {
                // not a real mention token: emit up to and including it verbatim
                result += render(String(rest[rest.startIndex..<match.range.upperBound]))
            }
            rest = rest[match.range.upperBound...]
        }
        if !rest.isEmpty { result += render(String(rest)) }
        return result
    }

    private static func pill(
        token: String, names: [String: String], currentUserId: String?, scale: CGFloat
    ) -> AttributedString? {
        var text: String
        var strong: Bool
        if let m = token.wholeMatch(of: userToken) {
            let id = String(m.1)
            text = "@\(names[id] ?? "someone")"
            strong = id == currentUserId
        } else if let m = token.wholeMatch(of: groupToken) {
            text = "@\(m.1)"
            strong = true
        } else {
            return nil
        }
        var pill = AttributedString(text)
        // A mention marks a name inside a sentence; it is not the sentence
        // (#531). A filled accent block with bold white text read louder than
        // the message carrying it, so both weights come down: a tint you
        // notice rather than a badge that shouts. `strong` (you, or a group
        // mention) keeps a visible step up — twice the tint and one weight
        // more — which is enough to find while scanning, without the block.
        // `MC.accent`, not `.accentColor`: the environment tint only resolves
        // to the brand purple for some attribute combinations — drop the
        // filled-block styling and the same `.accentColor` run comes back as
        // system blue. The palette token is the colour we actually mean.
        pill.foregroundColor = MC.accent
        pill.backgroundColor = MC.accent.opacity(strong ? 0.20 : 0.10)
        pill.font = ZoomedFont.system(.callout, weight: strong ? .medium : .regular, scale: scale)
        return pill
    }

    private static func markdown(
        _ text: String, codeChips: Bool = false, scale: CGFloat = 1
    ) -> AttributedString {
        var parsed = (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        )) ?? AttributedString(text)
        if codeChips { styleCodeSpans(&parsed, scale: scale) }
        return parsed
    }

    /// Web draws an inline code span as a chip — monospace at `0.92em` on the
    /// warm code background in a rust foreground (`format.tsx` renderInline).
    /// The markdown parser only tags the run with the `.code` presentation
    /// intent, which `Text` renders as bare monospace, so the chip is applied
    /// here. Ranges are collected first: mutating an `AttributedString` while
    /// iterating its runs invalidates the iteration.
    private static func styleCodeSpans(_ string: inout AttributedString, scale: CGFloat) {
        let ranges = string.runs
            .filter { $0.inlinePresentationIntent?.contains(.code) == true }
            .map(\.range)
        for range in ranges {
            string[range].font = ZoomedFont.system(size: 12, design: .monospaced, scale: scale)
            string[range].foregroundColor = MC.codeInk
            string[range].backgroundColor = MC.codeBg
        }
    }
}
