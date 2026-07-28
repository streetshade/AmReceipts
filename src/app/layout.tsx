import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
