# Meet: older profile pictures show on meeting tiles

- `[server]` The public picture link served only files stored with an image type; pictures from before the move to R2 are
  stored as `application/octet-stream`, so their tiles showed initials. Their type now comes from their first bytes.
