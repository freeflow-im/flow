import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Static export: the site has no server features, and Cloudflare Pages
  // serves the resulting `out/` directory.
  output: "export",
  images: {
    unoptimized: true,
  },
  // Pin the workspace root to this folder so Next/Turbopack never walks up
  // into Downloads and tries to compile stray files (e.g. a leftover
  // middleware.ts from another project).
  turbopack: {
    root: __dirname,
  },
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
