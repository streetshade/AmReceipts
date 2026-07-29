/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // These packages are node-only (native / heavy deps) and must not be bundled
  // by Next for the server runtime — they're require()'d at runtime instead.
  experimental: {
    serverComponentsExternalPackages: ["tesseract.js", "@google-cloud/vision", "pdfkit"],
  },
};

export default nextConfig;
