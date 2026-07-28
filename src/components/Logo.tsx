/* eslint-disable @next/next/no-img-element */

// Samaritech branding. The source logo is black-on-transparent, so it's
// inverted to render cleanly (white) on the dark teal theme.

export function Logo({ className = "h-8", title = "Samaritech" }: { className?: string; title?: string }) {
  return (
    <img
      src="/brand/samaritech-wordmark.png"
      alt={title}
      className={`${className} w-auto select-none`}
      style={{ filter: "invert(1) brightness(1.9)" }}
      draggable={false}
    />
  );
}

export function LogoMark({ className = "h-12" }: { className?: string }) {
  return (
    <img
      src="/brand/samaritech-mark.png"
      alt="Samaritech"
      className={`${className} w-auto select-none`}
      style={{ filter: "invert(1) brightness(1.9)" }}
      draggable={false}
    />
  );
}
