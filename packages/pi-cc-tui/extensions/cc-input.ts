import { readFileSync } from "node:fs";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Editor, matchesKey, SelectList, stripTerminalSequences } from "@earendil-works/pi-tui";
import { COLOR, fg, shared } from "./lib/shared.ts";

// pi saves pasted clipboard images as <tmpdir>/pi-clipboard-<uuid>.<ext> and inserts that path.
const CLIPBOARD_IMAGE = /(?:[A-Za-z]:)?[\\/][^\s"']*pi-clipboard-[0-9a-f-]{36}\.(png|jpe?g|gif|webp|bmp)/gi;
const isClipboardImage = (text: string) => new RegExp(`^${CLIPBOARD_IMAGE.source}$`, "i").test(text);
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

// Store a pasted image path like a large paste: the editor shows an atomic "[paste #N]" marker
// (drawn as "[Image #k]" below) and expands it back to the path on submit.
const editor = Editor.prototype as any;
const insertTextAtCursor = editor.insertTextAtCursor;
editor.insertTextAtCursor = function (text: string) {
	if (typeof text === "string" && isClipboardImage(text) && this.pastes instanceof Map && typeof this.pasteCounter === "number") {
		const id = ++this.pasteCounter;
		this.pastes.set(id, text);
		return insertTextAtCursor.call(this, `[paste #${id}]`);
	}
	return insertTextAtCursor.call(this, text);
};

const render = editor.render;
editor.render = function (width: number) {
	let lines: string[] = render.call(this, width);

	// "[paste #12]" -> "[Image #1]  ", padded to the same width so the layout doesn't move.
	if (this.pastes instanceof Map && this.pastes.size) {
		let n = 0;
		for (const [id, value] of this.pastes) {
			if (typeof value !== "string" || !isClipboardImage(value)) continue;
			const marker = `[paste #${id}]`;
			const label = `[Image #${++n}]`;
			const replacement = label + " ".repeat(Math.max(0, marker.length - label.length));
			lines = lines.map((line) => line.split(marker).join(replacement));
		}
	}

	// Bash mode: "! ls" with a pink "!" prompt instead of "❯ !ls".
	if (this instanceof CustomEditor && this.scrollOffset === 0 && this.getText().trimStart().startsWith("!") && lines[1]?.startsWith("❯ ")) {
		const rest = lines[1].slice(2);
		const stripped = rest.replace(/^(\s*)!/, "$1");
		if (stripped !== rest) lines[1] = `${fg(COLOR.bash, "!")} ${stripped} `;
	}
	return lines;
};

// Slash-command menu: no arrow, the selected row in Claude Code's suggestion color.
const createAutocompleteList = editor.createAutocompleteList;
editor.createAutocompleteList = function (...args: unknown[]) {
	const list = createAutocompleteList.apply(this, args);
	if (list) list.ccSuggestions = true;
	return list;
};
const selectList = SelectList.prototype as any;
const renderItem = selectList.renderItem;
selectList.renderItem = function (item: unknown, isSelected: boolean, ...rest: unknown[]) {
	if (!this.ccSuggestions) {
		const line: string = renderItem.call(this, item, isSelected, ...rest);
		return isSelected ? line.replace("→ ", "❯ ") : line;
	}
	const line: string = renderItem.call(this, item, false, ...rest);
	return isSelected ? fg(COLOR.suggestion, stripTerminalSequences(line)) : line;
};

// "?" on an empty prompt toggles the shortcuts panel drawn by the status line.
const custom = CustomEditor.prototype as any;
const handleInput = custom.handleInput;
custom.handleInput = function (data: string) {
	const key = decodeKittyPrintable(data) ?? data;
	if (shared.showShortcuts) {
		shared.showShortcuts = false;
		this.tui?.requestRender?.();
		if (key === "?" || matchesKey(data, "escape")) return;
	} else if (key === "?" && !this.getText() && !this.autocompleteState) {
		shared.showShortcuts = true;
		this.tui?.requestRender?.();
		return;
	}
	return handleInput.call(this, data);
};

export default function (pi: ExtensionAPI) {
	// Send pasted clipboard images as image attachments, like Claude Code, and leave "[Image #k]" in the text.
	pi.on("input", (event, ctx) => {
		if (!ctx.model?.input?.includes("image")) return { action: "continue" };
		const images = [...(event.images ?? [])];
		let n = 0;
		const text = event.text.replace(CLIPBOARD_IMAGE, (path, ext: string) => {
			try {
				images.push({ type: "image", data: readFileSync(path).toString("base64"), mimeType: MIME[ext.toLowerCase()] ?? "image/png" });
				return `[Image #${++n}]`;
			} catch {
				return path;
			}
		});
		return n ? { action: "transform", text, images } : { action: "continue" };
	});
}
