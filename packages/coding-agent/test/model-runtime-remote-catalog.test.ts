import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const REMOTE_CATALOG_ENV = "C_CODE_REMOTE_CATALOG";

describe("model runtime remote catalog wiring", () => {
	let originalEnv: string | undefined;

	beforeEach(() => {
		originalEnv = process.env[REMOTE_CATALOG_ENV];
		delete process.env[REMOTE_CATALOG_ENV];
	});

	afterEach(() => {
		if (originalEnv === undefined) delete process.env[REMOTE_CATALOG_ENV];
		else process.env[REMOTE_CATALOG_ENV] = originalEnv;
	});

	function createRuntime(catalogBaseUrl?: string): Promise<ModelRuntime> {
		return ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
			...(catalogBaseUrl === undefined ? {} : { catalogBaseUrl }),
		});
	}

	it("does not attach the remote catalog overlay by default", async () => {
		const runtime = await createRuntime();
		expect(runtime.getProvider("openai")).toBeDefined();
		expect(runtime.getProvider("openai")?.refreshModels).toBeUndefined();
	});

	it("attaches the remote catalog overlay when C_CODE_REMOTE_CATALOG=1", async () => {
		process.env[REMOTE_CATALOG_ENV] = "1";
		const runtime = await createRuntime();
		expect(runtime.getProvider("openai")?.refreshModels).toBeDefined();
	});

	it("attaches the remote catalog overlay for an explicit catalogBaseUrl", async () => {
		const runtime = await createRuntime("https://catalog.example.test");
		expect(runtime.getProvider("openai")?.refreshModels).toBeDefined();
	});
});
