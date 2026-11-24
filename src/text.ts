/** Formatting and file-reading helpers. */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateTail } from "@earendil-works/pi-coding-agent";

export function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`;
	const total = Math.round(safe / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

export function formatSeconds(seconds: number): string {
	return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** "code 0" or "code 143 (SIGTERM)". */
export function formatExit(exitCode: number | undefined, signal: string | null | undefined): string {
	const code = exitCode ?? 1;
	return signal ? `code ${code} (${signal})` : `code ${code}`;
}

/** First line of a command, shortened for one-line display. */
export function commandSummary(command: string, maxChars = 200): string {
	const trimmed = command.trim();
	const newline = trimmed.indexOf("\n");
	let line = newline === -1 ? trimmed : trimmed.slice(0, newline);
	let shortened = newline !== -1;
	if (line.length > maxChars) {
		line = line.slice(0, maxChars);
		shortened = true;
	}
	return shortened ? `${line} ...` : line;
}

/** Number of leading UTF-8 continuation bytes. */
function leadingContinuationBytes(buf: Buffer): number {
	let i = 0;
	while (i < buf.length && i < 3 && (buf[i] & 0xc0) === 0x80) i++;
	return i;
}

/** Length of `buf` without an incomplete UTF-8 sequence at its end. */
export function completeUtf8Length(buf: Buffer): number {
	const len = buf.length;
	for (let back = 1; back <= Math.min(4, len); back++) {
		const byte = buf[len - back];
		if ((byte & 0xc0) === 0x80) continue;
		let need = 1;
		if ((byte & 0xe0) === 0xc0) need = 2;
		else if ((byte & 0xf0) === 0xe0) need = 3;
		else if ((byte & 0xf8) === 0xf0) need = 4;
		return need > back ? len - back : len;
	}
	return len;
}

function readRange(path: string, start: number, length: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const n = readSync(fd, buf, read, length - read, start + read);
			if (n === 0) break;
			read += n;
		}
		return buf.subarray(0, read);
	} finally {
		closeSync(fd);
	}
}

export function fileSize(path: string): number {
	try {
		const fd = openSync(path, "r");
		try {
			return fstatSync(fd).size;
		} finally {
			closeSync(fd);
		}
	} catch {
		return 0;
	}
}

export interface TailRead {
	text: string;
	lines: number;
	size: number;
}

/** Last `maxLines` lines of a file, at most `maxBytes`, with Pi's tail truncation. */
export function readTail(path: string, maxLines: number, maxBytes: number = DEFAULT_MAX_BYTES): TailRead {
	const size = fileSize(path);
	if (size === 0) return { text: "", lines: 0, size };
	const start = Math.max(0, size - maxBytes - 1);
	let buf = readRange(path, start, size - start);
	buf = buf.subarray(0, completeUtf8Length(buf));
	let text: string;
	if (start > 0) {
		buf = buf.subarray(leadingContinuationBytes(buf));
		text = buf.toString("utf8");
		const newline = text.indexOf("\n");
		// The first line started before the read window; drop it unless it is the only one.
		if (newline !== -1 && newline < text.length - 1) text = text.slice(newline + 1);
	} else {
		text = buf.toString("utf8");
	}
	const truncation = truncateTail(text, { maxLines, maxBytes });
	return { text: truncation.content, lines: truncation.outputLines, size };
}

export interface OffsetRead {
	text: string;
	start: number;
	end: number;
	size: number;
}

/** Output from a byte offset, at most Pi's 2000 lines / 50 KB, cut at a line or UTF-8 boundary. */
export function readFromOffset(
	path: string,
	offset: number,
	maxBytes: number = DEFAULT_MAX_BYTES,
	maxLines: number = DEFAULT_MAX_LINES,
): OffsetRead {
	const size = fileSize(path);
	let start = Math.min(Math.max(0, Math.floor(offset)), size);
	if (start >= size) return { text: "", start, end: start, size };
	let buf = readRange(path, start, Math.min(maxBytes, size - start));
	const skip = leadingContinuationBytes(buf);
	start += skip;
	buf = buf.subarray(skip);
	let end = buf.length;
	let newlines = 0;
	for (let i = 0; i < buf.length; i++) {
		if (buf[i] === 0x0a && ++newlines === maxLines) {
			end = i + 1;
			break;
		}
	}
	if (end === buf.length && start + end < size) {
		const lastNewline = buf.lastIndexOf(0x0a, end - 1);
		if (lastNewline !== -1) end = lastNewline + 1;
	}
	end = completeUtf8Length(buf.subarray(0, end));
	return { text: buf.subarray(0, end).toString("utf8"), start, end: start + end, size };
}
