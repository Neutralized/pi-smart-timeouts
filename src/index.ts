/**
 * pi-smart-timeouts: Pi's bash tool with Claude Code style long-command handling.
 *
 * A command that outlives its timeout keeps running as a background job instead of being killed.
 * When a job exits, a message enters the conversation and starts a turn if Pi is idle.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSmartBashTool } from "./bash-tool.ts";
import {
	ENV_DEFAULT_TIMEOUT,
	ENV_MAX_TIMEOUT,
	FLAG_DEFAULT_TIMEOUT,
	FLAG_MAX_TIMEOUT,
	resolveConfig,
	type SmartTimeoutsConfig,
} from "./config.ts";
import { createJobKillTool, createJobOutputTool, createJobStatusTool, exitMessage } from "./job-tools.ts";
import { type Job, JobManager } from "./jobs.ts";

export const CUSTOM_TYPE = "pi-smart-timeouts";
const STATUS_KEY = "pi-smart-timeouts";
const SHUTDOWN_GRACE_MS = 500;
const COMPACTION_POLL_MS = 250;

interface ExitNotice {
	customType: string;
	content: string;
	display: boolean;
	details: {
		jobId: string;
		command: string;
		exitCode: number | undefined;
		signal: string | null | undefined;
		durationMs: number;
		outputPath: string;
	};
}

export interface SmartTimeoutsOptions {
	/** Directory for job output files. Default: the OS temp directory. */
	outputDir?: string;
	/** Environment to read the settings from. Default: process.env. */
	env?: Record<string, string | undefined>;
}

