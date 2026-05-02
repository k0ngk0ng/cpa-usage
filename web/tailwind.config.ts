import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#0b0d11",
        panel: "#13161c",
        panel2: "#181c25",
        border: "#262b36",
        ink: "#e7eaf0",
        muted: "#8a93a3",
        accent: "#6aa6ff",
        success: "#4ade80",
        danger: "#f87171",
        warn: "#facc15",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
        mono: ["JetBrains Mono", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
