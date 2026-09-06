import { PostgresRepositories } from "@agendia/db";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	applyPostgresMigrations,
	startTestPostgres,
	type TestPostgres,
} from "../support/postgres.ts";

describe("durable service heartbeats", () => {
	let database: TestPostgres;
	let repositories: PostgresRepositories;
	beforeAll(async () => {
		database = await startTestPostgres();
		await applyPostgresMigrations(
			database.sql,
			join(process.cwd(), "packages/db/migrations"),
		);
		repositories = new PostgresRepositories(database.sql);
	}, 120_000);
	afterAll(async () => {
		await database?.stop();
	});

	test("RED: production heartbeat APIs record isolated instances and classify a healthy idle worker", async () => {
		await repositories.upsertServiceHeartbeat({
			service: "message-worker",
			instanceId: "idle-worker",
			releaseDigest: "sha256:abc",
			state: "ready",
		});
		await repositories.upsertServiceHeartbeat({
			service: "whatsapp-manager",
			instanceId: "manager",
			releaseDigest: "sha256:def",
			state: "ready",
		});
		await database.sql`update agendia_service_heartbeats set last_seen_at=now() - interval '61 seconds' where service='whatsapp-manager' and instance_id='manager'`;
		expect(
			await repositories.serviceHeartbeatReady(
				"message-worker",
				"idle-worker",
				60_000,
			),
		).toEqual({ ready: true, code: "ready" });
		expect(
			await repositories.serviceHeartbeatReady(
				"whatsapp-manager",
				"manager",
				60_000,
			),
		).toEqual({ ready: false, code: "heartbeat.stale" });
	});

	test("RED: production readiness API returns the marker-missing code without values", async () => {
		expect(await repositories.releaseReadiness()).toEqual({
			ready: false,
			code: "environment.marker_missing",
		});
	});
});
