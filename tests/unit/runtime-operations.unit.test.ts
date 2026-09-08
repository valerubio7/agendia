import { describe, expect, test } from "bun:test";
import {
	HEARTBEAT_CADENCE_MS,
	HEARTBEAT_STALE_MS,
	createDrain,
	createDurableReadiness,
	createHeartbeat,
	redactOperationsValue,
	serializeOperationalLog,
} from "@agendia/runtime-config";

describe("release operations primitives", () => {
	test("RED: recursively removes sensitive payload values while preserving approved opaque IDs", () => {
		const output = redactOperationsValue({
			cookie: "session=private",
			authorization: "Bearer private",
			auth: "private",
			credentials: "private",
			session: "private",
			body: "private",
			prompt: "private",
			response: "private",
			secret: "private",
			password: "private",
			token: "private",
			key: "private",
			qr: "private",
			jid: "15551234567@s.whatsapp.net",
			ciphertext: "private",
			databaseUrl: "postgresql://user:private@postgres/agendia_prod",
			message: "private",
			text: "private",
			requestId: "request-opaque",
			jobId: "job-opaque",
			instanceId: "instance-opaque",
			nested: { authorization: "private", body: { response: "private" } },
		});
		expect(output).toEqual({
			cookie: "[REDACTED]",
			authorization: "[REDACTED]",
			auth: "[REDACTED]",
			credentials: "[REDACTED]",
			session: "[REDACTED]",
			body: "[REDACTED]",
			prompt: "[REDACTED]",
			response: "[REDACTED]",
			secret: "[REDACTED]",
			password: "[REDACTED]",
			token: "[REDACTED]",
			key: "[REDACTED]",
			qr: "[REDACTED]",
			jid: "[REDACTED]",
			ciphertext: "[REDACTED]",
			databaseUrl: "[REDACTED]",
			message: "[REDACTED]",
			text: "[REDACTED]",
			requestId: "request-opaque",
			jobId: "job-opaque",
			instanceId: "instance-opaque",
			nested: { authorization: "[REDACTED]", body: "[REDACTED]" },
		});
		expect(
			serializeOperationalLog({
				level: "warn",
				service: "worker",
				environment: "staging",
				releaseDigest: "sha256:abc",
				instanceId: "instance-opaque",
				code: "draining",
				details: { response: "private" },
			}),
		).not.toContain("private");
	});

	test("RED: emits stable JSON lines and applies the 30-second cadence with a 60-second stale boundary", async () => {
		expect(HEARTBEAT_CADENCE_MS).toBe(30_000);
		expect(HEARTBEAT_STALE_MS).toBe(60_000);
		let writes = 0;
		const heartbeat = createHeartbeat({
			write: async () => {
				writes += 1;
			},
			now: () => 100,
		});
		await heartbeat.start();
		await heartbeat.tick();
		expect(writes).toBe(2);
		expect(heartbeat.isFresh(60_100)).toBe(true);
		expect(heartbeat.isFresh(60_101)).toBe(false);
	});

	test("RED: synchronously becomes unready before durable draining persistence completes", async () => {
		let persistDraining: (() => void) | undefined;
		const writes: string[] = [];
		const readiness = createDurableReadiness({
			persistDraining: () =>
				new Promise<void>((resolve) => {
					persistDraining = () => {
						writes.push("draining");
						resolve();
					};
				}),
		});
		expect(readiness.ready()).toEqual({ ready: true, code: "ready" });
		const marked = readiness.markUnready();
		expect(readiness.ready()).toEqual({ ready: false, code: "draining" });
		expect(writes).toEqual([]);
		persistDraining?.();
		await marked;
		expect(writes).toEqual(["draining"]);
	});

	test("RED: marks unready then drains once, continuing mandatory cleanup after runtime timeout", async () => {
		const calls: string[] = [];
		let releaseCleanup: (() => void) | undefined;
		const waitForCleanup = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const drain = createDrain({
			timeoutMs: 5,
			markUnready: async () => {
				calls.push("unready");
			},
			stopIntake: async () => {
				calls.push("intake");
			},
			stopTimers: async () => {
				calls.push("timers");
			},
			stopProbe: async () => {
				calls.push("probe");
			},
			stopRuntime: async () => {
				calls.push("runtime");
				await new Promise(() => {});
			},
			releaseLocks: async () => {
				calls.push("locks");
				releaseCleanup?.();
			},
			awaitInFlightLockCleanup: async () => {
				await waitForCleanup;
				calls.push("lock-cleanup");
			},
			closePools: async () => {
				calls.push("pools");
			},
		});
		await Promise.all([drain(), drain()]);
		expect(calls).toEqual([
			"unready",
			"intake",
			"timers",
			"probe",
			"runtime",
			"locks",
			"lock-cleanup",
			"pools",
		]);
	});

	test("RED: retains local draining readiness when durable persistence rejects", async () => {
		const readiness = createDurableReadiness({
			persistDraining: async () => {
				throw new Error("database unavailable");
			},
		});
		await expect(readiness.markUnready()).rejects.toThrow(
			"database unavailable",
		);
		expect(readiness.ready()).toEqual({ ready: false, code: "draining" });
	});

	test("RED: continues pool closure when an ordered stop operation fails", async () => {
		const calls: string[] = [];
		const drain = createDrain({
			timeoutMs: 20,
			markUnready: async () => {
				calls.push("unready");
			},
			stopIntake: async () => {
				calls.push("intake");
			},
			stopTimers: async () => {
				calls.push("timers");
				throw new Error("timer failure");
			},
			stopProbe: async () => {
				calls.push("probe");
			},
			stopRuntime: async () => {
				calls.push("runtime");
			},
			releaseLocks: async () => {
				calls.push("locks");
			},
			awaitInFlightLockCleanup: async () => {
				calls.push("lock-cleanup");
			},
			closePools: async () => {
				calls.push("pools");
			},
		});
		await drain();
		expect(calls).toEqual([
			"unready",
			"intake",
			"timers",
			"probe",
			"runtime",
			"locks",
			"lock-cleanup",
			"pools",
		]);
	});
});
