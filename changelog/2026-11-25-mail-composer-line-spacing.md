# Mail composer: one line per Enter, as Gmail

- `[web]` `[desktop]` Composer paragraphs and lists lose their 0.5em margin, so a blank line between paragraphs is one line tall, not two.
- `[web]` `[desktop]` Sent HTML gets `margin:0` paragraphs (an empty one keeps its line with `&nbsp;`), and the plain-text part puts one newline between paragraphs, so recipients see the spacing that was typed.

## Feature

- **Tighter spacing in Mail's composer.** Paragraphs sit as close as in Gmail: one Enter starts a new line and a blank line is one line tall, in the composer and in the message the recipient gets.
