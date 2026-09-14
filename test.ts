// Smallest runnable check: fail-safe paths and parsing. Run: node --experimental-strip-types test.ts (Node 22+) or npx jiti test.ts
import assert from "node:assert";
import { loadConfig } from "./src/config.ts";
import { evaluateRequest, parseVerdict, renderRequest, toVerdict } from "./src/judge.ts";
import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";

// parseVerdict
assert.equal(parseVerdict('{"verdict":"allow","reason":"ok"}')?.verdict, "allow");
assert.equal(parseVerdict('```json\n{"verdict":"deny","reason":"rm -rf"}\n```')?.verdict, "deny");
assert.equal(parseVerdict('{"verdict":"defer"}')?.verdict, "defer");
assert.equal(parseVerdict("sure thing, allow it"), undefined);
assert.equal(parseVerdict('{"verdict":"ALLOW"}'), undefined);

// toVerdict mapping — model "defer" must stay defer (human decides), never deny
assert.deepEqual(toVerdict({ verdict: "allow" }), { kind: "allow" });
assert.deepEqual(toVerdict({ verdict: "deny", reason: "rm -rf" }), { kind: "deny", reason: "rm -rf" });
assert.deepEqual(toVerdict({ verdict: "defer" }), { kind: "defer" });

// config fallback
const config = loadConfig();
assert.ok(config.timeoutMs > 0);
assert.ok("provider" in config); // optional now — session model is the fallback

// fail-safe: bad provider/model must resolve defer, not throw
const details = {
	payload: {
		kind: "bash",
		request: {
			requester: { agentName: null, forwarded: false, sessionId: null },
			surface: "bash",
			toolName: "bash",
			invokedToolName: null,
			value: "rm -rf /tmp/x",
			matchedPattern: "rm -rf*",
			commandContext: null,
			executedUnit: null,
		},
		evidence: [{ label: "rule", text: "deny *", detail: null }],
		annotations: [],
	},
} as unknown as PromptPermissionDetails;
assert.match(renderRequest(details), /rm -rf \/tmp\/x/);

const verdict = await evaluateRequest(details, { ...config, provider: "no-such-provider", timeoutMs: 500 }, undefined);
assert.deepEqual(verdict, { kind: "defer" });

// fail-safe: timeout must resolve defer
const slowConfig = { ...config, provider: "openrouter", model: "openai/gpt-4o-mini", timeoutMs: 1 };
const timedOut = await evaluateRequest(details, slowConfig, undefined);
assert.deepEqual(timedOut, { kind: "defer" });

// no explicit model + no session model → defer (fail-safe)
const noModel = await evaluateRequest(details, { timeoutMs: 500, options: {} }, undefined);
assert.deepEqual(noModel, { kind: "defer" });

console.log("ALL TESTS PASSED");
