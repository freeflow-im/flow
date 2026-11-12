# Home: each app's menu in Home's sidebar

- [web] Inside Home, Mail, Docs, Calendar and Admin hide their own sidebar and send Home their main menu instead; Home shows it under the app's row (one sidebar, not two).
- [web] `@flow/suite-bar` `useHomeMenu`: the `flow:menu` / `flow:select` messages any app can use (docs/specs/home.md §2.1).

## Feature

In Home, opening Mail, Docs, Calendar or Admin shows its folders, lists or sections right under it in Home's sidebar, instead of a second sidebar beside it.
