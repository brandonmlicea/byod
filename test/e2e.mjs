import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
const URL_ = `http://127.0.0.1:${PORT}`;
const TOKEN = "test-token";
const dir = mkdtempSync(join(tmpdir(), "byod-"));
writeFileSync(new URL("../worker/.dev.vars", import.meta.url), `TOKEN=${TOKEN}\n`);
const dev = spawn("npx", ["-y", "wrangler@4", "dev", "--config", "worker/wrangler.jsonc", "--port", String(PORT), "--var", "DOMAIN:example.xyz,second.xyz", "--persist-to", join(dir, "state")], { shell: true, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
dev.stdout.on("data", (d) => (log += d));
dev.stderr.on("data", (d) => (log += d));

const checks = [];
const check = (name, ok, detail = "") => (checks.push(ok), console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${detail}`}`));

if (await fetch(URL_).then(() => true, () => false)) throw new Error(`Port ${PORT} is already in use`);
for (let n = 0; n < 120; n++) {
	if (await fetch(URL_).then(() => true, () => false)) break;
	await new Promise((r) => setTimeout(r, 500));
}

const email = (to, raw) => fetch(`${URL_}/cdn-cgi/handler/email?from=sender%40acme.com&to=${encodeURIComponent(to)}`, { method: "POST", body: raw });
const eml = (to, subject, body, extra = "") => `From: Acme <sender@acme.com>\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <m-${Math.random()}@acme.com>\r\nMIME-Version: 1.0\r\n${extra || `Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`}`;

const mcp = spawn(process.execPath, ["src/index.js"], { env: { ...process.env, BYOD_URL: URL_, BYOD_TOKEN: TOKEN }, stdio: ["pipe", "pipe", "inherit"] });
let buffer = "";
const waiting = new Map();
mcp.stdout.on("data", (d) => {
	buffer += d;
	for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
		const line = JSON.parse(buffer.slice(0, at));
		buffer = buffer.slice(at + 1);
		waiting.get(line.id)?.(line);
	}
});
let next = 1;
const rpc = (method, params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); });
const tool = async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); return { text: r.result.content[0].text, error: Boolean(r.result.isError) }; };

try {
	const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
	check("initialize", init.result.serverInfo.name === "byod");
	const tools = await rpc("tools/list", {});
	check("seven tools", tools.result.tools.length === 7);

	const denied = await fetch(`${URL_}/boxes`, { headers: { authorization: "Bearer nope" } });
	check("wrong token refused", denied.status === 401);

	check("create named", /signup@example\.xyz created/.test((await tool("mailbox_create", { name: "signup" })).text));
	check("create again answers it", /already exists/.test((await tool("mailbox_create", { name: "signup" })).text));
	const random = (await tool("mailbox_create", { domain: "second.xyz", hours: 1 })).text;
	check("random on second domain, expiring", /^[a-z0-9]{1,8}@second\.xyz created, expires \d{4}/.test(random), random);
	check("unknown domain refused", (await tool("mailbox_create", { name: "x@other.com" })).error);

	const stranger = await email("nobody@example.xyz", eml("nobody@example.xyz", "hi", "hello"));
	const strangerSaid = `${stranger.status} ${await stranger.text()}`;
	console.log("     stranger:", strangerSaid.slice(0, 120));
	check("mail to a stranger refused", /reject/i.test(strangerSaid) && /No such mailbox/.test(strangerSaid), strangerSaid);

	const started = Date.now();
	const waited = tool("mailbox_read", { address: "signup@example.xyz", wait: 10 });
	await new Promise((r) => setTimeout(r, 1500));
	await email("signup@example.xyz", eml("signup@example.xyz", "Confirm your account", "Your verification code is 482913.\nOr open https://acme.com/verify?t=abc"));
	const read = (await waited).text;
	check("wait returns the new mail", /#1 .*from sender@acme\.com/.test(read) && Date.now() - started < 9000, read);
	check("code picked out", /Codes: 482913/.test(read));
	check("link picked out", /https:\/\/acme\.com\/verify\?t=abc/.test(read));
	check("after skips seen mail", /No new messages/.test((await tool("mailbox_read", { address: "signup@example.xyz", after: 1 })).text));

	const pdf = Buffer.from("%PDF-1.4 tiny test file").toString("base64");
	await email("signup+acme@example.xyz", eml("signup+acme@example.xyz", "Your invoice", "", `Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>Invoice attached. <a href="https://acme.com/billing">Billing</a></p>\r\n--b\r\nContent-Type: application/pdf; name="invoice.pdf"\r\nContent-Disposition: attachment; filename="invoice.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf}\r\n--b--\r\n`));
	const invoice = (await tool("mailbox_read", { address: "signup@example.xyz", after: 1 })).text;
	check("html-only mail read as text", /Invoice attached\. Billing/.test(invoice) && /acme\.com\/billing/.test(invoice), invoice);
	check("plus address lands in its mailbox", /#2 .* to signup@example\.xyz/.test(invoice), invoice);
	check("attachment listed", /\[0\] invoice\.pdf \(application\/pdf/.test(invoice));
	const saved = (await tool("mailbox_save", { message: 2, file: 0, folder: dir })).text;
	check("attachment saved byte-exact", readFileSync(saved.replace(/^Saved /, ""), "utf8") === "%PDF-1.4 tiny test file", saved);

	writeFileSync(join(dir, "notes.txt"), "hello from byod");
	const sent = await tool("mailbox_send", { from: "signup@example.xyz", reply_to: 1, body: "Thanks!", attachments: [join(dir, "notes.txt")] });
	check("reply sent to the sender, Re: subject", /Sent from signup@example\.xyz to sender@acme\.com: "Re: Confirm your account"/.test(sent.text), sent.text);
	check("sent log", /sender@acme\.com: Re: Confirm your account/.test((await tool("mailbox_sent", { address: "signup@example.xyz" })).text));
	check("send from a stranger refused", (await tool("mailbox_send", { from: "ceo@example.xyz", to: ["a@b.com"], subject: "x", body: "x" })).error);
	check("bad recipient refused", /not an email address/.test((await tool("mailbox_send", { from: "signup@example.xyz", to: ["nope"], subject: "x", body: "x" })).text));

	check("list", /signup@example\.xyz {2}2 messages, newest #2, expires kept/.test((await tool("mailbox_list", {})).text));
	check("delete", /Deleted/.test((await tool("mailbox_delete", { address: "signup@example.xyz" })).text));
	const after = await email("signup@example.xyz", eml("signup@example.xyz", "late", "late"));
	check("deleted mailbox refuses mail", /No such mailbox/.test(await after.text()));
} catch (error) {
	console.log("FAIL", error, log.slice(-3000));
	checks.push(false);
} finally {
	mcp.kill();
	if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(dev.pid), "/T", "/F"], { stdio: "ignore" });
	else dev.kill();
	rmSync(new URL("../worker/.dev.vars", import.meta.url), { force: true });
}
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
process.exit(checks.every(Boolean) ? 0 : 1);
