/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'optical': {
          green: '#10b981',
          panel: '#181825',
          darker: '#0a0a0f',
          border: '#27273a',
        }
      }
    },
  },
  plugins: [],
}
