export function findCodes(text) {
	const found = [];
	for (const line of text.split(/\n+/)) {
		const near = /code|otp|pin|verif|confirm|one[- ]time|passcode|token|security/i.test(line);
		for (const [word] of line.matchAll(/\b(?:\d{3}[- ]\d{3}|\d{4,8}|(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{5,10})\b/g)) {
			if (!near && /^\d{4}$/.test(word)) continue;
			if (/^(19|20)\d\d$/.test(word)) continue;
			found.push({ word, near });
		}
	}
	return [...new Set(found.sort((a, b) => b.near - a.near).map((f) => f.word))].slice(0, 8);
}

export function findLinks(text, html) {
	const hrefs = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
	const bare = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
	return [...new Set([...hrefs, ...bare])].slice(0, 40);
}

export const plain = (html) => html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n\s*\n+/g, "\n\n").trim();
