# Submitting Universal Docs to ChatGPT

What a submission needs, what is ready, and what is still to do. The requirements are OpenAI's
([submission](https://developers.openai.com/plugins/deploy/submission),
[review](https://developers.openai.com/plugins/deploy/app-review)); check them again before submitting, since
they change.

## The package

`npm run plugin:package` writes `release/universal-docs-plugin.zip`: `plugin.json` (the listing), `mcp.json`
(the server at `https://docs.freeflow.im/mcp`, signed in to with OAuth by dynamic client registration),
`skills/universal-docs/SKILL.md` (the one skill, also the onboarding skill) and `assets/logo.svg`.
`plugin/server/package.test.ts` checks it against the portal's limits.

Skills go in the ZIP. They are not served by the MCP server: a change to the skill or the listing is a new
ZIP and a new review. Tool changes are different: OpenAI scans the live server daily (or on **Rescan**), new
tools wait for approval, and the server must keep working with the approved tool schemas until then.

## Ready

- [x] Listing text within the limits (name, descriptions, capabilities, three starter prompts, brand colour)
- [x] Logo (square SVG)
- [x] One skill, with front matter that parses as YAML
- [x] Remote MCP server on a public HTTPS domain, with OAuth (metadata document or dynamic registration)
- [x] Domain verification route: set `OPENAI_APPS_CHALLENGE` on the hosted app to the token the portal gives, and
      `https://docs.freeflow.im/.well-known/openai-apps-challenge` answers with it as plain text
- [x] Every tool has `readOnlyHint`, `destructiveHint` and `openWorldHint`; the tools that fetch from the web
      (`import_file`, `insert_image`, `set_cell_image`) say so
- [x] The app declares its content security policy (our origin and Google Fonts)
- [x] The model's tools return no revisions, dates or account ids (the app's own tools keep them)
- [x] The sign-in and consent pages list everything that is shared and link the privacy policy and terms
- [x] Privacy policy, terms of service and support pages, public and readable without scripts

## To do before submitting

Only the account owner can do these.

- [ ] **Identity verification** of the publisher ("Freeflow", individual or business) in the OpenAI Platform
      organization settings, in a project without EU data residency
- [ ] **Read the privacy policy, terms of service and support page** (`server/legal.ts`, served at `/privacy`,
      `/terms` and `/support`; their addresses are in `plugin.json`). They were drafted from what the app does
      and have not been read by a lawyer. The terms name no governing law. They must be deployed before the
      portal can reach them.
- [ ] **The publisher's name**: the listing says Supercog.ai, which must be the name the identity
      verification is in
- [ ] **Reviewer account**: a password account made for review, with sample files (below), that signs in with
      no email code, MFA or Google step. Entered in the portal's Review details, never in the ZIP.
- [ ] **Demo recording** at an address reviewers can open
- [ ] **Run every test case below** in ChatGPT with the reviewer account and the production server
- [ ] **Try the app with its content security policy enforced** (developer mode runs with it off; see
      `TODO.md` section 6)
- [ ] Release notes for the version

Worth deciding first, though nothing in the portal checks them: sign-up inside the OAuth window for someone
with no account (`TODO.md` section 2), and the open file being per account rather than per chat (section 3).

## Sample files for the reviewer account

- "Q3 plan": a document with a heading, three paragraphs and a list
- "Team update": a presentation of four slides
- "Budget": a spreadsheet with a header row, ten rows of numbers and a total
- "team-photo.jpg": a picture
- "README.md": a Markdown document

## Positive test cases

| # | Scenario | Prompt | Tools expected | Expected result |
|---|---|---|---|---|
| 1 | Create a document | "Create a one-page project brief for a website redesign in Universal Docs." | `create_doc` | A new document opens in the app with a title, headings and paragraphs; the reply says it was made. |
| 2 | Edit the open document | With "Q3 plan" open: "Make the second paragraph shorter." | `read_doc`, `replace_blocks` or `replace_text` | Only the second paragraph changes, in the open document; the reply says what changed. |
| 3 | Add slides | "Open my Team update presentation and add a slide about next steps with three bullets." | `list_files`, `open_file`, `add_slides` | The presentation opens and has a fifth slide with a title and three bullets. |
| 4 | Work in a spreadsheet | "In my Budget spreadsheet, add a column that shows each row as a share of the total." | `list_files`, `open_file` or `get_sheet_overview`, `read_range`, `write_range` | A new column of formulas (not typed numbers), with a header; other cells unchanged. |
| 5 | Import and edit a picture | Attach a JPEG: "Save this to my files and crop it to a square." | `import_file`, `view_image`, `transform_image` | The picture is stored and shown; a square copy is made and shown, and the original is kept. |

## Negative test cases

| # | Prompt | Why the plugin should not act | Expected |
|---|---|---|---|
| 1 | "What's the weather in Paris tomorrow?" | Nothing to do with the user's files. | No Universal Docs tool is called. |
| 2 | "Delete all my files." | A destructive request for everything, with no file named; `delete_file` is one named file at a time and only on a clear request. | ChatGPT asks which files, or asks for confirmation; nothing is deleted without it. |
| 3 | With "team-photo.jpg" open: "Remove the background from this picture." | Background removal is not available in the plugin. | `transform_image` answers that it is only in the full app, with the link; ChatGPT passes the link on and nothing is changed. |

## After approval

- **Publish** the approved version in the portal.
- A change of the server's address (scheme, host or port) means a new plugin, so `docs.freeflow.im` stays.
- OpenAI asks to hear from press@openai.com before the plugin is announced publicly.
