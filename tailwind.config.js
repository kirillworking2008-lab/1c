/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        onec: {
          yellow: '#FFDF6B',
          yellowDark: '#F5C400',
          yellowLight: '#FFF6D6',
          yellowHeader: '#FEE685',
          yellowTab: '#FFECB3',
          panel: '#F5F5F5',
          border: '#D4D4D4',
          borderDark: '#A6A6A6',
          blueSelect: '#DCEBFC',
          blueBorder: '#7EB4EA',
          redText: '#990000',
          commentGreen: '#008000',
          keywordRed: '#FF0000',
          stringBlack: '#000000',
          preprocBrown: '#963200',
        }
      },
      fontFamily: {
        sans: ['"Segoe UI"', 'Tahoma', 'Roboto', 'Arial', 'sans-serif'],
        mono: ['"Consolas"', '"Courier New"', 'monospace'],
      }
    },
  },
  plugins: [],
}
