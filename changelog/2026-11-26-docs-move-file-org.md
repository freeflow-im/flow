# Docs: moving a file works in every organization, not only the first

- `[server]` The suite routes a Docs request by the `workspace` its JSON body names on every route, not only on creates: Move to… went to the caller's first organization and said "File not found".

## Feature

- **Move to… works in all your organizations.** Moving a file into another folder no longer fails with "File not found" when you're working in an organization other than your first.
