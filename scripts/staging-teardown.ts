export type ManagedResource = {
	id: string;
	name: string;
	labels: Record<string, string | undefined>;
};

export type ProductionIdentity = { id: string; checksum: string };

type TeardownInput = {
	environment: string;
	inspect: () => ManagedResource[] | Promise<ManagedResource[]>;
	observeProduction: () => ProductionIdentity[] | Promise<ProductionIdentity[]>;
	run: (command: string[]) => void | Promise<void>;
};

const expectedLabels = {
	"com.agendia.environment": "staging",
	"com.agendia.project": "agendia-stg",
	"com.agendia.managed": "true",
};

function productionSnapshot(resources: ProductionIdentity[]): string {
	return JSON.stringify(
		resources
			.map(({ id, checksum }) => ({ id, checksum }))
			.sort((left, right) => left.id.localeCompare(right.id)),
	);
}

function assertStagingResource(resource: ManagedResource): void {
	if (!resource.id || !resource.name || /prod/i.test(resource.name))
		throw new Error("refusing resource containing prod");
	for (const [key, value] of Object.entries(expectedLabels)) {
		if (resource.labels[key] !== value)
			throw new Error(`refusing unmanaged staging resource: ${resource.name}`);
	}
	if (Object.values(resource.labels).some((value) => /prod/i.test(value ?? "")))
		throw new Error("refusing resource containing prod");
}

export async function teardownStaging(input: TeardownInput): Promise<void> {
	if (input.environment !== "staging")
		throw new Error("teardown accepts only literal staging");
	const before = productionSnapshot(await input.observeProduction());
	const resources = await input.inspect();
	resources.forEach(assertStagingResource);
	await input.run([
		"docker",
		"compose",
		"-p",
		"agendia-stg",
		"-f",
		"deploy/compose.yml",
		"down",
		"--volumes",
		"--remove-orphans",
	]);
	const after = productionSnapshot(await input.observeProduction());
	if (after !== before)
		throw new Error("production identity changed during staging teardown");
}
