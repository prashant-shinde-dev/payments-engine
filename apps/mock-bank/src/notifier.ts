import { runWorker } from "./helper.js";
import { callback } from "./services/transfer.service.js";

await runWorker("notifier", callback, 1000);
