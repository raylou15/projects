import { defineConfig } from "vite";

export default defineConfig({
  envDir: "../",
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        secure: false,
        ws: true,
      },
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
    hmr: {
      clientPort: 443,
    },
  },
});
