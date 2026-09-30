import type { Context } from "@earendil-works/pi-ai";
import type { ReviewResult, TaskPackage, TeamTask, WorkerResult } from "./types.ts";

function applyFileOffsetLimit(bytes: string, offset?: number, limit?: number): string {
	const safeOffset = typeof offset === "number" && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
	const lines = bytes.split("\n");
	const afterOffset = lines.slice(safeOffset);
	const limited =
		typeof limit === "number" && Number.isFinite(limit) && limit >= 0
			? afterOffset.slice(0, Math.floor(limit))
			: afterOffset;
	return limited.join("\n");
}

export async function buildWorkerMessages(
	pkg: TaskPackage,
	readFile: (path: string) => Promise<string>,
): Promise<Context> {
	const parts: string[] = [
		`Task ${pkg.assignment.id}: ${pkg.assignment.title}`,
		`Goal: ${pkg.assignment.goal}`,
		`Success criteria:\n${pkg.assignment.successCriteria.map((c) => `- ${c}`).join("\n")}`,
		`Attempt ${pkg.attempt}, delegation depth ${pkg.depth}.`,
	];
	if (pkg.assignment.inputs !== undefined) parts.push(`Inputs:\n${JSON.stringify(pkg.assignment.inputs, null, 2)}`);
	if (pkg.contextSlice.notes) parts.push(`Notes: ${pkg.contextSlice.notes}`);
	for (const prior of pkg.contextSlice.priorSummaries ?? []) {
		parts.push(`Prior result [${prior.taskId}]: ${prior.summary}`);
	}
	for (const file of pkg.contextSlice.files ?? []) {
		const bytes = await readFile(file.path);
		const sliced = applyFileOffsetLimit(bytes, file.offset, file.limit);
		parts.push(`File ${file.path}:\n${sliced.slice(0, 8000)}`);
	}
	return {
		systemPrompt: pkg.rolePrompt,
		messages: [{ role: "user", content: parts.join("\n\n"), timestamp: Date.now() }],
	};
}

function extractJson(text: string, what: string): unknown {
	const fenced = text.match(/```json\s*([\s\S]*?)```/);
	try {
		return JSON.parse((fenced?.[1] ?? text).trim());
	} catch {
		throw new Error(`unparseable ${what} output`);
	}
}

export function parseReviewOutput(text: string, runId: string): ReviewResult {
	const parsed = extractJson(text, "review") as {
		verdict?: unknown;
		findings?: unknown;
		retryPlan?: ReviewResult["retryPlan"];
	};
	if (parsed.verdict !== "pass" && parsed.verdict !== "needs_fix") throw new Error("unparseable review output");
	if (!Array.isArray(parsed.findings)) throw new Error("unparseable review output");
	return { runId, verdict: parsed.verdict, findings: parsed.findings, retryPlan: parsed.retryPlan };
}

export function parseWorkerOutput(text: string): {
	summary: string;
	data?: unknown;
	artifacts?: { path: string; kind: string }[];
} {
	const parsed = extractJson(text, "worker") as { summary?: unknown; data?: unknown; artifacts?: unknown };
	if (typeof parsed.summary !== "string") throw new Error("unparseable worker output");
	let artifacts: { path: string; kind: string }[] | undefined;
	if (Array.isArray(parsed.artifacts)) {
		const valid = parsed.artifacts.filter(
			(a): a is { path: string; kind: string } =>
				typeof a === "object" &&
				a !== null &&
				typeof (a as { path?: unknown }).path === "string" &&
				typeof (a as { kind?: unknown }).kind === "string",
		);
		if (valid.length > 0) artifacts = valid;
	}
	return {
		summary: parsed.summary,
		data: parsed.data,
		...(artifacts ? { artifacts } : {}),
	};
}

export function summarizeResults(results: Record<string, WorkerResult>, tasks?: TeamTask[]): string {
	const lines = Object.values(results).map(
		(r) => `- [${r.status}] ${r.taskId} (${r.role} @ ${r.model.provider}/${r.model.id}): ${r.summary}`,
	);
	if (tasks) {
		const skipped = tasks.filter((t) => results[t.id] === undefined);
		for (const t of skipped) {
			const waiting = (t.dependsOn ?? []).filter((d) => results[d] === undefined);
			lines.push(`Skipped: ${t.id} (waiting on ${waiting.length > 0 ? waiting.join(", ") : "unmet dependencies"})`);
		}
	}
	return lines.join("\n");
}
