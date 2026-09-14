import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface JudgeOptions {
	temperature?: number;
	maxTokens?: number;
	/** Optional reasoning level; "none" (default) disables thinking. Mapped to pi-ai `reasoning`. */
	reasoningEffort?: string;
}

export interface JudgeConfig {
	/** Explicit judge model; omit either to fall back to the session's active model. */
	provider?: string;
	model?: string;
	timeoutMs: number;
	options: JudgeOptions;
}

const DEFAULTS: JudgeConfig = {
	timeoutMs: 4000,
	options: { temperature: 0, maxTokens: 150, reasoningEffort: "none" },
};

/** Candidate paths, first hit wins: project-local, then global. */
function candidatePaths(): string[] {
	return [
		join(process.cwd(), ".pi", "extensions", "pi-permission-auto-judge", "config.json"),
		join(homedir(), ".pi", "agent", "extensions", "pi-permission-auto-judge", "config.json"),
		// packaged default template, for a bare checkout without either location
		join(dirname(fileURLToPath(import.meta.url)), "..", "config.json"),
	];
}

/**
 * Load config. Project-local overrides global; missing file or bad JSON
 * falls back to DEFAULTS (and to the packaged `config.json` template next
 * to the source, for a bare checkout). Fail-safe: never throws.
 */
export function loadConfig(): JudgeConfig {
	for (const path of candidatePaths()) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<JudgeConfig>;
			return {
				provider: raw.provider,
				model: raw.model,
				timeoutMs: typeof raw.timeoutMs === "number" && raw.timeoutMs > 0 ? raw.timeoutMs : DEFAULTS.timeoutMs,
				options: { ...DEFAULTS.options, ...raw.options },
			};
		} catch {
			// Missing or unparseable — try the next candidate.
		}
	}
	return DEFAULTS;
}