export function createSmartTimeouts(options: SmartTimeoutsOptions = {}) {
	return function smartTimeouts(pi: ExtensionAPI): void {
		pi.registerFlag(FLAG_DEFAULT_TIMEOUT, {
			description: `Seconds before a bash command becomes a background job (default 120, env ${ENV_DEFAULT_TIMEOUT})`,
			type: "string",
		});
		pi.registerFlag(FLAG_MAX_TIMEOUT, {
			description: `Maximum bash timeout in seconds (default 600, env ${ENV_MAX_TIMEOUT})`,
			type: "string",
		});

		const env = options.env ?? process.env;
		let config: SmartTimeoutsConfig = resolveConfig(env);
		let manager: JobManager | undefined;
		let disposed = false;
		let uiContext: ExtensionContext | undefined;
		/** Exit notices sent but not yet seen in a message_end event; `steered` = sent while busy. */
		const undelivered = new Map<string, { notice: ExitNotice; steered: boolean }>();
		/** Notices held back while a compaction runs, which must not overlap a new run. */
		const held: ExitNotice[] = [];
		let compacting = false;
		let pollTimer: NodeJS.Timeout | undefined;

		const isIdle = () => {
			try {
				return uiContext ? uiContext.isIdle() : true;
			} catch {
				return true;
			}
		};

		const updateStatus = () => {
			if (!uiContext?.hasUI) return;
			const running = manager?.runningCount() ?? 0;
			try {
				uiContext.ui.setStatus(
					STATUS_KEY,
					running > 0 ? `${running} background job${running === 1 ? "" : "s"}` : undefined,
				);
			} catch {
				// stale context
			}
		};

		const onJobExit = (job: Job) => {
			if (disposed) return;
			const notice: ExitNotice = {
				customType: CUSTOM_TYPE,
				content: exitMessage(job),
				display: true,
				details: {
					jobId: job.id,
					command: job.command,
					exitCode: job.exitCode,
					signal: job.signal,
					durationMs: (job.endedAt ?? Date.now()) - job.startedAt,
					outputPath: job.outputPath,
				},
			};
			deliver(notice);
		};

		const send = (notice: ExitNotice) => {
			undelivered.set(notice.details.jobId, { notice, steered: !isIdle() });
			try {
				pi.sendMessage(notice, { triggerTurn: true, deliverAs: "steer" });
			} catch {
				undelivered.delete(notice.details.jobId);
			}
		};

		const flushHeld = () => {
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
			if (disposed) return;
			for (const notice of held.splice(0)) send(notice);
		};

		const deliver = (notice: ExitNotice) => {
			if (!compacting) {
				send(notice);
				return;
			}
			held.push(notice);
			// Compaction ends with session_compact or session_compact_failed; isIdle() is the fallback.
			pollTimer ??= setInterval(() => {
				if (!compacting || isIdle()) {
					compacting = false;
					flushHeld();
				}
			}, COMPACTION_POLL_MS);
			pollTimer.unref?.();
		};

		const getManager = () => {
			if (disposed) throw new Error("The session is shutting down");
			manager ??= new JobManager({ onJobExit, onChange: updateStatus, outputDir: options.outputDir });
			return manager;
		};

		const registerBash = () => {
			pi.registerTool(createSmartBashTool({ pi, cwd: process.cwd(), getConfig: () => config, getManager }));
		};

		registerBash();
		const jobDeps = { findManager: () => manager };
		pi.registerTool(createJobOutputTool(jobDeps));
		pi.registerTool(createJobStatusTool(jobDeps));
		pi.registerTool(createJobKillTool(jobDeps));

		pi.on("session_start", async (_event, ctx) => {
			uiContext = ctx;
			const next = resolveConfig(env, {
				defaultTimeout: pi.getFlag(FLAG_DEFAULT_TIMEOUT) as string | boolean | undefined,
				maxTimeout: pi.getFlag(FLAG_MAX_TIMEOUT) as string | boolean | undefined,
			});
			const changed =
				next.defaultTimeoutS !== config.defaultTimeoutS || next.maxTimeoutS !== config.maxTimeoutS;
			config = next;
			if (changed) registerBash();
			for (const warning of next.warnings) {
				if (ctx.hasUI) ctx.ui.notify(`pi-smart-timeouts: ${warning}`, "warning");
				else process.stderr.write(`pi-smart-timeouts: ${warning}\n`);
			}
		});

		pi.on("message_end", async (event) => {
			const message = event.message as { role?: string; customType?: string; details?: { jobId?: string } };
			if (message.role === "custom" && message.customType === CUSTOM_TYPE && message.details?.jobId) {
				undelivered.delete(message.details.jobId);
			}
		});

		// Escape in the TUI clears queued messages. Park steered, undelivered notices for the next
		// prompt; the context handler drops the copy if the queue kept the original.
		pi.on("agent_settled", async (event) => {
			if (!event.aborted || disposed) return;
			for (const [jobId, entry] of [...undelivered]) {
				if (!entry.steered) continue;
				undelivered.delete(jobId);
				try {
					pi.sendMessage(entry.notice, { deliverAs: "nextTurn" });
				} catch {
					// session gone
				}
			}
		});

		// One exit message per job reaches the model.
		pi.on("context", async (event) => {
			const seen = new Set<string>();
			let dropped = false;
			const messages = event.messages.filter((m) => {
				const message = m as { role?: string; customType?: string; details?: { jobId?: string } };
				const jobId = message.role === "custom" && message.customType === CUSTOM_TYPE ? message.details?.jobId : undefined;
				if (!jobId) return true;
				if (seen.has(jobId)) {
					dropped = true;
					return false;
				}
				seen.add(jobId);
				return true;
			});
			return dropped ? { messages } : undefined;
		});

		pi.on("session_before_compact", async () => {
			compacting = true;
		});
		pi.on("session_compact", async () => {
			compacting = false;
			flushHeld();
		});
		pi.on("session_compact_failed", async () => {
			compacting = false;
			flushHeld();
		});

		pi.on("session_shutdown", async () => {
			if (disposed) return;
			disposed = true;
			undelivered.clear();
			held.length = 0;
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = undefined;
			const current = manager;
			await current?.shutdown(SHUTDOWN_GRACE_MS);
			if (uiContext?.hasUI) {
				try {
					uiContext.ui.setStatus(STATUS_KEY, undefined);
				} catch {
					// stale context
				}
			}
			uiContext = undefined;
		});
	};
}

export default createSmartTimeouts();
