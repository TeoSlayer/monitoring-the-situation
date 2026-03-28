import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api/aircraft': {
        target: 'https://api.airplanes.live',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/aircraft/, ''),
      },
    },
  },
});
