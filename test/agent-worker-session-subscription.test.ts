import {
	buildCompletedStatus,
	buildRunningStatus,
	createWorkerTrackingState,
} from "../src/agent/worker/status.js";
import { describe, expect, it } from "vitest";

describe("worker status builders", () => {
	it("omits active turn timestamp until a turn starts", () => {
		const tracking = createWorkerTrackingState();

		expect(buildRunningStatus(tracking)).toEqual({
			state: "running",
			turns: 0,
			toolCalls: 0,
			workedMs: 0,
			tools: [],
		});

		tracking.turnStartTime = 42;
		tracking.turns = 2;
		tracking.toolCalls = 3;
		tracking.workedMs = 99;
		tracking.tools.push({ name: "read", args: "file.ts", result: "ok" });

		expect(buildCompletedStatus(tracking, "done")).toEqual({
			state: "completed",
			message: "done",
			turns: 2,
			toolCalls: 3,
			workedMs: 99,
			tools: [{ name: "read", args: "file.ts", result: "ok" }],
		});
	});
});
