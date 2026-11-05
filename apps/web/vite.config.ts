import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  esbuild: {
    tsconfigRaw: {
      compilerOptions: { jsx: 'react-jsx', useDefineForClassFields: true },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/workspace': {
        target: 'http://localhost:3011',
        rewrite: (path) => path.replace(/^\/api\/workspace/, ''),
      },
      '/api': 'http://localhost:3011',
    },
  },
  build: {
    outDir: '../../dist/apps/web',
    emptyOutDir: true,
  },
});
