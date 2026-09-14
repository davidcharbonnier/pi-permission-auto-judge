#!/usr/bin/env node
// Visualize a pi-permission-system review log: tool asks, decisions, and
// where the auto-judge was in the loop.
// Usage: node analyze-permissions.mjs [path/to/pi-permission-system-permission-review.jsonl]
// Writes permission-report.html next to the log (or in cwd) and prints a summary.

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const DEFAULT_LOG = join(
	process.env.HOME ?? "",
	".pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl",
);
const logPath = process.argv[2] ?? DEFAULT_LOG;
const outPath = join(dirname(logPath) === process.cwd() ? "." : process.cwd(), "permission-report.html");

const JUDGE_WINDOW_MS = 15_000; // judge event matched to nearest ask within this window

const entries = readFileSync(logPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return null;
		}
	})
	.filter(Boolean);

const t = (e) => new Date(e.timestamp).getTime();

// --- Asks: waiting/prompted paired with their resolution by requestId -------
const WAITING = new Set(["permission_request.waiting", "forwarded_permission.prompted"]);
const RESOLVED = new Set(["permission_request.approved", "permission_request.session_approved", "permission_request.denied", "forwarded_permission.approved", "forwarded_permission.denied"]);
const RESOLUTION_LABEL = {
	"permission_request.approved": "approved",
	"permission_request.session_approved": "session-approved",
	"permission_request.denied": "denied",
	"forwarded_permission.approved": "approved",
	"forwarded_permission.denied": "denied",
};

const waitingByReq = new Map();
const blocked = [];
for (const e of entries) {
	if (WAITING.has(e.event) && e.requestId) waitingByReq.set(e.requestId, e);
	else if (RESOLVED.has(e.event) && waitingByReq.has(e.requestId)) {
		const ask = waitingByReq.get(e.requestId);
		ask.resolution = RESOLUTION_LABEL[e.event];
		ask.resolutionTime = e.timestamp;
	} else if (e.event === "permission_request.blocked") blocked.push(e);
}

const asks = [...waitingByReq.values()];
for (const b of blocked) {
	asks.push({ timestamp: b.timestamp, toolName: b.toolName, command: b.path ?? b.command, resolution: "policy-denied" });
}

// --- Judge events, correlated to the nearest unclaimed ask ------------------
const judge = entries
	.filter((e) => e.event === "auto_judge_verdict" || e.event === "auto_judge_deferred")
	.map((e) => ({
		timestamp: e.timestamp,
		verdict: e.event === "auto_judge_verdict" ? e.verdict : `defer (${e.reason ?? "unknown"})`,
		reason: e.reason, // judge "reason" text only exists on verdicts; deferred uses `reason` for why
		text: e.event === "auto_judge_verdict" ? e.reason : e.error,
		model: e.model,
	}));
const claimed = new Set();
for (const j of judge) {
	let best = null;
	let bestDist = Infinity;
	for (const a of asks) {
		if (claimed.has(a)) continue;
		const d = Math.abs(t(a) - t(j));
		if (d < bestDist) {
			bestDist = d;
			best = a;
		}
	}
	if (best && bestDist <= JUDGE_WINDOW_MS) {
		best.judge = j;
		claimed.add(best);
	}
}

// --- Summary -----------------------------------------------------------------
const byDecision = {};
for (const a of asks) byDecision[a.resolution ?? "no-resolution"] = (byDecision[a.resolution ?? "no-resolution"] ?? 0) + 1;
const byTool = {};
for (const a of asks) byTool[a.toolName ?? "unknown"] = (byTool[a.toolName ?? "unknown"] ?? 0) + 1;
const judged = asks.filter((a) => a.judge);
const judgeByVerdict = {};
for (const j of judge) judgeByVerdict[j.verdict.split(" ")[0]] = (judgeByVerdict[j.verdict.split(" ")[0]] ?? 0) + 1;
const deferredReasons = {};
for (const j of judge) if (j.verdict.startsWith("defer")) deferredReasons[j.verdict] = (deferredReasons[j.verdict] ?? 0) + 1;

