import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      events: "events"
    }
  },
  optimizeDeps: {
    include: ["events"]
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) {
            return "vendor-three";
          }
          if (id.includes("node_modules/socket.io-client")) {
            return "vendor-socket";
          }
          if (id.includes("node_modules/voxel")) {
            return "vendor-voxel";
          }
          if (id.includes("node_modules/simplex-noise")) {
            return "vendor-noise";
          }
          if (id.includes("node_modules")) {
            return "vendor-misc";
          }
          return null;
        }
      }
    }
  }
});
