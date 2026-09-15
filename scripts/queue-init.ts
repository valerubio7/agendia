import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
	loadRuntimeConfig,
	preflightReleaseEnvironment,
} from "@agendia/runtime-config";
import { initializeQueues } from "./support/queue-initialization.ts";

const config = loadRuntimeConfig("queue-init");
await preflightReleaseEnvironment(config);
const urlFile = process.env.QUEUE_INIT_DATABASE_URL_FILE;
if (!urlFile) throw new Error("QUEUE_INIT_DATABASE_URL_FILE is required");
const connectionString = readFileSync(urlFile, "utf8").trim();
const sql = postgres(connectionString, { max: 1 });
try {
	console.log(
		JSON.stringify(await initializeQueues({ sql, connectionString })),
	);
} finally {
	await sql.end();
}
