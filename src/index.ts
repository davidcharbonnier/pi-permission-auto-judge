import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadConfig } from "./config.ts";
import { evaluateRequest } from "./judge.ts";

/**
 * auto-judge — model-based authorizer chain link for
 * @gotgenes/pi-permission-system.
 *
 * Registers on `permissions:ready` (may fire more than once per session —
 * registration must be idempotent) so load order and `/reload` are handled.
 * A ready event that arrives before the permission system has published its
 * service leaves the link unregistered, and the next emission retries.
 *
 * Registration alone grants no authority: the operator must name
 * "auto-judge" in the permission system's `authorizerChain` config.
 */
export default function (pi: ExtensionAPI) {
	const unregisters = new Map<string, () => void>();
	const pending = new Set<string>();
	// Sessions whose shutdown already ran — a poll still in flight must not register them.
	const dead = new Set<string>();
	const config = loadConfig();
	// Session's active model — the judge's fallback when config has no explicit model.
	let sessionModel: Model<Api> | undefined;

	const register = (sessionId: string) => {
		if (pending.has(sessionId)) return;
		pending.add(sessionId);
		void (async () => {
			try {
				const { getPermissionsService } = await import("@gotgenes/pi-permission-system");
				// Service publication races extension load — poll rather than trusting a
				// further `permissions:ready` emission that may never come.
				for (let i = 0; i < 30; i++) {
					if (dead.has(sessionId)) return;
					const service = getPermissionsService(sessionId);
					if (service) {
						// A re-published service (reload) lost our link — unregister ours first, always re-register.
						unregisters.get(sessionId)?.();
						unregisters.set(
							sessionId,
							service.registerAuthorizer("auto-judge", (details, _query, log) =>
								evaluateRequest(details, config, sessionModel, log),
							),
						);
						return;
					}
					await new Promise((r) => setTimeout(r, 500));
				}
				pi.events.emit("auto-judge:register_failed", { sessionId, error: "service not published after 15s" });
			} catch (err) {
				// Permission system not installed or name taken — degrade silently;
				// the human prompt is the fallback either way. Next ready retries.
				pi.events.emit("auto-judge:register_failed", { sessionId, error: String(err) });
			} finally {
				pending.delete(sessionId);
			}
		})();
	};

	pi.events.on("permissions:ready", (data) => {
		const sessionId = (data as { sessionId?: string }).sessionId;
		if (sessionId) register(sessionId);
	});

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		sessionModel = ctx.model as Model<Api> | undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) register(sessionId);
	});

	pi.on("model_select", (event: { model?: Model<Api> }) => {
		if (event.model) sessionModel = event.model;
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		dead.add(sessionId);
		unregisters.get(sessionId)?.();
		unregisters.delete(sessionId);
	});
}