const fmt = (n) => String(n).padStart(6);
console.log(`
pi-permission-system review log: ${basename(logPath)} (${entries.length} events)
  Asks:          ${fmt(asks.length)}  ${Object.entries(byDecision).map(([k, v]) => `${k}=${v}`).join("  ")}
  Judge calls:   ${fmt(judge.length)}  ${Object.entries(judgeByVerdict).map(([k, v]) => `${k}=${v}`).join("  ")}${Object.keys(deferredReasons).length ? `  (${Object.entries(deferredReasons).map(([k, v]) => `${k}=${v}`).join(" ")})` : ""}
  Judge coverage: ${(100 * judged.length) / Math.max(asks.length, 1)}% of asks (matched within ±${JUDGE_WINDOW_MS / 1000}s)
Report: ${outPath}
`);

// --- Standalone HTML report --------------------------------------------------
const DAYS = Object.entries(
	asks.reduce((m, a) => {
		const day = a.timestamp.slice(0, 10);
		(m[day] ??= []).push(a);
		return m;
	}, {}),
).sort(([a], [b]) => (a < b ? -1 : 1));

const DECISION_COLOR = {
	approved: "#4ade80",
	"session-approved": "#2dd4bf",
	denied: "#f87171",
	"policy-denied": "#b91c1c",
	"no-resolution": "#6b7280",
};
const JUDGE_COLOR = { allow: "#4ade80", deny: "#f87171", defer: "#eab308" };

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const dayRows = DAYS.map(([day, dayAsks]) => {
	const dots = dayAsks
		.map((a) => {
			const pct = ((t(a) % 86_400_000) / 86_400_000) * 100;
			const judge = a.judge
				? ` <b style="color:${JUDGE_COLOR[a.judge.verdict.split(" ")[0]] ?? JUDGE_COLOR.defer}">judge: ${esc(a.judge.verdict)}</b> — ${esc(a.judge.text)} <i>(${esc(a.judge.model ?? "")})</i>`
				: "";
			const tip = `${fmtTime(a.timestamp)}  ${esc(a.toolName ?? "")}: ${esc(a.command ?? "").slice(0, 300)}\n→ ${esc(a.resolution ?? "?")}${judge}`;
			const ring = a.judge ? `box-shadow:0 0 0 2px ${JUDGE_COLOR[a.judge.verdict.split(" ")[0]] ?? JUDGE_COLOR.defer};` : "";
			return `<span class="dot" style="left:${pct}%;background:${DECISION_COLOR[a.resolution] ?? DECISION_COLOR["no-resolution"]};${ring}" title="${esc(tip)}"></span>`;})
		.join("");
	const judgeDots = dayAsks
		.filter((a) => a.judge)
		.map((a) => {
			const pct = ((t(a.judge) % 86_400_000) / 86_400_000) * 100;
			return `<span class="jtick" style="left:${pct}%;background:${JUDGE_COLOR[a.judge.verdict.split(" ")[0]] ?? JUDGE_COLOR.defer}" title="judge ${esc(a.judge.verdict)} — ${esc(a.judge.text)}"></span>`;
		})
		.join("");
	return `<div class="day">
  <div class="day-label">${day} <span class="count">${dayAsks.length} asks · ${dayAsks.filter((a) => a.judge).length} judged</span></div>
  <div class="lane">${dots}</div>
  <div class="lane judge-lane">${judgeDots}</div>
</div>`;
}).join("\n");

