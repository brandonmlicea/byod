import { readFileSync } from "node:fs";

import { findCodes, findLinks, plain } from "../worker/read.js";

const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));
let passed = 0;
for (const c of cases) {
	const got = findCodes(c.text)[0] ?? null;
	const ok = got === c.code;
	passed += ok;
	if (!ok) console.log(`miss: wanted ${c.code}, got ${got} in ${JSON.stringify(c.text.slice(0, 60))}`);
}
const links = findLinks("Go to https://a.com/x. or https://b.com/y)", '<a href="https://c.com/z?a=1&amp;b=2">here</a>');
const linksOk = JSON.stringify(links) === JSON.stringify(["https://c.com/z?a=1&b=2", "https://a.com/x", "https://b.com/y"]);
const plainOk = plain("<style>p{}</style><p>Hi&nbsp;there</p><p>Code: <b>123456</b></p>") === "Hi there\nCode: 123456";
console.log(`codes ${passed}/${cases.length}, links ${linksOk ? "ok" : JSON.stringify(links)}, html to text ${plainOk ? "ok" : "miss"}`);
process.exit(passed === cases.length && linksOk && plainOk ? 0 : 1);
