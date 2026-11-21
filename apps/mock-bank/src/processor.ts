import { runWorker } from "./helper.js";
import { processTransfer } from "./services/transfer.service.js";

await runWorker("processor", processTransfer, 1000);
