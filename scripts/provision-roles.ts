import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
	provisionRoles,
	roleNamesForEnvironment,
	type DeploymentEnvironment,
} from "./support/database-role-provisioning.ts";

const environment = process.env.AGENDIA_ENVIRONMENT as DeploymentEnvironment;
if (environment !== "production" && environment !== "staging")
	throw new Error("AGENDIA_ENVIRONMENT must be staging or production");
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
		databaseName:
			process.env.AGENDIA_DATABASE_NAME ??
			`agendia_${environment === "production" ? "prod" : "stg"}`,
		credentials,
	});
} finally {
	await sql.end();
}
