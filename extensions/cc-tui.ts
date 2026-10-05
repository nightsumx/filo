import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";

const userMessage = UserMessageComponent.prototype;
const rebuild = userMessage.rebuild;
userMessage.rebuild = function () {
	rebuild.call(this);
	for (const child of this.children) child.paddingY = 0;
};

const editor = Editor.prototype;
const render = editor.render;
editor.render = function (width: number) {
	const lines = render.call(this, width - 2);
	const bottom = this.renderedVisibleLineCount + 1;
	return lines.map((line: string, i: number) =>
		i === 0 || i === bottom ? line + this.borderColor("──") : (i === 1 ? "❯ " : "  ") + line,
	);
};
const handleMouse = editor.handleMouse;
editor.handleMouse = function (event: { x: number; width: number }) {
	return handleMouse.call(this, { ...event, x: event.x - 2, width: event.width - 2 });
};

export default function () {}
