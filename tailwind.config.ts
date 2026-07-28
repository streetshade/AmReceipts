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
      },
      fontFamily: {
        // Samaritech's brand font stack (Arial / Helvetica).
        sans: ["Arial", "Helvetica", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
