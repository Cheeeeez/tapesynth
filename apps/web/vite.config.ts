import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// DeWEB serves the site from on-chain files under a path prefix we do not control: relative base,
// no external URLs in HTML/CSS, no runtime-fetched fonts.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2500 },
});
