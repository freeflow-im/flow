# Admin: the card titles show again

- `[web]` The Admin app's stylesheet had a `--color-base` token for the Automations section moved from Chat. Tailwind made a `text-base` colour utility of it, which overrode the `text-base` font size and painted every card title white on white. The token is gone; a test keeps colour tokens from taking a font size's name.
