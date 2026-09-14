import { readFileSync } from "node:fs";
import {
	preflightStaticEnvironment,
	runtimeProcesses,
	validateReleaseCommand,
	type IsolationManifest,
	type RuntimeProcess,
} from "@agendia/runtime-config";

const command = process.argv[2];
if (!runtimeProcesses.includes(command as RuntimeProcess)) {
	console.error("release command is invalid");
	process.exit(64);
}

try {
	const config = validateReleaseCommand(command as RuntimeProcess);
	const manifestFile = process.env.AGENDIA_ISOLATION_MANIFEST_FILE;
	if (!manifestFile) throw new Error("environment.manifest_unavailable");
	preflightStaticEnvironment({
		config,
		manifest: JSON.parse(
			readFileSync(manifestFile, "utf8"),
		) as IsolationManifest,
	});
} catch {
	console.error(
		JSON.stringify({ code: "runtime.configuration_invalid", process: command }),
	);
	process.exit(78);
}
