import { runWorker } from "../src/design/jobs.js";
await runWorker(process.argv[2], process.argv[3]);
