import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys } from "../src/env-api-keys.ts";

/**
 * Provider factories declare the env vars they accept, and `env-api-keys.ts` keeps a
 * separate discovery map used for credential status and the compat API-key path. Both
 * lists must agree: a provider that accepts a variable discovery does not know about
 * cannot report the credential as configured, and the divergence stays silent.
 *
 * This suite scans the provider sources and proves every declared variable is
 * discoverable, so adding one to a provider without the map fails here.
 */
const providerDir = fileURLToPath(new URL("../src/providers", import.meta.url));
const NON_PROVIDER_FILES = new Set(["all.ts", "faux.ts", "data-json.d.ts"]);

type DeclaredEnvVar = { file: string; providerId: string; envVar: string };

const declaredEnvVars: DeclaredEnvVar[] = [];
for (const file of readdirSync(providerDir)) {
	if (!file.endsWith(".ts") || file.endsWith(".models.ts") || NON_PROVIDER_FILES.has(file)) continue;
	const source = readFileSync(join(providerDir, file), "utf-8");
	const providerId = source.match(/id:\s*"([^"]+)"/)?.[1];
	if (!providerId) continue;
	for (const call of source.matchAll(/envApiKeyAuth\(\s*"[^"]*",\s*\[([^\]]*)\]/gs)) {
		for (const quoted of call[1].matchAll(/"([^"]+)"/g)) {
			declaredEnvVars.push({ file, providerId, envVar: quoted[1] });
		}
	}
}

const probedEnvVars: string[] = [];

afterEach(() => {
	for (const envVar of probedEnvVars.splice(0)) delete process.env[envVar];
});

describe("provider env var discovery", () => {
	it("scans provider factories", () => {
		expect(declaredEnvVars.length).toBeGreaterThan(20);
	});

	it("discovers every env var a provider accepts", () => {
		const notDiscoverable: string[] = [];
		for (const { file, providerId, envVar } of declaredEnvVars) {
			process.env[envVar] = "probe-value";
			probedEnvVars.push(envVar);
			const discovered = findEnvKeys(providerId) ?? [];
			if (!discovered.includes(envVar)) {
				notDiscoverable.push(
					`${file} (${providerId}) declares ${envVar}, findEnvKeys returned ${discovered.join(", ")}`,
				);
			}
		}
		expect(notDiscoverable).toEqual([]);
	});
});
