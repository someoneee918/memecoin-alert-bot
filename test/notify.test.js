import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { esc, formatAlert } from "../lib/notify.js";
import { passesCheck } from "../lib/check.js";

const launch = { type: "launch", mint: "MintAAApump", name: "Cats & <Dogs>", symbol: "CAD", devBuySol: 1.5, marketCapSol: 30 };

test("Telegram text is HTML-escaped and Discord text keeps links unfurl-free", () => {
  const m = formatAlert(launch);
  assert.match(m.telegram, /Cats &amp; &lt;Dogs&gt;/);
  assert.match(m.telegram, /Dev buy 1\.50 SOL/);
  assert.match(m.telegram, /<code>MintAAApump<\/code>/);
  assert.match(m.discord, /\[BLIX\]\(<https:\/\/blixvip\.com\/pump-fun-tracker>\)/);
  assert.equal(esc("<b>"), "&lt;b&gt;");
});

test("graduation alerts include the holder check", () => {
  const m = formatAlert({ type: "migration", mint: "M", name: "", symbol: "", check: { top10: 22.5, holders: 1234, risks: ["Single holder ownership"] } });
  assert.match(m.discord, /Graduated: M/);
  assert.match(m.discord, /Top 10 hold 22\.5% · 1,234 holders · ⚠️ Single holder ownership/);
});

test("the top-10 filter only blocks when there is data over the limit", () => {
  assert.equal(passesCheck({ top10: 40 }, { maxTop10: 30 }), false);
  assert.equal(passesCheck({ top10: 20 }, { maxTop10: 30 }), true);
  assert.equal(passesCheck(null, { maxTop10: 30 }), true);
  assert.equal(passesCheck({ top10: 99 }, {}), true);
});

test("the notifier posts to Telegram and Discord, and retries after a 429", async () => {
  const hits = [];
  let first = true;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      hits.push({ url: req.url, body: JSON.parse(body) });
      if (req.url.startsWith("/bot") && first) { first = false; res.writeHead(429, { "content-type": "application/json" }); return res.end(JSON.stringify({ parameters: { retry_after: 0 } })); }
      res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TELEGRAM_API_BASE = base;
  const { createNotifier } = await import(`../lib/notify.js?fresh=${Date.now()}`);
  const n = createNotifier({ telegramToken: "T", telegramChat: "42", discordWebhook: `${base}/hook`, gapMs: 1 });
  n.send(formatAlert(launch));
  n.send(formatAlert({ ...launch, mint: "Second" }));
  await n.idle();
  server.close();
  assert.deepEqual(n.stats(), { sent: 2, failed: 0, queued: 0 });
  const tg = hits.filter((h) => h.url === "/botT/sendMessage");
  assert.equal(tg.length, 3); // one 429, then two successes
  assert.equal(tg[1].body.chat_id, "42");
  assert.equal(tg[1].body.parse_mode, "HTML");
  assert.equal(hits.filter((h) => h.url === "/hook").length, 2);
  assert.deepEqual(hits.find((h) => h.url === "/hook").body.allowed_mentions, { parse: [] });
});

test("copycat launches inside the window are caught, case-insensitively", async () => {
  const { createCopyFilter } = await import("../lib/check.js");
  let t = 0;
  const isCopy = createCopyFilter(600_000, () => t);
  assert.equal(isCopy({ name: "DCTY IS A PSYOP", symbol: "DCTY" }), false);
  t = 60_000;
  assert.equal(isCopy({ name: "dcty is a psyop ", symbol: "dcty" }), true);
  assert.equal(isCopy({ name: "Something else", symbol: "DCTY" }), false);
  t = 60_000 + 600_001;
  assert.equal(isCopy({ name: "DCTY IS A PSYOP", symbol: "DCTY" }), false);
});

test("a ticker that already starts with $ is not doubled", () => {
  assert.match(formatAlert({ ...launch, symbol: "$CUTE" }).discord, /\(\$CUTE\)/);
  assert.doesNotMatch(formatAlert({ ...launch, symbol: "$CUTE" }).discord, /\$\$/);
  assert.match(formatAlert({ ...launch, symbol: "" }).discord, /Cats & \\<Dogs\\>\*\*/);
});

test("a hostile token name cannot add Discord links or Telegram tags", () => {
  const m = formatAlert({ ...launch, name: "Claim [here](https://evil.example) <b>x</b>", symbol: "X" });
  assert.doesNotMatch(m.discord, /\[here\]\(https/);
  assert.match(m.discord, /\\\[here\\\]\\\(https/);
  assert.doesNotMatch(m.telegram, /<b>x<\/b>/);
});

test("the plain-text version for --dry-run has no Discord escapes or markup", () => {
  const m = formatAlert({ ...launch, name: "Pepe-The_Frog (v2)", symbol: "PEPE" });
  assert.equal(m.text, "🚀 New launch: Pepe-The_Frog (v2) ($PEPE)\nDev buy 1.50 SOL · Mcap 30.0 SOL\nMintAAApump");
  const g = formatAlert({ type: "migration", mint: "M", name: "", symbol: "", check: null });
  assert.equal(g.text, "🎓 Graduated: M\nM");
});

test("Telegram and Discord 4xx errors fail immediately without retry", async () => {
  let requestCount = 0;
  const server = createServer((req, res) => {
    requestCount++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }));
  });
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.TELEGRAM_API_BASE = base;
  const { createNotifier } = await import(`../lib/notify.js?fresh=${Date.now()}`);
  const n = createNotifier({ telegramToken: "T", telegramChat: "invalid_chat", gapMs: 1 });
  n.send(formatAlert(launch));
  await n.idle();
  server.close();
  assert.equal(requestCount, 1);
  assert.equal(n.stats().failed, 1);
});
