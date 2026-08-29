/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle with only the traced dependencies, so
  // the runtime image needs no node_modules install and stays small. Harmless
  // outside Docker: `next start` ignores it.
  output: "standalone",
  // These packages are node-only (native / heavy deps) and must not be bundled
  // by Next for the server runtime — they're require()'d at runtime instead.
  experimental: {
    serverComponentsExternalPackages: ["tesseract.js", "@google-cloud/vision", "pdfkit"],
  },
};

export default nextConfig;