const bar = (m, color) => {
	const max = Math.max(...Object.values(m), 1);
	return Object.entries(m)
		.sort(([, a], [, b]) => b - a)
		.map(
			([k, v]) =>
				`<div class="bar-row"><span class="bar-label">${esc(k)}</span><span class="bar" style="width:${(100 * v) / max}%;background:${color}"></span><span class="bar-n">${v}</span></div>`,
		)
		.join("");
};

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>permission report</title>
<style>
  body { background:#111418; color:#d7dce2; font:13px/1.5 ui-monospace,monospace; margin:24px; }
  h1 { font-size:16px; font-weight:600; } h2 { font-size:13px; color:#9aa4b2; margin:24px 0 8px; }
  .legend span { margin-right:16px; } .legend i { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:5px; vertical-align:-1px; }
  .grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:0 40px; }
  .bar-row { display:flex; align-items:center; margin:3px 0; }
  .bar-label { width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#9aa4b2; flex:none; }
  .bar { height:12px; border-radius:2px; flex:none; } .bar-n { margin-left:8px; }
  table { border-collapse:collapse; margin-top:8px; width:100%; table-layout:fixed; } td,th { text-align:left; padding:2px 12px 2px 0; vertical-align:top; overflow-wrap:anywhere; }
  th { color:#9aa4b2; font-weight:400; } .allow{color:#4ade80}.deny{color:#f87171}.defer{color:#eab308}
  td.wide { width:auto; } td.t { width:70px; flex:none; } td.m { width:220px; color:#5c6672; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .day { display:grid; grid-template-columns:190px minmax(0,1fr); gap:12px; margin:4px 0; align-items:center; }
  .day-label { color:#9aa4b2; font-size:12px; } .count { color:#5c6672; display:block; }
  .lane { position:relative; height:34px; border-radius:4px; background:
    linear-gradient(90deg, #1b2027 1px, transparent 1px) 0 0 / calc(100%/4) 100%, #1b2027; }
  .judge-lane { margin-top:3px; height:16px; }
  .dot { position:absolute; top:2px; bottom:2px; width:7px; border-radius:3px; transform:translateX(-50%); }
  .dot:hover, .jtick:hover { filter:brightness(1.5); z-index:3; }
  .jtick { position:absolute; top:4px; width:8px; height:8px; transform:translateX(-50%) rotate(45deg); border-radius:1px; }
}
  table { border-collapse:collapse; margin-top:8px; } td,th { text-align:left; padding:2px 12px 2px 0; vertical-align:top; }
  th { color:#9aa4b2; font-weight:400; } .allow{color:#4ade80}.deny{color:#f87171}.defer{color:#eab308}
</style></head><body>
<h1>permission activity — ${esc(basename(logPath))}</h1>
<div class="legend">
  <i style="background:${DECISION_COLOR.approved}"></i>approved
  <i style="background:${DECISION_COLOR["session-approved"]}"></i>session-approved
  <i style="background:${DECISION_COLOR.denied}"></i>denied
  <i style="background:${DECISION_COLOR["policy-denied"]}"></i>policy-denied (blocked, never asked)
  <i style="background:${DECISION_COLOR["no-resolution"]}"></i>no resolution
  &nbsp; ring = judged; diamond on lower lane = judge call
</div>

<h2>Decisions by kind</h2><div class="grid">
<div>${bar(byDecision, "#d7dce2")}</div><div>${bar(byTool, "#2dd4bf")}</div>
</div>

<h2>Judge usage</h2>
<table>
<tr><th>verdict</th><th>calls</th></tr>
${Object.entries(judgeByVerdict).map(([k, v]) => `<tr><td class="${k.slice(0, 5)}">${esc(k)}</td><td>${v}</td></tr>`).join("")}
<tr><th>coverage</th><td>${judged.length}/${asks.length} asks (${(100 * judged.length) / Math.max(asks.length, 1)}%)</td></tr>
</table>

<h2>Judge verdict trail</h2>
<table>${judge
	.slice()
	.reverse()
	.map(
		(j) =>
			`<tr><td class="t">${fmtTime(j.timestamp)}</td><td class="${esc(j.verdict.split(" ")[0]).slice(0, 5)}">${esc(j.verdict)}</td><td class="wide">${esc(j.text ?? "")}</td><td class="m">${esc(j.model ?? "")}</td></tr>`,
	)
	.join("")}</table>

<h2>Timeline (one lane per day, dot = ask, lower diamonds = judge calls)</h2>
${dayRows}
</body></html>`;

writeFileSync(outPath, html);
console.log(`Open: file://${outPath}`);
