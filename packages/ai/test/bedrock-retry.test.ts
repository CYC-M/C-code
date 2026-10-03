import { beforeEach, describe, expect, it, vi } from "vitest";

type SendOutcome = { kind: "reject"; error: unknown } | { kind: "resolve"; response: unknown };

const bedrockMock = vi.hoisted(() => ({
	queue: [] as SendOutcome[],
	sendCount: 0,
	// Exposed so tests can build errors that are real instances of the mocked base class.
	ServiceException: undefined as unknown as new (message?: string) => Error,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}
	bedrockMock.ServiceException = BedrockRuntimeServiceException;

	class BedrockRuntimeClient {
		middlewareStack = { add: () => undefined };

		async send(): Promise<unknown> {
			bedrockMock.sendCount += 1;
			const outcome = bedrockMock.queue.shift();
			if (!outcome) throw new Error("test did not configure a send outcome");
			if (outcome.kind === "reject") throw outcome.error;
			return outcome.response;
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

const model = getModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

/** The SDK surfaces the HTTP status on `$metadata`, which the adapter normalizes for the retry policy. */
function throttlingError(): Error {
	const error = new bedrockMock.ServiceException("Too many requests") as Error & Record<string, unknown>;
	error.name = "ThrottlingException";
	error.$metadata = { httpStatusCode: 429, requestId: "request-id" };
	// Keep the retry immediate so the test does not sleep through the backoff.
	error.headers = new Headers({ "retry-after-ms": "0" });
	return error;
}

function successOutcome(): SendOutcome {
	return {
		kind: "resolve",
		response: {
			$metadata: { httpStatusCode: 200, requestId: "request-id" },
			stream: (async function* () {
				yield { messageStart: { role: "assistant" } };
				yield { messageStop: { stopReason: "end_turn" } };
			})(),
		},
	};
}

beforeEach(() => {
	bedrockMock.queue.length = 0;
	bedrockMock.sendCount = 0;
});

describe("Bedrock request retries", () => {
	it("retries a throttled request when maxRetries is set", async () => {
		bedrockMock.queue.push({ kind: "reject", error: throttlingError() }, successOutcome());

		const message = await streamBedrock(model, context, {
			cacheRetention: "none",
			maxRetries: 1,
		}).result();

		expect(bedrockMock.sendCount).toBe(2);
		expect(message.stopReason).toBe("stop");
	});

	it("does not retry when maxRetries is not set", async () => {
		bedrockMock.queue.push({ kind: "reject", error: throttlingError() });

		const message = await streamBedrock(model, context, { cacheRetention: "none" }).result();

		expect(bedrockMock.sendCount).toBe(1);
		expect(message.stopReason).toBe("error");
	});
});
