import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0b0b0c",
        panel: "#141416",
        edge: "#222226",
        muted: "#8a8a92",
        accent: "#7c5cff",
      },
      keyframes: {
        rainbow: {
          "0%": { backgroundPosition: "0% center" },
          "100%": { backgroundPosition: "200% center" },
        },
      },
      animation: {
        rainbow: "rainbow 3s linear infinite",
      },
    },
  },
  plugins: [],
};

export default config;
