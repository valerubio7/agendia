import { readFileSync } from "node:fs";
import { join } from "node:path";
const lock = readFileSync(join(__dirname, "../../deploy/images.lock"), "utf8");

export function lockedImage(name: "BUN_IMAGE" | "POSTGRES_IMAGE"): string {
	const match = lock.match(new RegExp(`^${name}=([^\\s]+)$`, "m"));
	if (!match?.[1] || !/^[a-z0-9./_-]+@sha256:[a-f0-9]{64}$/.test(match[1]))
		throw new Error(`image_lock_invalid:${name}`);
	return match[1];
}

export const postgresImage = lockedImage("POSTGRES_IMAGE");
