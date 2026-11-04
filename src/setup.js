import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG = process.env.BYOD_CONFIG || join(homedir(), ".byod", "config.json");
const WORKER = join(dirname(fileURLToPath(import.meta.url)), "..", "worker", "wrangler.jsonc");

export function readConfig() {
	try {
		return JSON.parse(readFileSync(CONFIG, "utf8"));
	} catch {
		return {};
	}
}

function wrangler(args, input) {
	const quoted = ["-y", "wrangler@4", ...args, "--config", WORKER].map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a));
	const run = spawnSync("npx", quoted, { input, shell: true, encoding: "utf8", stdio: [input ? "pipe" : "inherit", "pipe", "inherit"] });
	process.stderr.write(run.stdout || "");
	if (run.status !== 0) throw new Error(`wrangler ${args[0]} failed`);
	return run.stdout || "";
}

export async function setup(domains) {
	if (!domains.length || !domains.every((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d))) {
		console.error("Usage: npx -y github:brandonmlicea/byod setup yourdomain.xyz [more.domains]");
		process.exit(1);
	}
	const saved = readConfig();
	const token = saved.token || randomBytes(32).toString("hex");
	console.error(`Deploying the byod Worker for ${domains.join(", ")} to your Cloudflare account...`);
	const out = wrangler(["deploy", "--var", `DOMAIN:${domains.join(",").toLowerCase()}`]);
	const url = out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] || saved.url;
	wrangler(["secret", "put", "TOKEN"], `${token}\n`);
	mkdirSync(dirname(CONFIG), { recursive: true });
	writeFileSync(CONFIG, JSON.stringify({ url, token }, null, "\t"), { mode: 0o600 });
	const check = url ? await fetch(`${url}/boxes`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status).catch(() => 0) : 0;
	console.error(`
Worker: ${url || "(set BYOD_URL to its address)"}${check === 200 ? " (answering)" : ""}
Saved:  ${CONFIG}

Two switches left in the Cloudflare dashboard, for each domain:
  1. Compute > Email Service > Email Routing > Onboard Domain, then Routing rules >
     Catch-all address > Edit > Action "Send to a Worker" > byod > Save, and turn it on.
  2. To send mail: Compute > Email Service > Email Sending > Onboard Domain (Workers Paid plan).

Then add it to Claude Code:
  claude mcp add byod -- npx -y github:brandonmlicea/byod
`);
}
