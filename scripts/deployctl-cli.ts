/** Slice 1 deliberately ships no host operation before handoff verification exists. */
export function parseDeploymentCommand(_argv: string[]): never {
	throw new Error("deployctl.disabled");
}

if (import.meta.main) parseDeploymentCommand(process.argv.slice(2));
