# Docs respect the organization selected in the suite bar (phase 4)

- `[server]` Every Docs row carries its organization (`workspace_id`) and, for files and folders, `private`; one access check (`canAccess` in `packages/docs/server/scope.ts`) for every by-id read; existing rows stay private.
- `[server]` The host gives Docs `isMember` and `organizationsOf` over Flow's workspaces (cached a minute); listing and creating routes take `?workspace=` and `shared`; `POST /api/files/:id/scope` and `/api/folders/scope` move between roots.
- `[web]` The Docs home shows Organization files and My files for the bar's organization; Share with organization, Make private and Move to organization… in the row, folder and File menus; the assistant's tools work in the chat's root.

## Feature

- **Files for your organization.** The Docs home now has two places for the organization you pick in the bar: Organization files, which everyone in it can open and edit, and My files, which only you can see. New files are private unless you make them inside Organization files; Share with organization and Make private move a file or folder between the two.
