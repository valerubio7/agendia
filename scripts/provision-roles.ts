import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
	loadRuntimeConfig,
	preflightStaticEnvironment,
	type IsolationManifest,
} from "@agendia/runtime-config";
import {
	provisionRoles,
	roleNamesForEnvironment,
	type DeploymentEnvironment,
} from "./support/database-role-provisioning.ts";

const config = loadRuntimeConfig("provision-roles");
const environment = config.environment as DeploymentEnvironment;
if (environment !== "production" && environment !== "staging")
	throw new Error("AGENDIA_ENVIRONMENT must be staging or production");
const manifestFile = process.env.AGENDIA_ISOLATION_MANIFEST_FILE;
if (!manifestFile)
	throw new Error("AGENDIA_ISOLATION_MANIFEST_FILE is required");
try {
	preflightStaticEnvironment({
		config,
		manifest: JSON.parse(
			readFileSync(manifestFile, "utf8"),
		) as IsolationManifest,
	});
} catch {
	throw new Error("environment.static_preflight_invalid");
}
const adminUrlFile = process.env.CLUSTER_ADMIN_DATABASE_URL_FILE;
if (!adminUrlFile)
	throw new Error("CLUSTER_ADMIN_DATABASE_URL_FILE is required");
const roles = roleNamesForEnvironment(environment);
const credentials = Object.fromEntries(
	Object.values(roles).map((name) => {
		const path = process.env[`${name.toUpperCase()}_PASSWORD_FILE`];
		if (!path) throw new Error(`${name}_PASSWORD_FILE is required`);
		return [name, readFileSync(path, "utf8").trim()];
	}),
);
const sql = postgres(readFileSync(adminUrlFile, "utf8").trim(), { max: 1 });
try {
	await provisionRoles(sql, {
		environment,
		databaseName: `agendia_${environment === "production" ? "prod" : "stg"}`,
		credentials,
	});
} finally {
	await sql.end();
}
