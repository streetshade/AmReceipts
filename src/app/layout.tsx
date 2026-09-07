import type { Metadata, Viewport } from "next";
import { Barlow } from "next/font/google";
import "./globals.css";

// The field app's typeface. Exposed as a CSS variable and referenced by the
// `font-field` Tailwind family, so it applies only where the redesign asks for
// it - the desktop chrome keeps the Arial/Helvetica brand stack.
const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-barlow",
  display: "swap",
  // Falls back to the same stack the token declares, so a failed font load
  // shifts nothing about the layout it was measured against.
  fallback: ["Arial", "Helvetica", "sans-serif"],
});

export const metadata: Metadata = {
  title: "AmReceipts — Samaritech",
  description:
    "Samaritech AmReceipts — scan receipts and product barcodes to capture, aggregate and report job and travel expenditure.",
  icons: { icon: "/brand/samaritech-mark.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#0E1A18",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={barlow.variable}>
      <body>{children}</body>
    </html>
  );
}
