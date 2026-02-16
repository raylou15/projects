import { defineConfig } from "vite";

const backendPort = process.env.VITE_BACKEND_PORT || "3000";

export default defineConfig({
  base: "/trivia/",
  server: {
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
