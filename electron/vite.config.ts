import { defineConfig } from "vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  base: "./",
  publicDir: false,
  plugins: [tsconfigPaths(), tailwindcss(), viteReact()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "../src"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../electron-dist"),
    emptyOutDir: true,
    sourcemap: false,
    target: "chrome120",
    rollupOptions: {
      input: path.resolve(__dirname, "index.html"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
  },
});
