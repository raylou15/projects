import { defineConfig } from "vite";

const backendPort = process.env.VITE_BACKEND_PORT || "3000";

export default defineConfig({
  envDir: "../",
  server: {
    // Override with VITE_BACKEND_PORT when your backend uses a non-default port.
    proxy: {
      "/api": {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      "/ws": {
        target: `ws://localhost:${backendPort}`,
        ws: true,
      },
    },
    hmr: {
      clientPort: 443,
    },
  },
});
