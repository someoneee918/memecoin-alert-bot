import test from "node:test";
import assert from "node:assert/strict";
import { connect, FEED_URL } from "../lib/feed.js";

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
  }

  triggerOpen() {
    if (this.onopen) this.onopen();
  }

  triggerMessage(data) {
    if (this.onmessage) this.onmessage({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  triggerClose() {
    this.close();
  }
}

test("subscribeNewToken is always sent and subscribeMigration only when migrations: true", () => {
  FakeWebSocket.instances = [];

  // Case 1: migrations = false
  const stop1 = connect({
    migrations: false,
    onEvent: () => {},
    WebSocketImpl: FakeWebSocket,
  });
  assert.equal(FakeWebSocket.instances.length, 1);
  const ws1 = FakeWebSocket.instances[0];
  assert.equal(ws1.url, FEED_URL);
  ws1.triggerOpen();

  assert.equal(ws1.sent.length, 1);
  assert.deepEqual(JSON.parse(ws1.sent[0]), { method: "subscribeNewToken" });
  stop1();

  // Case 2: migrations = true
  FakeWebSocket.instances = [];
  const stop2 = connect({
    migrations: true,
    onEvent: () => {},
    WebSocketImpl: FakeWebSocket,
  });
  assert.equal(FakeWebSocket.instances.length, 1);
  const ws2 = FakeWebSocket.instances[0];
  ws2.triggerOpen();

  assert.equal(ws2.sent.length, 2);
  assert.deepEqual(JSON.parse(ws2.sent[0]), { method: "subscribeNewToken" });
  assert.deepEqual(JSON.parse(ws2.sent[1]), { method: "subscribeMigration" });
  stop2();
});

test("retry delays grow 1s, 2s, 4s and cap at 30s", (t) => {
  t.mock.timers.enable();
  FakeWebSocket.instances = [];
  const statuses = [];

  const stop = connect({
    onEvent: () => {},
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeWebSocket,
  });

  assert.equal(FakeWebSocket.instances.length, 1);
  const expectedDelays = [1, 2, 4, 8, 16, 30, 30];

  for (let i = 0; i < expectedDelays.length; i++) {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    const prevCount = FakeWebSocket.instances.length;
    const delay = expectedDelays[i];

    ws.triggerClose();
    assert.equal(statuses[statuses.length - 1], `disconnected, retrying in ${delay}s`);

    // Before delay expires, no new socket should be created
    if (delay > 1) {
      t.mock.timers.tick((delay - 1) * 1000);
      assert.equal(FakeWebSocket.instances.length, prevCount);
      t.mock.timers.tick(1000);
    } else {
      t.mock.timers.tick(1000);
    }

    assert.equal(FakeWebSocket.instances.length, prevCount + 1);
  }

  stop();
  t.mock.timers.reset();
});

test("a silent socket is closed after staleMs and triggers reconnect", (t) => {
  t.mock.timers.enable();
  FakeWebSocket.instances = [];
  const statuses = [];

  const stop = connect({
    staleMs: 120000,
    onEvent: () => {},
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeWebSocket,
  });

  assert.equal(FakeWebSocket.instances.length, 1);
  const ws = FakeWebSocket.instances[0];
  ws.triggerOpen();
  assert.equal(statuses.includes("connected"), true);
  assert.equal(ws.closed, false);

  // Tick 119s: socket should still be open
  t.mock.timers.tick(119000);
  assert.equal(ws.closed, false);

  // Tick remaining 1s (total 120s): socket closes and reports stale status
  t.mock.timers.tick(1000);
  assert.equal(ws.closed, true);
  assert.equal(statuses.includes("no messages for 120s, reconnecting"), true);
  assert.equal(statuses[statuses.length - 1], "disconnected, retrying in 1s");

  // Reconnect backoff fires after 1s
  t.mock.timers.tick(1000);
  assert.equal(FakeWebSocket.instances.length, 2);

  stop();
  t.mock.timers.reset();
});

test("messages reset the stale timer so active feeds remain connected", (t) => {
  t.mock.timers.enable();
  FakeWebSocket.instances = [];
  const statuses = [];
  const events = [];

  const stop = connect({
    staleMs: 5000,
    onEvent: (ev) => events.push(ev),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: FakeWebSocket,
  });

  const ws = FakeWebSocket.instances[0];
  ws.triggerOpen();

  // Tick 4000ms: still open
  t.mock.timers.tick(4000);
  assert.equal(ws.closed, false);

  // Incoming message resets the 5s timer
  ws.triggerMessage(JSON.stringify({ txType: "ping" }));

  // Tick another 4000ms (total 8000ms, but only 4000ms since message): still open!
  t.mock.timers.tick(4000);
  assert.equal(ws.closed, false);

  // Tick 1000ms more (5000ms since message): closes!
  t.mock.timers.tick(1000);
  assert.equal(ws.closed, true);
  assert.equal(statuses.includes("no messages for 5s, reconnecting"), true);

  stop();
  t.mock.timers.reset();
});
