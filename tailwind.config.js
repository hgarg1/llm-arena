/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./views/**/*.ejs", "./public/**/*.js", "./src/**/*.ts"],
  theme: {
    extend: {
      colors: {
        primary: "#0F172A", // Midnight Slate
        accent: "#2563EB",  // Steel Blue
        secondary: "#334155", // Graphite
        background: "#F8FAFC", // Off-White
        surface: "#FFFFFF",
        border: "#E5E7EB", // Light Slate
        success: "#16A34A",
        warning: "#D97706",
        error: "#DC2626",
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      container: {
        center: true,
        padding: '1rem',
        screens: {
          sm: '640px',
          md: '768px',
          lg: '1024px',
          xl: '1280px',
        },
      },
    },
  },
  plugins: [],
}