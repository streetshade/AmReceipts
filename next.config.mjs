/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle with only the traced dependencies, so
  // the runtime image needs no node_modules install and stays small. Harmless
  // outside Docker: `next start` ignores it.
  output: "standalone",
  // These packages are node-only (native / heavy deps) and must not be bundled
  // by Next for the server runtime — they're require()'d at runtime instead.
  //
  // pdfjs-dist belongs here for a concrete reason, found by running the built
  // image rather than by reading the code: webpack bundles pdfjs and rewrites
  // its worker reference to `.next/server/vendor-chunks/pdf.worker.mjs`, a file
  // it never emits. The failure carries the BUILD machine's absolute path, so
  // it surfaces as "Cannot find module /Users/..." inside a Linux container.
  // Left bundled it breaks every PDF upload under `next start`, not just in
  // Docker — running pdfjs through tsx (as the smoke test does) bypasses
  // webpack and hides it completely.
  experimental: {
    serverComponentsExternalPackages: ["tesseract.js", "@google-cloud/vision", "pdfkit", "pdfjs-dist"],
  },
};

export default nextConfig;
