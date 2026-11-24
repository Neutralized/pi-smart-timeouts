/** A mock of the parts of Pi's ExtensionAPI the extension uses. */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSmartTimeouts } from "../src/index.ts";

export interface SentMessage {
	message: { customType: string; content: string; display: boolean; details: Record<string, unknown> };
	options: { triggerTurn?: boolean; deliverAs?: string } | undefined;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

export type AnyTool = { name: string; description: string; parameters: any; promptGuidelines?: string[]; promptSnippet?: string; outputSchema?: any; execute: (...args: any[]) => Promise<any> };

export interface Harness {
	dir: string;
	tools: Map<string, AnyTool>;
	messages: SentMessage[];
	notifications: string[];
	ctx: Record<string, unknown>;
	/** What ctx.isIdle() returns. */
	idle: boolean;
	tool(name: string): AnyTool;
	bash(params: Record<string, unknown>, signal?: AbortSignal): Promise<any>;
	call(name: string, params: Record<string, unknown>): Promise<any>;
	emit(event: string, payload: Record<string, unknown>): Promise<void>;
	/** Run the handlers of one event and return the last result. */
	runHandler(event: string, payload: Record<string, unknown>): Promise<unknown>;
	waitForMessage(predicate: (m: SentMessage) => boolean, timeoutMs?: number): Promise<SentMessage>;
	close(): Promise<void>;
}

export interface HarnessOptions {
	env?: Record<string, string | undefined>;
	flags?: Record<string, string | boolean>;
	settings?: Record<string, unknown>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), "pi-smart-timeouts-test-"));
	const tools = new Map<string, AnyTool>();
	const handlers = new Map<string, Handler[]>();
	const messages: SentMessage[] = [];
	const notifications: string[] = [];
	const waiters: Array<{ predicate: (m: SentMessage) => boolean; resolve: (m: SentMessage) => void }> = [];
	const flags = options.flags ?? {};
	const registeredFlags = new Set<string>();

	const pi = {
		registerFlag(name: string) {
			registeredFlags.add(name);
		},
		getFlag(name: string) {
			return registeredFlags.has(name) ? flags[name] : undefined;
		},
		registerTool(tool: AnyTool) {
			tools.set(tool.name, tool);
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		sendMessage(message: SentMessage["message"], sendOptions: SentMessage["options"]) {
			const sent = { message, options: sendOptions };
			messages.push(sent);
			for (const waiter of [...waiters]) {
				if (waiter.predicate(sent)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(sent);
				}
			}
		},
		getSettings() {
			return options.settings ?? {};
		},
	};

	const ui = {
		notify: (message: string) => notifications.push(message),
		setStatus: () => {},
	};
	const state = { idle: true };
	const ctx: Record<string, unknown> = {
		cwd: dir,
		hasUI: false,
		isIdle: () => state.idle,
		ui,
		sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
		model: undefined,
		thinkingLevel: undefined,
	};

	createSmartTimeouts({ outputDir: dir, env: options.env ?? {} })(pi as never);

	const emit = async (event: string, payload: Record<string, unknown>) => {
		for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
	};
	await emit("session_start", { reason: "startup" });

	const tool = (name: string) => {
		const found = tools.get(name);
		if (!found) throw new Error(`tool ${name} not registered`);
		return found;
	};
	let closed = false;
	return {
		get idle() {
			return state.idle;
		},
		set idle(value: boolean) {
			state.idle = value;
		},
		dir,
		tools,
		messages,
		notifications,
		ctx,
		tool,
		bash: (params, signal) => tool("bash").execute("call-1", params, signal, undefined, ctx),
		call: (name, params) => tool(name).execute("call-1", params, undefined, undefined, ctx),
		emit,
		async runHandler(event, payload) {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
			return result;
		},
		waitForMessage(predicate, timeoutMs = 10_000) {
			const existing = messages.find(predicate);
			if (existing) return Promise.resolve(existing);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timed out waiting for a message")), timeoutMs);
				waiters.push({
					predicate,
					resolve: (m) => {
						clearTimeout(timer);
						resolve(m);
					},
				});
			});
		},
		async close() {
			if (closed) return;
			closed = true;
			await emit("session_shutdown", { reason: "quit" });
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("");
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	return condition();
}

/** Kill an explicit test PID if it is still alive. */
export function killPid(pid: number | undefined): void {
	if (pid === undefined || !isAlive(pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// gone
	}
}
