/**
 * Shell processes and background jobs.
 *
 * A `ShellProcess` mirrors Pi's local bash execution (dist/core/tools/bash.js and
 * dist/utils/child-process.js): same shell resolution, a detached process group on POSIX, and the
 * same stdio drain after exit. It can stop forwarding output and keep running as a job.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

export interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "stdin";
}

export interface ProcessResult {
	exitCode: number;
	signal: NodeJS.Signals | null;
	error?: Error;
}

export type JobState = "running" | "exited" | "killed";
export type JobOrigin = "timeout" | "background";

export interface Job {
	id: string;
	/** Command as the model wrote it, without the settings prefix. */
	command: string;
	cwd: string;
	pid: number | undefined;
	origin: JobOrigin;
	/** Foreground timeout that sent the command to the background, in seconds. */
	timeoutS?: number;
	startedAt: number;
	backgroundedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: NodeJS.Signals | null;
	state: JobState;
	outputPath: string;
	outputError?: string;
	killRequested: boolean;
	process: ShellProcess;
}

const EXIT_STDIO_GRACE_MS = 100;
/** Output kept in memory before a foreground command spills to its file. */
const SPILL_BYTES = 1024 * 1024;
const OUTPUT_FILE_MODE = 0o600;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function newJobId(): string {
	return `bg-${randomBytes(3).toString("hex")}`;
}

/** Signal a process group (POSIX) or tree (Windows). `alive` allows the single-pid fallback. */
export function signalProcessTree(pid: number, signal: NodeJS.Signals, alive: boolean): void {
	if (process.platform === "win32") {
		if (!alive) return;
		try {
			const killer = spawn(
				join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ stdio: "ignore", detached: true, windowsHide: true },
			);
			killer.once("error", () => {});
			killer.unref();
		} catch {
			// taskkill unavailable
		}
		return;
	}
	if (signal === "SIGKILL" && process.platform === "darwin") {
		// As Pi does: stop the group first so `a; b` cannot start b during the kill (Pi #11252).
		try {
			process.kill(-pid, "SIGSTOP");
		} catch {
			// fall through to the kill
		}
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// The group is gone. A pid is safe to signal only while Node has not reaped the child.
		if (!alive) return;
		try {
			process.kill(pid, signal);
		} catch {
			// already dead
		}
	}
}

function killProcessTreeSync(pid: number, alive: boolean): void {
	if (process.platform === "win32") {
		if (!alive) return;
		try {
			spawnSync(
				join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
				["/F", "/T", "/PID", String(pid)],
				{ stdio: "ignore", windowsHide: true },
			);
		} catch {
			// ignore
		}
		return;
	}
	signalProcessTree(pid, "SIGKILL", alive);
}

/** Output of one command: memory first, a file once it is large or the command becomes a job. */
class OutputSink {
	private chunks: Buffer[] = [];
	private buffered = 0;
	private fd: number | undefined;
	private closed = false;
	path: string | undefined;
	bytes = 0;
	error: string | undefined;

	private readonly makePath: () => string;

	constructor(makePath: () => string) {
		this.makePath = makePath;
	}

	write(chunk: Buffer): void {
		this.bytes += chunk.length;
		if (this.closed) return;
		if (this.path === undefined) {
			this.chunks.push(chunk);
			this.buffered += chunk.length;
			if (this.buffered > SPILL_BYTES) this.open();
			return;
		}
		this.writeFd(chunk);
	}

	/** Create the file (once), flush buffered output and return its path. */
	open(): string {
		if (this.path !== undefined) return this.path;
		this.path = this.makePath();
		try {
			this.fd = openSync(this.path, "wx", OUTPUT_FILE_MODE);
		} catch (error) {
			this.error = errorMessage(error);
		}
		const pending = this.chunks;
		this.chunks = [];
		this.buffered = 0;
		for (const chunk of pending) this.writeFd(chunk);
		return this.path;
	}

	private writeFd(chunk: Buffer): void {
		if (this.fd === undefined) return;
		try {
			let offset = 0;
			while (offset < chunk.length) offset += writeSync(this.fd, chunk, offset, chunk.length - offset);
		} catch (error) {
			this.error = errorMessage(error);
			this.closeFd();
		}
	}

	private closeFd(): void {
		if (this.fd === undefined) return;
		try {
			closeSync(this.fd);
		} catch {
			// ignore
		}
		this.fd = undefined;
	}

	close(): void {
		this.closed = true;
		this.closeFd();
	}

