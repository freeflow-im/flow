# The PDF OCR container (server.mjs). `wrangler deploy` builds it from packages/edge (wrangler.toml [[containers]]) with
# `docker build --platform linux/amd64`, the only platform Cloudflare runs. The install runs on the builder's own platform
# and asks npm for the x64 Linux binaries, so the amd64 stage has no RUN step and an Arm machine (the deploy runner, a
# Mac) builds it without emulating x86. Try it locally:
#   docker build --platform linux/amd64 -t flow-pdf-ocr packages/edge/containers/pdf-ocr
#   docker run --rm -p 8080:8080 flow-pdf-ocr
#   curl --data-binary @packages/edge/test/fixtures/scan.pdf -H 'content-type: application/pdf' localhost:8080/ocr
FROM --platform=$BUILDPLATFORM node:24.22.1-bookworm-slim AS install
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --os=linux --cpu=x64 --libc=glibc --no-audit --no-fund
# Tesseract is inside LiteParse's native module; its English model (the one LiteParse would otherwise download, from
# tessdata_best) is part of the image, so the container needs no internet.
ADD --checksum=sha256:8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba https://github.com/tesseract-ocr/tessdata_best/raw/4.1.0/eng.traineddata /tessdata/eng.traineddata
RUN chmod -R a+rX /tessdata

FROM node:24.22.1-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 TESSDATA_PREFIX=/app/tessdata
COPY --from=install /tessdata /app/tessdata
COPY --from=install /app/node_modules node_modules
COPY package.json server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
