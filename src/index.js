#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { readConfig, setup } from "./setup.js";

const VERSION = "1.0.0";
const MAX_FILES = 10;
const MAX_ATTACHED = 3.5 * 1024 * 1024;

if (process.argv[2] === "setup") {
	await setup(process.argv.slice(3));
	process.exit(0);
}

const INSTRUCTIONS = `BYOD is the person's own mail on their own domain, through a Cloudflare Worker they own. Nothing passes through anyone else.
- mailbox_create makes an address on their domain (a name, or a random one; hours makes it expire). Mail to an address that is not a mailbox is refused.
- For a signup or a login code: create the mailbox, type its address on the page, then mailbox_read with wait (up to 25 s) and after the last id you saw. Each message comes with its codes and links already picked out.
- mailbox_send always sends from one of their mailboxes. reply_to a message id threads the reply and fills in to and the subject.
- Attachments are files on this computer: pass their paths. mailbox_save writes a received file to disk and answers its path.
- Before you send, check the recipients, subject and body against what they asked.`;

const MIME = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html", zip: "application/zip", ics: "text/calendar", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
const ADDRESS = { type: "string", description: "A mailbox address, e.g. signup@yourdomain.xyz" };

const TOOLS = [
	{ name: "mailbox_list", description: "Your domains and mailboxes, with how many messages each holds and the id of the newest.", inputSchema: { type: "object", properties: {} } },
	{ name: "mailbox_create", description: "Create a mailbox on your domain. name is the part before @ (random when left out), or a full address on another of your domains. hours makes it expire; without it the mailbox is kept. Creating one that exists answers it as it is.", inputSchema: { type: "object", properties: { name: { type: "string" }, domain: { type: "string" }, hours: { type: "number" } } } },
	{ name: "mailbox_read", description: "Messages in a mailbox, oldest first, each with its id, sender, subject, codes, links, files and text. after skips up to that id; wait holds up to 25 s for a new one to arrive.", inputSchema: { type: "object", properties: { address: ADDRESS, after: { type: "number" }, wait: { type: "number" }, html: { type: "boolean" } }, required: ["address"] } },
	{ name: "mailbox_send", description: "Send an email from one of your mailboxes. to, cc and bcc take addresses or \"Name <a@b.com>\" (50 in all). reply_to is a message id from mailbox_read: it threads the reply, and to and subject default to the original's. attachments are paths on this computer (10 files, about 3.5 MB).", inputSchema: { type: "object", properties: { from: ADDRESS, from_name: { type: "string" }, to: { type: "array", items: { type: "string" } }, cc: { type: "array", items: { type: "string" } }, bcc: { type: "array", items: { type: "string" } }, subject: { type: "string" }, body: { type: "string" }, html: { type: "string" }, reply_to: { type: "number" }, attachments: { type: "array", items: { type: "string" } } }, required: ["from", "body"] } },
	{ name: "mailbox_sent", description: "The last 50 emails sent from a mailbox.", inputSchema: { type: "object", properties: { address: ADDRESS }, required: ["address"] } },
	{ name: "mailbox_save", description: "Save a received attachment to this computer and answer its path. file is its n from mailbox_read; folder defaults to Downloads.", inputSchema: { type: "object", properties: { message: { type: "number" }, file: { type: "number" }, folder: { type: "string" } }, required: ["message", "file"] } },
	{ name: "mailbox_delete", description: "Delete a mailbox and everything in it. Mail to it is refused afterwards.", inputSchema: { type: "object", properties: { address: ADDRESS }, required: ["address"] } },
];

function server() {
	const saved = readConfig();
	const url = (process.env.BYOD_URL || saved.url || "").replace(/\/+$/, "");
	const token = process.env.BYOD_TOKEN || saved.token || "";
	if (!url || !token) throw new Error("BYOD is not set up. Run: npx -y github:brandonmlicea/byod setup yourdomain.xyz");
	return { url, token };
}

async function call(path, init = {}) {
	const { url, token } = server();
	const response = await fetch(url + path, { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers } });
	if (response.headers.get("content-type")?.includes("json")) {
		const body = await response.json();
		if (!response.ok) throw new Error([body.error, body.hint].filter(Boolean).join(": "));
		return body;
	}
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response;
}