	discard(): void {
		this.close();
		this.chunks = [];
		if (this.path !== undefined) {
			try {
				unlinkSync(this.path);
			} catch {
				// ignore
			}
		}
	}
}

export interface StartOptions {
	id: string;
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	shell: ShellConfig;
	onData: (data: Buffer) => void;
	outputDir: string;
}

export class ShellProcess {
	readonly id: string;
	readonly command: string;
	readonly cwd: string;
	readonly startedAt = Date.now();
	readonly child: ChildProcess;
	/** Resolves once the shell started; rejects with the spawn error. */
	readonly spawned: Promise<void>;
	/** Resolves after exit and stdio drain. Never rejects. */
	readonly finished: Promise<ProcessResult>;
	readonly sink: OutputSink;
	result: ProcessResult | undefined;
	endedAt: number | undefined;
	exitSeen = false;
	forwardedBytes = 0;
	private forward: ((data: Buffer) => void) | undefined;

	constructor(options: StartOptions) {
		this.id = options.id;
		this.command = options.command;
		this.cwd = options.cwd;
		this.forward = options.onData;
		this.sink = new OutputSink(() =>
			join(options.outputDir, `pi-job-${options.id}-${randomBytes(4).toString("hex")}.log`),
		);
		const { shell } = options;
		const fromStdin = shell.commandTransport === "stdin";
		const child = spawn(shell.shell, fromStdin ? shell.args : [...shell.args, options.command], {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			env: options.env,
			stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		if (fromStdin) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.command);
		}
		this.spawned = new Promise<void>((resolve, reject) => {
			child.once("spawn", () => resolve());
			child.once("error", reject);
		});
		this.spawned.catch(() => {});
		this.finished = this.watch(child);
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get running(): boolean {
		return this.result === undefined;
	}

	stopForwarding(): void {
		this.forward = undefined;
	}

	signal(signal: NodeJS.Signals): void {
		const pid = this.child.pid;
		if (pid === undefined || this.result !== undefined) return;
		signalProcessTree(pid, signal, !this.exitSeen);
	}

	/** SIGKILL the group even after the leader exited, for stragglers that kept the group alive. */
	killGroup(): void {
		const pid = this.child.pid;
		if (pid === undefined) return;
		signalProcessTree(pid, "SIGKILL", !this.exitSeen);
	}

	private watch(child: ChildProcess): Promise<ProcessResult> {
		return new Promise<ProcessResult>((resolve) => {
			let settled = false;
			let exitCode: number | null = null;
			let exitSignal: NodeJS.Signals | null = null;
			let idleTimer: NodeJS.Timeout | undefined;
			let stdoutEnded = child.stdout === null;
			let stderrEnded = child.stderr === null;

			const finalize = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (idleTimer) clearTimeout(idleTimer);
				child.stdout?.removeListener("data", onData);
				child.stderr?.removeListener("data", onData);
				child.stdout?.destroy();
				child.stderr?.destroy();
				const signal = exitSignal ?? child.signalCode ?? null;
				const code =
					exitCode ?? (signal ? 128 + ((osConstants.signals as Record<string, number>)[signal] ?? 0) : 1);
				this.result = { exitCode: code, signal, error };
				this.endedAt = Date.now();
				resolve(this.result);
			};
			const armIdle = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => finalize(), EXIT_STDIO_GRACE_MS);
			};
			const maybeFinalize = () => {
				if (this.exitSeen && stdoutEnded && stderrEnded) finalize();
			};
			const onData = (chunk: Buffer) => {
				this.sink.write(chunk);
				const forward = this.forward;
				if (forward) {
					this.forwardedBytes += chunk.length;
					forward(chunk);
				}
				if (this.exitSeen && !settled) armIdle();
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			child.stdout?.once("end", () => {
				stdoutEnded = true;
				maybeFinalize();
			});
			child.stderr?.once("end", () => {
				stderrEnded = true;
				maybeFinalize();
			});
			child.once("exit", (code, signal) => {
				this.exitSeen = true;
				exitCode = code;
				exitSignal = signal;
				maybeFinalize();
				if (!settled) armIdle();
			});
			child.once("close", (code, signal) => {
				if (!this.exitSeen) {
					exitCode = code;
					exitSignal = signal;
				}
				this.exitSeen = true;
				finalize();
			});
			child.once("error", (error) => {
				// A spawn failure: no exit event follows.
				if (child.pid === undefined) {
					this.exitSeen = true;
					exitCode = 127;
					finalize(error);
				}
			});
		});
	}
}

export interface JobManagerOptions {
	onJobExit: (job: Job) => void;
	onChange?: () => void;
	outputDir?: string;
}

