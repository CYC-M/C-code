import { describe, expect, it } from "vitest";
import {
	buildWorkerMessages,
	parseReviewOutput,
	parseWorkerOutput,
	summarizeResults,
} from "../../src/core/teamwork/context.ts";
import { assembleTeamConfig } from "../../src/core/teamwork/roles.ts";
import type { TaskPackage } from "../../src/core/teamwork/types.ts";

const pkg: TaskPackage = {
	runId: "r1",
	assignment: { id: "t1", title: "Fix bug", goal: "Fix null crash", role: "worker", successCriteria: ["no crash"] },
	contextSlice: { notes: "stack trace attached", priorSummaries: [{ taskId: "t0", summary: "repro done" }] },
	rolePrompt: "You implement.",
	allowSubAgents: false,
	attempt: 1,
	depth: 0,
};

describe("roles and context", () => {
	it("assembles team config from persisted role bindings", () => {
		const team = assembleTeamConfig({
			worker: { provider: "openai", model: "gpt-5" },
			reviewer: { provider: "anthropic", model: "claude-sonnet-4-5" },
		});
		expect(team.roles.worker.model).toBe("gpt-5");
		expect(team.reviewer).toBe("reviewer");
	});

	it("refuses to assemble a team with no reviewer configured", () => {
		expect(() => assembleTeamConfig({ worker: { provider: "openai", model: "gpt-5" } })).toThrow("no reviewer role");
	});

	it("builds scoped worker messages without full transcript", async () => {
		const messages = await buildWorkerMessages(pkg, async () => "file-bytes");
		const text = JSON.stringify(messages);
		expect(text).toContain("Fix null crash");
		expect(text).toContain("repro done");
	});

	it("parses reviewer JSON verdicts and rejects garbage explicitly", () => {
		const ok = parseReviewOutput('```json\n{"verdict":"pass","findings":[]}\n```', "r1");
		expect(ok.verdict).toBe("pass");
		expect(() => parseReviewOutput("looks good to me", "r1")).toThrow("unparseable review output");
	});

	it("summarizes results compactly for the transcript", () => {
		const s = summarizeResults({
			t1: { taskId: "t1", role: "worker", model: { provider: "o", id: "m" }, status: "ok", summary: "fixed" },
		});
		expect(s).toContain("t1");
		expect(s).toContain("fixed");
	});

	it("includes file bytes and honors offset/limit with an 8000-char cap", async () => {
		const filePkg: TaskPackage = {
			...pkg,
			contextSlice: { files: [{ path: "a.txt", offset: 1, limit: 1 }] },
		};
		const seen: string[] = [];
		const messages = await buildWorkerMessages(filePkg, async (path) => {
			seen.push(path);
			return "line0\nline1\nline2";
		});
		const text = JSON.stringify(messages);
		expect(seen).toEqual(["a.txt"]);
		expect(text).toContain("line1");
		expect(text).not.toContain("line0");
		expect(text).not.toContain("line2");
	});

	it("drops malformed artifacts but keeps valid ones", () => {
		const parsed = parseWorkerOutput(
			JSON.stringify({ summary: "s", artifacts: [{ path: "a", kind: "k" }, { kind: "k" }, { path: 1 }] }),
		);
		expect(parsed.artifacts).toEqual([{ path: "a", kind: "k" }]);
	});

	it("lists skipped tasks waiting on unmet dependencies", () => {
		const s = summarizeResults(
			{
				t1: { taskId: "t1", role: "worker", model: { provider: "o", id: "m" }, status: "ok", summary: "done" },
			},
			[
				{ id: "t1", title: "t", goal: "g", role: "worker", successCriteria: ["c"] },
				{ id: "t2", title: "t", goal: "g", role: "worker", dependsOn: ["t3"], successCriteria: ["c"] },
			],
		);
		expect(s).toContain("Skipped: t2 (waiting on t3)");
	});
});
