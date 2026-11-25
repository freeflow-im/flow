# Docs: Download as PDF works again

- `[server]` Every hosted PDF failed with "ReferenceError: c is not defined": Playwright's `waitForFunction` sends its own
  code to the page, and the Worker's minified build renamed a helper in it. The print page is now polled with a string.

## Feature

- **Download as PDF works again.** Documents, presentations and Markdown files download as PDFs again, and the
  assistant can save PDFs of them.
