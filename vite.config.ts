import fs from "fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path, { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8")
) as { version?: string };
const appVersion = packageJson.version?.trim() || "0.0.0";

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client", "src"),
      "@shared": path.resolve(__dirname, "shared"),
      "@assets": path.resolve(__dirname, "attached_assets"),
    },
  },
  root: path.resolve(__dirname, "client"),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          const normalizedId = id.replace(/\\/g, "/");

          if (normalizedId.includes("@tanstack/react-query")) {
            return "vendor-query";
          }

          if (
            normalizedId.includes("@radix-ui") ||
            normalizedId.includes("/cmdk/") ||
            normalizedId.includes("/vaul/") ||
            normalizedId.includes("/embla-carousel-react/") ||
            normalizedId.includes("/input-otp/")
          ) {
            return "vendor-ui";
          }

          if (
            normalizedId.includes("/react-hook-form/") ||
            normalizedId.includes("@hookform/resolvers") ||
            normalizedId.includes("/zod/") ||
            normalizedId.includes("/zod-validation-error/")
          ) {
            return "vendor-forms";
          }

          if (
            normalizedId.includes("/lucide-react/") ||
            normalizedId.includes("/react-icons/")
          ) {
            return "vendor-icons";
          }

          if (
            normalizedId.includes("/recharts/") ||
            normalizedId.includes("/victory-vendor/") ||
            normalizedId.includes("/d3-") ||
            normalizedId.includes("/d3/")
          ) {
            return "vendor-charts";
          }

          if (normalizedId.includes("/framer-motion/")) {
            return "vendor-motion";
          }

          if (
            normalizedId.includes("@line/liff") ||
            normalizedId.includes("/qrcode/")
          ) {
            return "vendor-line";
          }

          if (normalizedId.includes("/date-fns/")) {
            return "vendor-date";
          }

          return undefined;
        },
      },
    },
  },
});
