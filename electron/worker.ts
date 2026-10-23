import { parentPort, workerData } from "node:worker_threads";
import { PdfService } from "./pdf-service";
const service = new PdfService(workerData, (event: string, payload: unknown) =>
  parentPort!.postMessage({ event, payload }),
);
parentPort!.on("message", async ({ id, command, args }) => {
  try {
    const result =
      command === "__dispose"
        ? await service.dispose()
        : await service.invoke(command, args);
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
