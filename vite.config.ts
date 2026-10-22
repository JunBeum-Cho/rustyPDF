import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
export default defineConfig({
  base: "./",
  plugins: [solid()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    watch: { ignored: ["**/resources/**"] },
  },
  build: { target: "es2022" },
});
