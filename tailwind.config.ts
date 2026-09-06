import type { Config } from "tailwindcss";

// Palette taken from the reference dashboard image: a dark desaturated-teal
// ground, a vivid cyan/aqua primary accent, and a warm gold secondary accent.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#22E0C7", // vivid cyan accent (charts in the reference image)
          dark: "#12B9A3",
          light: "#5CEAD6",
          fg: "#052421", // near-black teal, for text on brand-colored surfaces
        },
        gold: {
          DEFAULT: "#C9A24E", // warm brass accent (the pen in the reference image)
          dark: "#A8863B",
        },
        ink: "#0E1A18", // page background (darkest)
        panel: "#152522", // cards / surfaces
        panel2: "#1C312D", // elevated / inputs / hover
        line: "#26433D", // borders
        muted: "#8AA79F", // secondary text
        content: "#E7F1EE", // primary text

        field: {
          ink: "#0B1614",        // darkest ground, dark headers, primary text
          inkRaised: "#12211E",  // dark inputs and cards
          inkLine: "#26433D",    // borders on dark
          camera: "#0E1A18",     // burst strip, camera base
          teal: "#0C8577",       // primary buttons, bars, links, active tab
          tealHover: "#0A6E63",
          accent: "#22E0C7",     // on-dark primary, viewfinder, countdown
          accentHover: "#3BEBD4",
          accentText: "#052421",
          paper: "#FFFFFF",
          ground: "#EEF3F1",     // app background, inset fills
          groundAlt: "#F7FAF9",  // nested rows
          rule: "#E3EBE8",       // inner rules
          line: "#CBDAD5",       // card borders, dividers
          muted: "#46605A",      // secondary text on light
          mutedDark: "#8AA79F",  // secondary text on dark
          mutedDarkAlt: "#C6D8D3", // captions on dark
          successFill: "#E4F6F2",
          successLine: "#A9DED5",
          successText: "#0A5F55",
          warnFill: "#FFF6DE",
          warnLine: "#E8D49A",
          warnText: "#6B531B",
          warnDot: "#C9A24E",
          dangerFill: "#FBECEC",
          dangerLine: "#D99C9C",
          toggleOff: "#D2DFDB",
          dashed: "#9EB6AF",
        },
      },
      fontSize: {
        // 17px is the FLOOR for body copy. The existing 13px base and 10px
        // "smallest brand size" are explicitly rejected by this design: it is
        // used one-handed, with gloves, in a vehicle, in sunlight.
        "f-11": ["11px", { lineHeight: "1.3" }],
        "f-12": ["12px", { lineHeight: "1.3" }],
        "f-13": ["13px", { lineHeight: "1.35" }],
        "f-14": ["14px", { lineHeight: "1.4" }],
        "f-15": ["15px", { lineHeight: "1.45" }],
        "f-16": ["16px", { lineHeight: "1.45" }],
        "f-17": ["17px", { lineHeight: "1.5" }],
        "f-18": ["18px", { lineHeight: "1.4" }],
        "f-19": ["19px", { lineHeight: "1.35" }],
        "f-20": ["20px", { lineHeight: "1.3" }],
        "f-21": ["21px", { lineHeight: "1.3" }],
        "f-22": ["22px", { lineHeight: "1.25" }],
        "f-23": ["23px", { lineHeight: "1.25" }],
        "f-24": ["24px", { lineHeight: "1.2" }],
        "f-25": ["25px", { lineHeight: "1.2", letterSpacing: "-0.01em" }],
        "f-27": ["27px", { lineHeight: "1.15", letterSpacing: "-0.02em" }],
        "f-36": ["36px", { lineHeight: "1.1", letterSpacing: "-0.02em" }],
        "f-38": ["38px", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
        "f-42": ["42px", { lineHeight: "1.05", letterSpacing: "-0.02em" }],
      },
      boxShadow: {
        "f-primary": "0 6px 18px rgba(12,133,119,.28)",
        "f-shutter": "0 0 0 6px rgba(12,133,119,.16)",
        "f-livedot": "0 0 0 5px rgba(34,224,199,.2)",
        // Dims everything outside the viewfinder.
        "f-scrim": "0 0 0 9999px rgba(11,22,20,.45)",
        "f-scrim-soft": "0 0 0 9999px rgba(11,22,20,.4)",
      },
      keyframes: {
        "f-sweep": {
          "0%": { transform: "translateY(0)" },
          "100%": { transform: "translateY(268px)" },
        },
        "f-ring": {
          "0%": { transform: "scale(.86)", opacity: ".4" },
          "100%": { transform: "scale(1.12)", opacity: "0" },
        },
      },
      animation: {
        // The only two animations in the design, both decorative.
        "f-sweep": "f-sweep 1.6s ease-in-out infinite alternate",
        "f-ring": "f-ring .55s ease-out infinite",
      },
      // ---------------------------------------------------------------
      // Field app palette (AmReceipts Field redesign)
      // ---------------------------------------------------------------
      //
      // Added ALONGSIDE the tokens above rather than replacing them. The
      // redesign covers the eleven phone screens a technician uses; admin,
      // integrations and the posting audit stay on the desktop site and keep
      // the existing dark chrome. Replacing the shared tokens would restyle
      // those screens by accident.
      //
      // The two palettes are near-neighbours but not identical - `ink` here is
      // #0B1614 against the existing #0E1A18 - so they are kept apart under
      // `field` instead of being quietly reconciled.
      fontFamily: {
        // Samaritech's brand font stack (Arial / Helvetica).
        sans: ["Arial", "Helvetica", "sans-serif"],
        // Barlow, for the field app. Loaded via next/font in the field layout.
        field: ["var(--font-barlow)", "Arial", "Helvetica", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
