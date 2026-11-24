/** Tools for background jobs: job_output, job_status, job_kill. */

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Job, JobManager } from "./jobs.ts";
import { commandSummary, fileSize, formatDuration, formatExit, readFromOffset, readTail } from "./text.ts";

export const KILL_GRACE_MS = 2000;
export const EXIT_TAIL_LINES = 20;
export const EXIT_TAIL_BYTES = 4096;
const DEFAULT_OUTPUT_LINES = 100;

export interface JobToolDeps {
	/** The session's job manager, or undefined before the first command. */
	findManager: () => JobManager | undefined;
}

function runTime(job: Job): string {
	return formatDuration((job.endedAt ?? Date.now()) - job.startedAt);
}

/** "running for 2m 3s", "exited with code 0 after 3.1s", "killed with code 143 (SIGTERM) after 12s". */
export function jobState(job: Job): string {
	if (job.state === "running") return `running for ${runTime(job)}`;
	const verb = job.state === "killed" ? "killed" : "exited";
	return `${verb} with ${formatExit(job.exitCode, job.signal)} after ${runTime(job)}`;
}

function outputFileLine(job: Job): string {
	const line = `Job output file: ${job.outputPath} (${formatSize(fileSize(job.outputPath))})`;
	return job.outputError ? `${line}\nJob output file error: ${job.outputError}` : line;
}

function tailBlock(job: Job, maxLines: number, maxBytes: number): string {
	const tail = readTail(job.outputPath, maxLines, maxBytes);
	if (!tail.text) return "Output: (no output)";
	return `Last ${tail.lines === 1 ? "line" : `${tail.lines} lines`}:\n${tail.text.replace(/\n$/, "")}`;
}

/** The message sent to the conversation when a job exits. */
export function exitMessage(job: Job): string {
	return [
		`Background job ${job.id} ${jobState(job)}.`,
		`Command: ${commandSummary(job.command)}`,
		outputFileLine(job),
		tailBlock(job, EXIT_TAIL_LINES, EXIT_TAIL_BYTES),
	].join("\n");
}

function statusBlock(job: Job): string {
	return [
		`Job ${job.id}: ${jobState(job)}.`,
		`Command: ${commandSummary(job.command)}`,
		`PID: ${job.pid ?? "unknown"}`,
		outputFileLine(job),
	].join("\n");
}

function requireJob(deps: JobToolDeps, id: string): Job {
	const manager = deps.findManager();
	const job = manager?.get(id);
	if (job) return job;
	const known = manager?.list().map((j) => j.id) ?? [];
	throw new Error(
		known.length > 0
			? `Unknown job id: ${id}. Known job ids: ${known.join(", ")}.`
			: `Unknown job id: ${id}. No background jobs exist.`,
	);
}

function text(value: string) {
	return [{ type: "text" as const, text: value }];
}

export function createJobOutputTool(deps: JobToolDeps) {
	return {
		name: "job_output",
		label: "job output",
		description: `Read the output of a background job. Returns the last lines by default. Set offset to read from a byte offset instead. Output is capped at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Each result states the next offset.`,
		promptSnippet: "Read the output of a background bash job",
		parameters: Type.Object({
			job_id: Type.String({ description: "Background job id" }),
			lines: Type.Optional(
				Type.Integer({ minimum: 1, description: `Number of last lines to return (default ${DEFAULT_OUTPUT_LINES})` }),
			),
			offset: Type.Optional(Type.Integer({ minimum: 0, description: "Byte offset to read from" })),
		}),
		async execute(_toolCallId: string, params: { job_id: string; lines?: number; offset?: number }) {
			const job = requireJob(deps, params.job_id);
			const state = `Job ${job.id} ${jobState(job).replace(/^running/, "is running")}.`;
			if (params.offset !== undefined) {
				const read = readFromOffset(job.outputPath, params.offset);
				const footer = `[${state} Showing bytes ${read.start}-${read.end} of ${read.size}. Next offset: ${read.end}.]`;
				return {
					content: text(`${read.text.replace(/\n$/, "") || "(no output)"}\n\n${footer}`),
					details: { jobId: job.id, state: job.state, start: read.start, end: read.end, size: read.size },
				};
			}
			const lines = Math.min(Math.max(1, Math.floor(params.lines ?? DEFAULT_OUTPUT_LINES)), DEFAULT_MAX_LINES);
			const tail = readTail(job.outputPath, lines);
			const shown = tail.lines === 1 ? "the last line" : `the last ${tail.lines} lines`;
			const footer = `[${state} Showing ${shown}. Output size: ${formatSize(tail.size)}. Next offset: ${tail.size}.]`;
			return {
				content: text(`${tail.text.replace(/\n$/, "") || "(no output)"}\n\n${footer}`),
				details: { jobId: job.id, state: job.state, start: undefined, end: tail.size, size: tail.size },
			};
		},
	};
}

export function createJobStatusTool(deps: JobToolDeps) {
	return {
		name: "job_status",
		label: "job status",
		description: "Show the state, exit code, run time and output file of background jobs.",
		promptSnippet: "Show the state of background bash jobs",
		parameters: Type.Object({
			job_id: Type.Optional(Type.String({ description: "Background job id. Omit it to list all jobs." })),
		}),
		async execute(_toolCallId: string, params: { job_id?: string }) {
			const jobs = params.job_id ? [requireJob(deps, params.job_id)] : (deps.findManager()?.list() ?? []);
			const body = jobs.length > 0 ? jobs.map(statusBlock).join("\n\n") : "No background jobs.";
			return {
				content: text(body),
				details: { jobs: jobs.map((job) => ({ id: job.id, state: job.state, exitCode: job.exitCode })) },
			};
		},
	};
}

export function createJobKillTool(deps: JobToolDeps) {
	return {
		name: "job_kill",
		label: "job kill",
		description: "Kill a background job and its process tree.",
		promptSnippet: "Kill a background bash job",
		parameters: Type.Object({
			job_id: Type.String({ description: "Background job id" }),
		}),
		async execute(_toolCallId: string, params: { job_id: string }) {
			const job = requireJob(deps, params.job_id);
			const wasRunning = job.state === "running";
			const manager = deps.findManager();
			if (wasRunning && manager) await manager.kill(job.id, KILL_GRACE_MS);
			const first = wasRunning ? `Job ${job.id}: ${jobState(job)}.` : `Job ${job.id} already ${jobState(job)}.`;
			return {
				content: text([first, outputFileLine(job), tailBlock(job, EXIT_TAIL_LINES, EXIT_TAIL_BYTES)].join("\n")),
				details: { jobId: job.id, state: job.state, exitCode: job.exitCode },
			};
		},
	};
}
