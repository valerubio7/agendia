import {
  runtimeProcesses,
  validateReleaseCommand,
  type RuntimeProcess,
} from "@agendia/runtime-config";

const command = process.argv[2];
if (!runtimeProcesses.includes(command as RuntimeProcess)) {
  console.error("release command is invalid");
  process.exit(64);
}

try {
  validateReleaseCommand(command as RuntimeProcess);
} catch {
  console.error(JSON.stringify({ code: "runtime.configuration_invalid", process: command }));
  process.exit(78);
}
