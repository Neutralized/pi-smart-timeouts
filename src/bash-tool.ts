/**
 * The `bash` override. Pi's own bash definition keeps output handling, truncation, streaming and
 * the result shape; only process execution is replaced so a timeout moves the command to a job.
 */

import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type BashOperations,
	createBashToolDefinition,
	type ExtensionAPI,
	getShellConfig,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveCallTimeout, type SmartTimeoutsConfig } from "./config.ts";
import type { Job, JobManager, JobOrigin } from "./jobs.ts";
import { formatSeconds } from "./text.ts";

const PI_TIMEOUT_SENTENCE = "Optionally provide a timeout in seconds.";

export const BASH_GUIDELINES = [
	"Set run_in_background on bash for servers, watchers and other commands that run until stopped.",
	"End your turn to wait for a background job.",
	"Kill a background job with job_kill as soon as you no longer need its result.",
];

export const STILL_RUNNING_SENTENCE = "The job keeps running, and a message arrives when it exits.";

export interface BashToolDeps {
	pi: ExtensionAPI;
	cwd: string;
	getConfig: () => SmartTimeoutsConfig;
	getManager: () => JobManager;
}

interface CallState {
	job?: Job;
	forwardedBytes: number;
}

/** Retry delay when the timeout hits a shell that exited while its process group still writes. */
const DRAIN_RETRY_MS = 250;

function timeoutSentence(config: SmartTimeoutsConfig): string {
	return [
		`Optionally provide a timeout in seconds (default ${config.defaultTimeoutS}, maximum ${config.maxTimeoutS}).`,
		"A command still running at its timeout continues as a background job.",
		"Set run_in_background to start the command as a background job at once.",
		"A message arrives when a background job exits.",
	].join(" ");
}

export function bashDescription(baseDescription: string, config: SmartTimeoutsConfig): string {
	const sentence = timeoutSentence(config);
	return baseDescription.includes(PI_TIMEOUT_SENTENCE)
		? baseDescription.replace(PI_TIMEOUT_SENTENCE, sentence)
		: `${baseDescription.trimEnd()} ${sentence}`;
}

function normalizeShellPath(path: string): string {
	let normalized = path;
	if (process.platform === "win32") {
		const match = normalized.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
		if (match && !normalized.startsWith("//") && !normalized.includes("\\")) {
			normalized = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
		}
	}
	if (normalized === "~") return homedir();
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return join(homedir(), normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
	return normalized;
}

/** The two settings Pi applies to its own bash tool (dist/core/agent-session.js:2983-2992). */
function readShellSettings(pi: ExtensionAPI): { shellPath?: string; commandPrefix?: string } {
	try {
		const settings = pi.getSettings() as { shellPath?: string; shellCommandPrefix?: string };
		return {
			shellPath: settings.shellPath ? normalizeShellPath(settings.shellPath) : undefined,
			commandPrefix: settings.shellCommandPrefix || undefined,
		};
	} catch {
		return {};
	}
}

function createOperations(options: {
	manager: JobManager;
	config: SmartTimeoutsConfig;
	shellPath: string | undefined;
	background: boolean;
	command: string;
	state: CallState;
}): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, env, timeout }) => {
			// Validated here, where Pi's own operations validate it, so errors surface the same way.
			const timeoutS = options.background ? undefined : resolveCallTimeout(timeout, options.config);
			if (signal?.aborted) throw new Error("aborted");
			const shell = getShellConfig(options.shellPath);
			try {
				await access(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			const proc = options.manager.start({ command, cwd, env: env ?? process.env, shell, onData });
			await proc.spawned;
			return new Promise<{ exitCode: number | null }>((resolve, reject) => {
				let settled = false;
				let timer: NodeJS.Timeout | undefined;
				const onAbort = () => proc.signal("SIGKILL");
				const cleanup = () => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
				};
				const toBackground = (origin: JobOrigin, draining = false) => {
					if (settled || !proc.running || signal?.aborted) return;
					// The shell exited and its output is draining: give the drain a moment. A process
					// group that keeps writing after that becomes a job like any other command.
					if (proc.exitSeen && !draining) {
						timer = setTimeout(() => toBackground(origin, true), DRAIN_RETRY_MS);
						return;
					}
					settled = true;
					cleanup();
					options.state.job = options.manager.background(proc, origin, options.command, timeoutS);
					options.state.forwardedBytes = proc.forwardedBytes;
					resolve({ exitCode: 0 });
				};
				void proc.finished.then((result) => {
					if (settled) return;
					settled = true;
					cleanup();
					if (signal?.aborted) reject(new Error("aborted"));
					else if (result.error) reject(result.error);
					else resolve({ exitCode: result.exitCode });
				});
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				if (options.background) toBackground("background");
				else timer = setTimeout(() => toBackground("timeout"), (timeoutS ?? 0) * 1000);
			});
		},
	};
}