export class JobManager {
	private readonly live = new Set<ShellProcess>();
	private readonly jobs = new Map<string, Job>();
	private readonly outputDir: string;
	private disposed = false;
	private exitHook: (() => void) | undefined;

	private readonly options: JobManagerOptions;

	constructor(options: JobManagerOptions) {
		this.options = options;
		this.outputDir = options.outputDir ?? tmpdir();
	}

	/** Spawn a command. It runs in the foreground until `background()` adopts it. */
	start(options: Omit<StartOptions, "id" | "outputDir">): ShellProcess {
		if (this.disposed) throw new Error("The session is shutting down");
		let id = newJobId();
		while (this.jobs.has(id)) id = newJobId();
		const proc = new ShellProcess({ ...options, id, outputDir: this.outputDir });
		this.live.add(proc);
		this.installExitHook();
		void proc.finished.then(() => this.onFinished(proc));
		return proc;
	}

	/** Turn a running foreground process into a job. Callers check `proc.running` and `exitSeen`. */
	background(proc: ShellProcess, origin: JobOrigin, command: string, timeoutS?: number): Job {
		if (!proc.running) throw new Error("The command already finished");
		proc.stopForwarding();
		const outputPath = proc.sink.open();
		const job: Job = {
			id: proc.id,
			command,
			cwd: proc.cwd,
			pid: proc.pid,
			origin,
			timeoutS,
			startedAt: proc.startedAt,
			backgroundedAt: Date.now(),
			state: "running",
			outputPath,
			outputError: proc.sink.error,
			killRequested: false,
			process: proc,
		};
		this.jobs.set(job.id, job);
		this.options.onChange?.();
		return job;
	}

	get(id: string): Job | undefined {
		return this.jobs.get(id.trim());
	}

	list(): Job[] {
		return [...this.jobs.values()];
	}

	runningCount(): number {
		let count = 0;
		for (const job of this.jobs.values()) if (job.state === "running") count++;
		return count;
	}

	/** SIGTERM the job's process group, SIGKILL after `graceMs`. Resolves with the final job. */
	async kill(id: string, graceMs: number): Promise<Job> {
		const job = this.jobs.get(id.trim());
		if (!job) throw new Error(`Unknown job id: ${id}`);
		if (job.state !== "running") return job;
		job.killRequested = true;
		await terminate(job.process, graceMs);
		return job;
	}

	/** Kill every live process (jobs and foreground commands) and stop notifying. */
	async shutdown(graceMs: number): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		for (const job of this.jobs.values()) job.killRequested = true;
		await Promise.all([...this.live].map((proc) => terminate(proc, graceMs)));
		this.removeExitHook();
	}

	killAllSync(): void {
		for (const proc of this.live) {
			const pid = proc.pid;
			if (pid !== undefined && proc.running) killProcessTreeSync(pid, !proc.exitSeen);
		}
	}

	private onFinished(proc: ShellProcess): void {
		this.live.delete(proc);
		if (this.live.size === 0) this.removeExitHook();
		const job = this.jobs.get(proc.id);
		if (!job || job.process !== proc) {
			proc.sink.discard();
			return;
		}
		if (job.state !== "running") return;
		this.settleJob(job, proc);
		this.options.onChange?.();
		if (!job.killRequested && !this.disposed) this.options.onJobExit(job);
	}

	private settleJob(job: Job, proc: ShellProcess): void {
		const result = proc.result;
		if (!result) return;
		proc.sink.close();
		job.exitCode = result.exitCode;
		job.signal = result.signal;
		job.endedAt = proc.endedAt;
		job.outputError = proc.sink.error ?? (result.error ? errorMessage(result.error) : undefined);
		job.state = job.killRequested ? "killed" : "exited";
	}

	private installExitHook(): void {
		if (this.exitHook) return;
		this.exitHook = () => this.killAllSync();
		process.on("exit", this.exitHook);
	}

	private removeExitHook(): void {
		if (!this.exitHook) return;
		process.off("exit", this.exitHook);
		this.exitHook = undefined;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/** SIGTERM, wait up to `graceMs` for the drain, then SIGKILL the group and wait briefly. */
async function terminate(proc: ShellProcess, graceMs: number): Promise<void> {
	if (!proc.running) return;
	proc.signal("SIGTERM");
	const done = await Promise.race([proc.finished.then(() => true), delay(graceMs).then(() => false)]);
	proc.killGroup();
	if (!done) await Promise.race([proc.finished, delay(1000)]);
}
