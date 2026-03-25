import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"],
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        surface: "hsl(var(--surface))",
        "surface-muted": "hsl(var(--surface-muted))",
        accent: "hsl(var(--accent))",
        "accent-hover": "hsl(var(--accent-hover))",
        "accent-muted": "hsl(var(--accent-muted))",
        border: "hsl(var(--border))",
        "border-muted": "hsl(var(--border-muted))",
        muted: "hsl(var(--muted))",
        "muted-soft": "hsl(var(--muted-soft))",
      },
      animation: {
        "fade-up": "fade-up 0.5s ease-out forwards",
      },
      keyframes: {
        "fade-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
  darkMode: "class",
};
export default config;
