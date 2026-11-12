# An app open from before a deploy loads again instead of breaking

- [server] A build file the current deploy does not have (`/<app>/assets/…`) gets a plain 404, not the origin's HTML page, which broke the old page's imports with a "MIME type" error.
- [web] Every app reloads once when it cannot load a part of its old version (`vite:preloadError`, at most once a minute); Home keeps apps open for hours, so this happened after each deploy.
- [desktop] Same for the desktop shell's pages.

## Feature

After an update, an app you left open (in Home or a tab) now reloads itself when needed, instead of a button that does nothing.
