import { parentPort, workerData } from "node:worker_threads";
import { PdfService } from "./pdf-service";
const service = new PdfService(workerData);
let tail = Promise.resolve();
parentPort!.on("message", ({ id, command, args }) => {
  tail = tail.then(async () => {
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
});
