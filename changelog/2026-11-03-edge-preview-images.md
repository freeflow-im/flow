# Preview images and thumbnails resized on the Cloudflare Worker

- `[server]` Link-preview images are resized again on the Worker, with the Cloudflare Images binding (`IMAGES`): WebP at 1200×630 inside plus a 128×128 thumbnail, as sharp made on Node; re-encoding drops their metadata.
- `[server]` Attached pictures get their size and a 512 px WebP thumbnail the same way (workspace and profile avatars too, where sharp was used). Without the binding, or when it fails, images are kept as fetched, as before.
