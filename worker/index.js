import { DurableObject } from "cloudflare:workers";
import PostalMime from "postal-mime";

import { findCodes, findLinks, plain } from "./read.js";

const MAX_IN = 10 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const KEEP_TEXT = 256 * 1024;
const KEEP_MESSAGES = 1000;
const MAX_WAIT = 25;
const MAX_TO = 50;
const DAY = 86400;
const ADDRESS = /^[^\s@<>()[\]",;:\\]+@[^\s@<>()[\]",;:\\]+\.[a-z0-9-]{2,}$/i;

const now = () => Math.floor(Date.now() / 1000);
const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, error, hint) => json({ error, hint }, status);
const domainsOf = (env) => String(env.DOMAIN || "").toLowerCase().split(/[\s,]+/).filter(Boolean);
const mail = (env) => env.MAIL.get(env.MAIL.idFromName("mail"));

export class Mail extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS boxes (address TEXT PRIMARY KEY, created INTEGER, expires INTEGER);
CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT, sender TEXT, subject TEXT, text TEXT, html TEXT, links TEXT, codes TEXT, files TEXT, message_id TEXT, received INTEGER);
CREATE INDEX IF NOT EXISTS messages_box ON messages (address, id);
CREATE TABLE IF NOT EXISTS raw (message INTEGER, n INTEGER, data BLOB, PRIMARY KEY (message, n));
CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT, recipients TEXT, subject TEXT, message_id TEXT, at INTEGER);`);
	}

	rows(query, ...args) {
		return this.sql.exec(query, ...args).toArray();
	}

	sweep() {
		for (const { address } of this.rows("SELECT address FROM boxes WHERE expires > 0 AND expires < ?", now())) this.remove(address);
	}

	box(address) {
		this.sweep();
		return this.rows("SELECT * FROM boxes WHERE address = ?", address)[0] ?? null;
	}

	create(address, hours) {
		const found = this.box(address);
		if (found) return { address, expires: found.expires, new: false };
		const expires = hours > 0 ? now() + Math.round(hours * 3600) : 0;
		this.sql.exec("INSERT INTO boxes VALUES (?, ?, ?)", address, now(), expires);
		return { address, expires, new: true };
	}

	list() {
		this.sweep();
		return this.rows("SELECT b.address, b.created, b.expires, COUNT(m.id) AS messages, MAX(m.id) AS last FROM boxes b LEFT JOIN messages m ON m.address = b.address GROUP BY b.address ORDER BY b.created");
	}

	remove(address) {
		this.sql.exec("DELETE FROM raw WHERE message IN (SELECT id FROM messages WHERE address = ?)", address);
		this.sql.exec("DELETE FROM messages WHERE address = ?", address);
		this.sql.exec("DELETE FROM sent WHERE address = ?", address);
		return this.sql.exec("DELETE FROM boxes WHERE address = ?", address).rowsWritten > 0;
	}

	store(message, raw) {
		const { id } = this.rows(
			"INSERT INTO messages (address, sender, subject, text, html, links, codes, files, message_id, received) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
			message.address, message.sender, message.subject, message.text, message.html,
			JSON.stringify(message.links), JSON.stringify(message.codes), JSON.stringify(message.files), message.messageId, now()
		)[0];
		for (let at = 0, n = 0; at < raw.byteLength; at += CHUNK, n++) {
			this.sql.exec("INSERT INTO raw VALUES (?, ?, ?)", id, n, raw.slice(at, at + CHUNK));
		}
		const old = this.rows("SELECT id FROM messages WHERE address = ? ORDER BY id DESC LIMIT -1 OFFSET ?", message.address, KEEP_MESSAGES);
		for (const row of old) {
			this.sql.exec("DELETE FROM raw WHERE message = ?", row.id);
			this.sql.exec("DELETE FROM messages WHERE id = ?", row.id);
		}
		return id;
	}

	messages(address, after, html) {
		return this.rows("SELECT * FROM messages WHERE address = ? AND id > ? ORDER BY id LIMIT 50", address, after).map((m) => ({
			id: m.id,
			to: m.address,
			from: m.sender,
			subject: m.subject,
			received: new Date(m.received * 1000).toISOString(),
			codes: JSON.parse(m.codes),
			links: JSON.parse(m.links),
			files: JSON.parse(m.files),
			text: m.text,
			...(html ? { html: m.html } : {}),
			message_id: m.message_id,
		}));
	}

	message(id) {
		return this.rows("SELECT id, address, sender, subject, message_id FROM messages WHERE id = ?", id)[0] ?? null;
	}

	raw(id) {
		const parts = this.rows("SELECT data FROM raw WHERE message = ? ORDER BY n", id).map((r) => new Uint8Array(r.data));
		if (!parts.length) return null;
		const out = new Uint8Array(parts.reduce((sum, p) => sum + p.byteLength, 0));
		parts.reduce((at, p) => (out.set(p, at), at + p.byteLength), 0);
		return out.buffer;
	}

	sentToday() {
		return this.rows("SELECT COUNT(*) AS n FROM sent WHERE at > ?", now() - DAY)[0].n;
	}

	logSent(address, recipients, subject, messageId) {
		this.sql.exec("INSERT INTO sent (address, recipients, subject, message_id, at) VALUES (?, ?, ?, ?, ?)", address, recipients.join(", "), subject, messageId, now());
	}

	sent(address) {
		return this.rows("SELECT * FROM sent WHERE address = ? ORDER BY id DESC LIMIT 50", address).map((s) => ({ ...s, at: new Date(s.at * 1000).toISOString() }));
	}
}

async function inbound(message, env) {
	const store = mail(env);
	const to = String(message.to || "").toLowerCase();
	const address = (await store.box(to)) ? to : to.replace(/\+[^@]*@/, "@");
	if (!(await store.box(address))) return message.setReject("No such mailbox");
	if (message.rawSize > MAX_IN) return message.setReject("Message too large");
	const raw = await new Response(message.raw).arrayBuffer();
	if (raw.byteLength > MAX_IN) return message.setReject("Message too large");
	const parsed = await PostalMime.parse(raw).catch(() => ({}));
	const html = parsed.html || "";
	const text = parsed.text || plain(html);
	await store.store({
		address,
		sender: parsed.from?.address || message.from || "",
		subject: parsed.subject || "",
		text: text.slice(0, KEEP_TEXT),
		html: html.slice(0, KEEP_TEXT),
		links: findLinks(text, html),
		codes: findCodes(`${parsed.subject || ""}\n${text}`),
		files: (parsed.attachments || []).map((a, n) => ({ n, filename: a.filename || `file-${n + 1}`, type: a.mimeType, size: a.content.byteLength ?? a.content.length })),
		messageId: parsed.messageId || "",
	}, raw);
}

function recipients(value, field) {
	const list = [];
	for (const entry of [value ?? []].flat().flatMap((v) => String(v).split(/[,;](?=(?:[^"]*"[^"]*")*[^"]*$)/)).map((v) => v.trim()).filter(Boolean)) {
		const named = entry.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/);
		const email = (named ? named[2] : entry).trim();
		if (!ADDRESS.test(email)) return { error: `"${entry}" in ${field} is not an email address.` };
		list.push(named?.[1] ? { name: named[1].trim(), email } : email);
	}
	return { list };
}

async function send(body, env) {
	const store = mail(env);
	const from = String(body.from || "").toLowerCase();
	if (!(await store.box(from))) return fail(400, "unknown_from", "from must be one of your mailboxes (mailbox_list).");
	let original = null;
	if (body.reply_to) {
		original = await store.message(Number(body.reply_to));
		if (!original || original.address !== from) return fail(400, "message_not_found", "reply_to must be the id of a message in the from mailbox.");
	}
	const lists = {};
	for (const field of ["to", "cc", "bcc"]) {
		const parsed = recipients(field === "to" && !body.to && original ? original.sender : body[field], field);
		if (parsed.error) return fail(400, "bad_address", parsed.error);
		lists[field] = parsed.list;
	}
	const count = lists.to.length + lists.cc.length + lists.bcc.length;
	if (!count) return fail(400, "no_recipients", "Give at least one address in to, cc or bcc.");
	if (count > MAX_TO) return fail(400, "too_many_recipients", `At most ${MAX_TO} addresses across to, cc and bcc.`);
	const subject = String(body.subject || (original ? `Re: ${original.subject.replace(/^re:\s*/i, "")}` : "")).slice(0, 400);
	if (!subject) return fail(400, "no_subject", "Give the email a subject.");
	if (!body.text && !body.html) return fail(400, "no_body", "Give the email a body.");
	const limit = Number(env.DAILY_LIMIT) || 100;
	if ((await store.sentToday()) >= limit) return fail(429, "daily_limit", `${limit} emails were sent in the last 24 hours. Raise DAILY_LIMIT or wait.`);
	const thread = original?.message_id ? { "In-Reply-To": original.message_id, References: original.message_id } : null;
	try {
		const result = await env.EMAIL.send({
			from: body.from_name ? { name: String(body.from_name), email: from } : from,
			to: lists.to,
			...(lists.cc.length ? { cc: lists.cc } : {}),
			...(lists.bcc.length ? { bcc: lists.bcc } : {}),
			subject,
			...(body.text ? { text: String(body.text) } : {}),
			...(body.html ? { html: String(body.html) } : {}),
			...(thread ? { headers: thread } : {}),
			...(body.attachments?.length ? { attachments: body.attachments.map((a) => ({ disposition: "attachment", filename: a.filename, type: a.type || "application/octet-stream", content: a.content })) } : {}),
		});
		const shown = [...lists.to, ...lists.cc, ...lists.bcc].map((r) => r.email ?? r);
		await store.logSent(from, shown, subject, result?.messageId || "");
		return json({ sent: true, from, to: shown, subject, message_id: result?.messageId || "" });
	} catch (error) {
		const code = String(error?.code || error?.message || error);
		const hint = /SENDER|DOMAIN_NOT_AVAILABLE|RECIPIENT_NOT_ALLOWED|verified/i.test(code)
			? `Sending is not set up for ${from.split("@")[1]}: onboard it under Compute > Email Service > Email Sending (Workers Paid plan).`
			: /LIMIT/i.test(code) ? "Cloudflare's sending limit was hit. Try later." : "Cloudflare refused the message.";
		return fail(502, "send_failed", `${hint} (${code})`);
	}
}

async function authorized(request, env) {
	const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
	const digest = async (value) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Boolean(env.TOKEN) && crypto.subtle.timingSafeEqual(await digest(given), await digest(env.TOKEN));
}

const randomName = () => [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 8);

async function api(request, env) {
	if (!env.TOKEN) return fail(503, "no_token", "Run byod setup to set the token.");
	if (!(await authorized(request, env))) return fail(401, "unauthorized");
	const url = new URL(request.url);
	const [, first, second, third, fourth] = url.pathname.split("/").map(decodeURIComponent);
	const store = mail(env);
	const domains = domainsOf(env);
	const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};

	if (first === "boxes" && !second && request.method === "GET") return json({ domains, boxes: await store.list() });
	if (first === "boxes" && !second && request.method === "POST") {
		const [local, at] = String(body.name || "").toLowerCase().split("@");
		const domain = (at || body.domain || domains[0] || "").toLowerCase();
		if (!domains.includes(domain)) return fail(400, "unknown_domain", `Use one of: ${domains.join(", ") || "none (set DOMAIN)"}.`);
		const name = (local || randomName()).replace(/[^a-z0-9._+-]/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 64);
		if (!name) return fail(400, "bad_name");
		return json(await store.create(`${name}@${domain}`, Number(body.hours) || 0));
	}
	if (first === "boxes" && second && request.method === "DELETE") return json({ deleted: await store.remove(second.toLowerCase()) });
	if (first === "boxes" && second && third === "messages") {
		const address = second.toLowerCase();
		if (!(await store.box(address))) return fail(404, "no_mailbox");
		const after = Number(url.searchParams.get("after")) || 0;
		const deadline = Date.now() + Math.min(Number(url.searchParams.get("wait")) || 0, MAX_WAIT) * 1000;
		let messages = await store.messages(address, after, url.searchParams.has("html"));
		while (!messages.length && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			messages = await store.messages(address, after, url.searchParams.has("html"));
		}
		return json({ address, messages });
	}
	if (first === "boxes" && second && third === "sent") return json({ sent: await store.sent(second.toLowerCase()) });
	if (first === "messages" && second && third === "files" && fourth !== undefined) {
		const raw = await store.raw(Number(second));
		if (!raw) return fail(404, "no_message");
		const file = (await PostalMime.parse(raw)).attachments?.[Number(fourth)];
		if (!file) return fail(404, "no_file");
		const name = (file.filename || `file-${Number(fourth) + 1}`).replace(/["\r\n]/g, "");
		return new Response(file.content, { headers: { "content-type": file.mimeType || "application/octet-stream", "content-disposition": `attachment; filename="${name}"` } });
	}
	if (first === "send" && request.method === "POST") return send(body, env);
	return fail(404, "not_found");
}

export default {
	fetch: (request, env) => api(request, env).catch((error) => fail(500, "error", String(error?.message || error))),
	email: (message, env) => inbound(message, env),
};
