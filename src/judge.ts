import type { Api, Model } from "@earendil-works/pi-ai";
import { complete, getModel } from "@earendil-works/pi-ai/compat";
import type { AuthorizerLog, AuthorizerVerdict, PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import type { JudgeConfig } from "./config.ts";

const SYSTEM_PROMPT = `You are a security classifier reviewing a coding agent's pending tool request before it runs.
Decide one of:
- "allow": clearly safe — read-only, or a harmless reversible action within the project the user would not object to.
- "deny": clearly dangerous or destructive (deleting data, credential exfiltration, disabling security tooling, commands outside the project's intent). Give a short corrective reason.
- "defer": anything uncertain, ambiguous, expensive, or outside your confidence. A human will then decide.
When unsure, always answer "defer". Bias toward defer; only deny on high-confidence threats.
Reply with ONLY this JSON, no markdown, no extra text:
{"verdict":"allow|deny|defer","reason":"..."}`;

/** Compact, one-screen render of the ask for the judge. */
export function renderRequest(d: PromptPermissionDetails): string {
	const r = d.payload.request;
	const lines = [
		`surface: ${r.surface}`,
		r.toolName ? `tool: ${r.toolName}` : null,
		r.value !== "" ? `value: ${r.value}` : null,
		d.command && d.command !== r.value ? `command: ${d.command}` : null,
		d.path ? `path: ${d.path}` : null,
		d.target ? `target: ${d.target}` : null,
		d.toolInputPreview ? `input: ${d.toolInputPreview}` : null,
		r.commandContext ? `context: ${r.commandContext}` : null,
		r.executedUnit && r.executedUnit !== r.value ? `executes: ${r.executedUnit}` : null,
		r.requester.forwarded ? "source: subagent (forwarded)" : null,
		...d.payload.evidence.map((e) => `${e.label}: ${e.text}`),
	];
	return lines.filter((l) => l !== null).join("\n");
}

/** Map a parsed judge verdict onto a chain verdict. Defer stays defer — the human decides. */
export function toVerdict(v: { verdict: "allow" | "deny" | "defer"; reason?: string }): AuthorizerVerdict {
	if (v.verdict === "allow") return { kind: "allow" };
	if (v.verdict === "deny") return { kind: "deny", reason: v.reason };
	return { kind: "defer" };
}

/** Parse the model's reply; undefined unless it is a well-formed verdict. */
export function parseVerdict(text: string): { verdict: "allow" | "deny" | "defer"; reason?: string } | undefined {
	const match = text.match(/\{[\s\S]*\}/); // tolerate stray prose/fences around the JSON
	if (!match) return undefined;
	try {
		const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
		if (parsed.verdict === "allow" || parsed.verdict === "deny" || parsed.verdict === "defer") {
			return { verdict: parsed.verdict, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
		}
	} catch {
		// not JSON — fall through
	}
	return undefined;
}

function defer(log: AuthorizerLog | undefined, reason: string, detail?: Record<string, unknown>): AuthorizerVerdict {
	log?.review("auto_judge_deferred", { reason, ...detail });
	return { kind: "defer" };
}

/**
 * Ask the configured model to judge the request.
 * Fail-safe: every failure path (timeout, network, bad JSON, unknown model)
 * resolves `{ kind: "defer" }` so the human prompt happens normally.
 */
export async function evaluateRequest(
	details: PromptPermissionDetails,
	config: JudgeConfig,
	sessionModel: Model<Api> | undefined,
	log?: AuthorizerLog,
): Promise<AuthorizerVerdict> {
	try {
		// Explicit config wins; otherwise reuse the session's already-resolved model.
		let model: Model<Api> | undefined;
		if (config.provider && config.model) {
			// ponytail: string model ids not in pi-ai's static registry need the cast; upgrade when pi-ai types allow
			model = getModel(config.provider as never, config.model as never) as Model<Api> | undefined;
			// Unknown id in config (typo) — fall back to the session model, not silent no_model forever.
			if (!model) log?.debug("auto_judge_model_fallback", { requested: `${config.provider}/${config.model}` });
		}
		model ??= sessionModel;
		if (!model) return defer(log, "no_model");

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), config.timeoutMs);
		let response;
		try {
			response = await complete(
				model,
				{
					systemPrompt: SYSTEM_PROMPT,
					messages: [{ role: "user", content: renderRequest(details), timestamp: Date.now() }],
				},
				{
					signal: controller.signal,
					temperature: config.options.temperature,
					maxTokens: config.options.maxTokens,
					reasoning: config.options.reasoningEffort && config.options.reasoningEffort !== "none"
						? (config.options.reasoningEffort as "minimal")
						: undefined,
				},
			);
		} finally {
			clearTimeout(timer);
		}

		if (response.stopReason !== "stop" || response.errorMessage) {
			return defer(log, `stop_${response.stopReason}`, { error: response.errorMessage });
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim();

		const verdict = parseVerdict(text);
		if (!verdict) return defer(log, "unparseable", { text: text.slice(0, 200) });

		log?.review("auto_judge_verdict", {
			verdict: verdict.verdict,
			reason: verdict.reason,
			model: `${model.provider}/${model.id}`,
		});
		return toVerdict(verdict);
	} catch (err) {
		// Defer is fail-safe, but leave an audit trail — a silently deferring judge is hard to diagnose.
		return defer(
			log,
			err instanceof Error && err.name === "AbortError" ? "timeout" : "error",
			{ error: err instanceof Error ? err.message : String(err) },
		);
	}
}
