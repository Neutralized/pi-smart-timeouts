/**
 * Smoke tests without a real model: a scripted faux provider named `smoke`.
 * Run through test/smoke/run.mjs; SMOKE_SCENARIO selects the script.
 *
 * busy (pi -p): a bash call outlives an explicit 1 s timeout; during the next foreground call
 *   the job exits and its message is steered in before the third model call.
 * idle (pi --mode rpc): a background job exits after the run settled; its message starts a run.
 *   A second prompt starts `sleep 300` in the background for the shutdown check.
 */

import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type AnyMessage = { role: string; content?: unknown };

function textOf(message: AnyMessage): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

function report(label: string) {
	return (context: { messages: unknown[] }) => {
		const messages = context.messages as AnyMessage[];
		const toolResults = messages.filter((m) => m.role === "toolResult").map(textOf);
		const exitMessages = messages.filter((m) => m.role === "user" && textOf(m).startsWith("Background job ")).map(textOf);
		const order = messages.map((m) => m.role).filter((role) => role !== "system");
		return fauxAssistantMessage(fauxText(`${label} ${JSON.stringify({ toolResults, exitMessages, order })}`));
	};
}

const bash = (args: Record<string, unknown>) => () =>
	fauxAssistantMessage(fauxToolCall("bash", args), { stopReason: "toolUse" });

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ provider: "smoke", models: [{ id: "smoke-1", name: "Smoke" }], tokensPerSecond: 100000 });
	if (process.env.SMOKE_SCENARIO === "idle") {
		faux.setResponses([
			bash({ command: "sleep 1; echo idle-done", run_in_background: true }),
			() => fauxAssistantMessage(fauxText("WAITING")),
			report("SMOKE-IDLE"),
			bash({ command: "echo pid=$$; exec sleep 300", run_in_background: true }),
			() => fauxAssistantMessage(fauxText("STARTED")),
		]);
	} else {
		faux.setResponses([
			bash({ command: "echo first; sleep 2; echo second", timeout: 1 }),
			bash({ command: "sleep 3; echo waited" }),
			report("SMOKE-BUSY"),
		]);
	}
	pi.registerProvider(faux.provider);
}
