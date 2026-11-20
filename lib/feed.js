// Live pump.fun events over the free PumpPortal websocket.
import { isAddress } from "./core.js";

export const FEED_URL = "wss://pumpportal.fun/api/data";

/** Token names and tickers are chosen by whoever launches the coin: drop control characters and newlines, and cap the length. */
export const cleanText = (s, max = 64) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Turn a raw feed message into a flat launch record, or null if it is not a launch. */
export function parseLaunch(msg) {
  if (!msg || msg.txType !== "create" || !isAddress(msg.mint)) return null;
  return {
    type: "launch",
    mint: msg.mint,
    name: cleanText(msg.name),
    symbol: cleanText(msg.symbol, 24),
    dev: isAddress(msg.traderPublicKey) ? msg.traderPublicKey : null,
    devBuySol: Number(msg.solAmount) || 0,
    devBuyTokens: Number(msg.initialBuy) || 0,
    marketCapSol: Number(msg.marketCapSol) || 0,
    uri: msg.uri || null,
    signature: msg.signature || null,
    at: Date.now(),
  };
}

/** Turn a raw feed message into a migration record, or null. */
export function parseMigration(msg) {
  if (!msg || msg.txType !== "migrate" || !isAddress(msg.mint)) return null;
  return { type: "migration", mint: msg.mint, pool: msg.pool || null, signature: msg.signature || null, at: Date.now() };
}

/** Build a predicate from CLI filters. All given filters must pass. */
export function makeFilter({ minDevBuy = 0, maxDevBuy = Infinity, name = null, exclude = null } = {}) {
  const include = name ? new RegExp(name, "i") : null;
  const reject = exclude ? new RegExp(exclude, "i") : null;
  return (launch) => {
    if (launch.devBuySol < minDevBuy || launch.devBuySol > maxDevBuy) return false;
    const text = `${launch.name} ${launch.symbol}`;
    if (include && !include.test(text)) return false;
    if (reject && reject.test(text)) return false;
    return true;
  };
}

/**
 * Connect and keep the connection alive. Calls onEvent for every launch and,
 * if asked, every migration. Returns a function that stops the feed.
 */
export function connect({
  migrations = false,
  onEvent,
  onStatus = () => {},
  WebSocketImpl = globalThis.WebSocket,
  url = FEED_URL,
  staleMs = 120000,
}) {
  let ws;
  let stopped = false;
  let retry = 0;
  let timer;
  let staleTimer;

  const resetStaleTimer = () => {
    clearTimeout(staleTimer);
    if (staleMs > 0 && !stopped) {
      staleTimer = setTimeout(() => {
        onStatus(`no messages for ${Math.round(staleMs / 1000)}s, reconnecting`);
        try { ws.close(); } catch { /* already closed */ }
      }, staleMs);
    }
  };

  const open = () => {
    if (stopped) return;
    ws = new WebSocketImpl(url);
    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      if (migrations) ws.send(JSON.stringify({ method: "subscribeMigration" }));
      onStatus("connected");
      resetStaleTimer();
    };
    ws.onmessage = (ev) => {
      resetStaleTimer();
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      const event = parseLaunch(msg) || (migrations ? parseMigration(msg) : null);
      if (event) onEvent(event);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      clearTimeout(staleTimer);
      if (stopped) return;
      const wait = Math.min(30000, 1000 * 2 ** retry++);
      onStatus(`disconnected, retrying in ${Math.round(wait / 1000)}s`);
      timer = setTimeout(open, wait);
    };
  };
  open();
  return () => {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(staleTimer);
    try { ws.close(); } catch { /* already closed */ }
  };
}
