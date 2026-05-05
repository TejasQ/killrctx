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
    },
  },
  plugins: [],
};

export default config;
