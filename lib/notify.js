import { sleep } from "./core.js";

const TELEGRAM_API = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";

/** Escape text for Telegram's HTML parse mode. */
export const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Escape Discord markdown so a token name cannot add links, headings or formatting. */
const md = (s) => String(s ?? "").replace(/([\\*_`~|\[\]()<>#\-])/g, "\\$1");

/** Build the message for one alert, in Telegram HTML, in Discord markdown and as plain text for the terminal. */
export function formatAlert(a, site = "https://blixvip.com") {
  const links = {
    pump: `https://pump.fun/coin/${a.mint}`,
    dex: `https://dexscreener.com/solana/${a.mint}`,
    rug: `https://rugcheck.xyz/tokens/${a.mint}`,
    blix: `${site}/pump-fun-tracker`,
  };
  const head = a.type === "migration" ? "🎓 Graduated" : "🚀 New launch";
  const facts = [];
  if (a.type === "launch") facts.push(`Dev buy ${a.devBuySol.toFixed(2)} SOL`, `Mcap ${a.marketCapSol.toFixed(1)} SOL`);
  if (a.check) {
    if (a.check.top10 !== null) facts.push(`Top 10 hold ${a.check.top10.toFixed(1)}%`);
    if (a.check.holders !== null) facts.push(`${a.check.holders.toLocaleString("en-US")} holders`);
    if (a.check.risks.length) facts.push(`⚠️ ${a.check.risks.join(", ")}`);
  }
  const ticker = String(a.symbol || "").replace(/^\$+/, "");
  const title = a.name ? `${a.name}${ticker ? ` ($${ticker})` : ""}` : a.mint;
  const telegram =
    `<b>${head}: ${esc(title)}</b>\n` +
    (facts.length ? esc(facts.join(" · ")) + "\n" : "") +
    `<code>${esc(a.mint)}</code>\n` +
    `<a href="${esc(links.pump)}">pump.fun</a> · <a href="${esc(links.dex)}">DexScreener</a> · <a href="${esc(links.rug)}">RugCheck</a> · <a href="${esc(links.blix)}">BLIX</a>`;
  const discord =
    `**${head}: ${a.name ? `${md(a.name)}${ticker ? ` ($${md(ticker)})` : ""}` : a.mint}**\n` +
    (facts.length ? facts.join(" · ") + "\n" : "") +
    `\`${a.mint}\`\n` +
    `[pump.fun](<${links.pump}>) · [DexScreener](<${links.dex}>) · [RugCheck](<${links.rug}>) · [BLIX](<${links.blix}>)`;
  const text = `${head}: ${title}\n` + (facts.length ? facts.join(" · ") + "\n" : "") + a.mint;
  return { telegram, discord, text };
}

/**
 * A sender with a queue, so bursts are spaced out and rate limits are respected.
 * Telegram allows about 20 messages a minute in a group; Discord webhooks about 30.
 */
export function createNotifier({ telegramToken, telegramChat, discordWebhook, gapMs = 3100, log = () => {} }) {
  const queue = [];
  let running = false;
  let sent = 0, failed = 0;

  async function post(url, body, label) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          const wait = (data.parameters?.retry_after ?? data.retry_after ?? 2) * 1000;
          await sleep(Math.min(60000, wait + 250));
          continue;
        }
        if (!res.ok) {
          const text = (await res.text()).slice(0, 200);
          const err = new Error(`${label} HTTP ${res.status}: ${text}`);
          if (res.status >= 400 && res.status < 500) err.isClientError = true;
          throw err;
        }
        return true;
      } catch (err) {
        if (err.isClientError || attempt === 3) { log(`${label} failed: ${err.message}`); return false; }
        await sleep(1000 * 2 ** attempt);
      }
    }
    return false;
  }

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      const msg = queue.shift();
      const results = [];
      if (telegramToken && telegramChat) {
        results.push(await post(`${TELEGRAM_API}/bot${telegramToken}/sendMessage`, { chat_id: telegramChat, text: msg.telegram, parse_mode: "HTML", disable_web_page_preview: true }, "Telegram"));
      }
      if (discordWebhook) results.push(await post(discordWebhook, { content: msg.discord, allowed_mentions: { parse: [] } }, "Discord"));
      if (results.every(Boolean)) sent++; else failed++;
      if (queue.length) await sleep(gapMs);
    }
    running = false;
  }

  return {
    enabled: Boolean((telegramToken && telegramChat) || discordWebhook),
    send(msg) {
      if (queue.length >= 50) queue.shift(); // under a flood, drop the oldest rather than fall minutes behind
      queue.push(msg);
      drain();
    },
    stats: () => ({ sent, failed, queued: queue.length }),
    idle: async () => { while (running || queue.length) await sleep(100); },
  };
}
