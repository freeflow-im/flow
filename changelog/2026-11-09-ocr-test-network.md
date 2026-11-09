# CI: the OCR test no longer downloads Tesseract's model mid-run

- `[qa]` CI fetches `eng.traineddata` once (curl with retries, `actions/cache` keyed on the liteparse version) and points liteparse at it with `TESSDATA_PREFIX`; the docs OCR test had failed in 4 of 5 runs on that download.
- `[server]` Workspace PDF to Markdown now warns "Page N is a scan and could not be read: the OCR model is unavailable" instead of a generic OCR warning when the model cannot be loaded.