const when = (seconds) => (seconds ? new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") : "kept");
const at = (address) => `/boxes/${encodeURIComponent(address)}`;

function shown(m) {
	return [
		`#${m.id} ${m.received.slice(0, 19).replace("T", " ")} from ${m.from} to ${m.to}`,
		`Subject: ${m.subject}`,
		m.codes.length ? `Codes: ${m.codes.join(", ")}` : "",
		m.links.length ? `Links:\n${m.links.slice(0, 12).map((l) => `  ${l}`).join("\n")}` : "",
		m.files.length ? `Files: ${m.files.map((f) => `[${f.n}] ${f.filename} (${f.type}, ${Math.ceil(f.size / 1024)} KB)`).join(", ")}` : "",
		`\n${m.text.length > 6000 ? `${m.text.slice(0, 6000)}\n[... ${m.text.length - 6000} more characters]` : m.text}`,
		m.html ? `\nHTML:\n${m.html}` : "",
	].filter(Boolean).join("\n");
}

function attach(paths = []) {
	if (paths.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files.`);
	let total = 0;
	return paths.map((path) => {
		const full = resolve(path.replace(/^~(?=[\\/])/, homedir()));
		if (!existsSync(full) || !statSync(full).isFile()) throw new Error(`No file at ${full}`);
		const data = readFileSync(full);
		total += data.byteLength;
		if (total > MAX_ATTACHED) throw new Error(`Attachments come to over 3.5 MB at ${basename(full)}. Zip or split them.`);
		return { filename: basename(full), type: MIME[extname(full).slice(1).toLowerCase()] || "application/octet-stream", content: data.toString("base64") };
	});
}

const CALLS = {
	mailbox_list: async () => {
		const { domains, boxes } = await call("/boxes");
		if (!boxes.length) return `Domains: ${domains.join(", ")}\nNo mailboxes yet; mailbox_create makes one.`;
		return `Domains: ${domains.join(", ")}\n${boxes.map((b) => `${b.address}  ${b.messages} messages${b.last ? `, newest #${b.last}` : ""}, expires ${when(b.expires)}`).join("\n")}`;
	},
	mailbox_create: async ({ name, domain, hours }) => {
		const box = await call("/boxes", { method: "POST", body: JSON.stringify({ name, domain, hours }) });
		return `${box.address} ${box.new ? "created" : "already exists"}, expires ${when(box.expires)}.`;
	},
	mailbox_read: async ({ address, after, wait, html }) => {
		const query = new URLSearchParams({ after: String(after || 0), wait: String(wait || 0), ...(html ? { html: "1" } : {}) });
		const { messages } = await call(`${at(address)}/messages?${query}`);
		return messages.length ? messages.map(shown).join("\n\n---\n\n") : `No ${after ? "new " : ""}messages in ${address}${wait ? ` after waiting ${Math.min(wait, 25)} s` : ""}.`;
	},
	mailbox_send: async ({ from, from_name, to, cc, bcc, subject, body, html, reply_to, attachments }) => {
		const sent = await call("/send", { method: "POST", body: JSON.stringify({ from, from_name, to, cc, bcc, subject, text: body, html, reply_to, attachments: attach(attachments) }) });
		return `Sent from ${sent.from} to ${sent.to.join(", ")}: "${sent.subject}"${sent.message_id ? ` (${sent.message_id})` : ""}.`;
	},
	mailbox_sent: async ({ address }) => {
		const { sent } = await call(`${at(address)}/sent`);
		return sent.length ? sent.map((s) => `${s.at.slice(0, 16).replace("T", " ")} to ${s.recipients}: ${s.subject}`).join("\n") : `Nothing sent from ${address} yet.`;
	},
	mailbox_save: async ({ message, file, folder }) => {
		const response = await call(`/messages/${message}/files/${file}`);
		const name = (response.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] || `file-${file + 1}`).replace(/[\\/:*?"<>|]/g, "_");
		const dir = resolve(folder ? folder.replace(/^~(?=[\\/]|$)/, homedir()) : join(homedir(), "Downloads"));
		mkdirSync(dir, { recursive: true });
		let path = join(dir, name);
		for (let n = 2; existsSync(path); n++) path = join(dir, `${basename(name, extname(name))} (${n})${extname(name)}`);
		writeFileSync(path, Buffer.from(await response.arrayBuffer()));
		return `Saved ${path}`;
	},
	mailbox_delete: async ({ address }) => ((await call(at(address), { method: "DELETE" })).deleted ? `Deleted ${address}.` : `${address} was not a mailbox.`),
};

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...result })}\n`);

createInterface({ input: process.stdin }).on("line", async (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	const { id, method, params = {} } = message;
	if (id === undefined) return;
	if (method === "initialize") return reply(id, { result: { protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "byod", version: VERSION }, instructions: INSTRUCTIONS } });
	if (method === "ping") return reply(id, { result: {} });
	if (method === "tools/list") return reply(id, { result: { tools: TOOLS } });
	if (method === "tools/call") {
		const run = CALLS[params.name];
		if (!run) return reply(id, { error: { code: -32602, message: `Unknown tool ${params.name}` } });
		try {
			return reply(id, { result: { content: [{ type: "text", text: await run(params.arguments || {}) }] } });
		} catch (error) {
			return reply(id, { result: { content: [{ type: "text", text: String(error?.message || error) }], isError: true } });
		}
	}
	reply(id, { error: { code: -32601, message: `Unknown method ${method}` } });
});
