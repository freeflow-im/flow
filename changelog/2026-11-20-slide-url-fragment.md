# Slides: the address names the slide shown (#slide=N)

- `[web]` `[desktop]` The presentation editor, the slideshow and public links keep `#slide=N` in the address (replaceState, so Back isn't flooded) and open or go to the slide it names; past the end opens the last slide, and a malformed value is replaced.
- `[web]` Signing in from a Docs link keeps the fragment, so you land on the slide the link named.

## Feature

- **Links to a slide.** A presentation's address now names the slide you're on, so copying it and sending it on opens that exact slide. This works in the editor, while presenting, and on public links.
