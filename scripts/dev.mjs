import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "vite";
await import("./prepare-assets.mjs");
await import("./build-electron.mjs");
const server = await createServer({ server: { port: 0, host: "127.0.0.1" } });
await server.listen();
const address = server.httpServer.address();
const child = spawn(createRequire(import.meta.url)("electron"), ["."], {
  stdio: "inherit",
  env: { ...process.env, RUSTYPDF_DEV_URL: `http://127.0.0.1:${address.port}` },
});
child.on("exit", async (code) => {
  await server.close();
  process.exitCode = code ?? 0;
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
