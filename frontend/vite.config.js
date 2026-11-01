import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // Tailwind scans the JSX for class names at build time; there is no
  // tailwind.config.js in v4, the configuration lives in src/index.css.
  plugins: [react(), tailwindcss()],
  build: {
    // Two pages: the app, and the administration panel.
    //
    // `rolldownOptions`, not `rollupOptions`: Vite 8 here is rolldown-based
    // and marks the rollup name @deprecated in its own type definitions.
    //
    // The admin entry lives in a DIRECTORY, which is what makes it reachable
    // at /admin/ with no server change at all: the existing mount is
    // StaticFiles(..., html=True), and that serves <dir>/index.html for a
    // directory URL. No new route, nothing to register above the mount.
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html'),
      },
    },
  },
})