export function backgroundNotice(job: Job): string {
	const lines =
		job.origin === "timeout" && job.timeoutS !== undefined
			? [
					`Command still running after ${formatSeconds(job.timeoutS)}. It continues as background job ${job.id}.`,
				]
			: [`Command started as background job ${job.id}.`];
	lines.push(`Job output file: ${job.outputPath}`);
	if (job.outputError) lines.push(`Job output file error: ${job.outputError}`);
	lines.push(STILL_RUNNING_SENTENCE);
	return lines.join("\n");
}

type BashResult = Awaited<ReturnType<ReturnType<typeof createBashToolDefinition>["execute"]>>;

function toBackgroundResult(result: BashResult, job: Job, forwardedBytes: number): BashResult {
	const first = result.content.find((part) => part.type === "text");
	const text = first && first.type === "text" ? first.text : "";
	const notice = backgroundNotice(job);
	const body = forwardedBytes > 0 && text ? `${text}\n\n${notice}` : notice;
	const structuredContent = result.structuredContent
		? {
				...(result.structuredContent as Record<string, unknown>),
				exit_code: -1,
				job_id: job.id,
				job_output_path: job.outputPath,
			}
		: undefined;
	return { ...result, content: [{ type: "text", text: body }], structuredContent };
}

export function createSmartBashTool(deps: BashToolDeps) {
	const base = createBashToolDefinition(deps.cwd);
	const config = deps.getConfig();
	const baseOutput = base.outputSchema as { properties?: Record<string, unknown> } | undefined;
	const parameters = Type.Object({
		command: base.parameters.properties.command,
		timeout: Type.Optional(
			Type.Number({
				description: `Timeout in seconds (default ${config.defaultTimeoutS}, maximum ${config.maxTimeoutS})`,
			}),
		),
		run_in_background: Type.Optional(
			Type.Boolean({ description: "Start the command as a background job and return at once" }),
		),
	});
	const outputSchema = Type.Object({
		...((baseOutput?.properties ?? {}) as Record<string, never>),
		exit_code: Type.Number({ description: "Exit code; -1 while the command runs as a background job" }),
		job_id: Type.Optional(Type.String({ description: "Background job id" })),
		job_output_path: Type.Optional(Type.String({ description: "File that receives the background job's output" })),
	});

	return {
		name: "bash",
		label: base.label,
		description: bashDescription(base.description, config),
		promptSnippet: base.promptSnippet,
		promptGuidelines: [...(base.promptGuidelines ?? []), ...BASH_GUIDELINES],
		parameters,
		outputSchema,
		constrainedSampling: base.constrainedSampling,
		async execute(
			toolCallId: string,
			params: { command: string; timeout?: number; run_in_background?: boolean },
			signal: AbortSignal | undefined,
			onUpdate: Parameters<typeof base.execute>[3],
			ctx: Parameters<typeof base.execute>[4],
		): Promise<BashResult> {
			const background = params.run_in_background === true;
			const settings = readShellSettings(deps.pi);
			const state: CallState = { forwardedBytes: 0 };
			const inner = createBashToolDefinition(ctx?.cwd || deps.cwd, {
				commandPrefix: settings.commandPrefix,
				operations: createOperations({
					manager: deps.getManager(),
					config: deps.getConfig(),
					shellPath: settings.shellPath,
					background,
					command: params.command,
					state,
				}),
			});
			const result = await inner.execute(
				toolCallId,
				{ command: params.command, timeout: params.timeout },
				signal,
				onUpdate,
				ctx,
			);
			return state.job ? toBackgroundResult(result, state.job, state.forwardedBytes) : result;
		},
	};
}
