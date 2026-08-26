import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5175,
    proxy: {
      "/api": { target: "http://127.0.0.1:5190", changeOrigin: true },
      "/uploads": { target: "http://127.0.0.1:5190", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        catalog: path.resolve(__dirname, "catalog.html"),
        product: path.resolve(__dirname, "product.html"),
        trade: path.resolve(__dirname, "trade.html"),
        news: path.resolve(__dirname, "news.html"),
        admin: path.resolve(__dirname, "admin.html"),
        quickAdd: path.resolve(__dirname, "quick-add.html"),
      },
    },
  },
});
