import { test } from "node:test";
import assert from "node:assert/strict";
import { BigBrain, PushGenius, PushGeniusError } from "../dist/index.js";

const APP_ID = "8a0c7a5e-4f1e-4d7b-9a63-2d6f1b0c9e11";

/** A fetch that records each request and answers from the queued responses in order. */
function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body && JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, body, headers } = next ?? {};
    return new Response(body === undefined ? "" : JSON.stringify(body), { status, headers });
  };
  fn.calls = calls;
  return fn;
}

function client(fetch, options = {}) {
  return new BigBrain({ appId: APP_ID, apiKey: "secret", fetch, ...options });
}

test("creates a notification with the app ID, auth header and an idempotency key", async () => {
  const fetch = fakeFetch({ body: { id: "n1", external_id: null } });
  const result = await client(fetch).notifications.create({
    headings: { en: "Shipped" },
    contents: { en: "Tap to track" },
    include_aliases: { external_id: ["user-123"] },
  });
  assert.deepEqual(result, { id: "n1", external_id: null });
  const [call] = fetch.calls;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://api.pushgeni.us/notifications");
  assert.equal(call.headers.Authorization, "Key secret");
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.equal(call.body.app_id, APP_ID);
  assert.deepEqual(call.body.include_aliases, { external_id: ["user-123"] });
  assert.match(call.body.idempotency_key, /^[0-9a-f-]{36}$/);
});

test("keeps a caller's idempotency key and reuses it across retries", async () => {
  const fetch = fakeFetch({ status: 503 }, { body: { id: "n1" } });
  await client(fetch).notifications.create({ contents: { en: "Hi" }, idempotency_key: "order-42-shipped" });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].body.idempotency_key, "order-42-shipped");
  assert.equal(fetch.calls[1].body.idempotency_key, "order-42-shipped");
});

test("generated idempotency key is the same on every retry of one call", async () => {
  const fetch = fakeFetch(new TypeError("fetch failed"), { body: { id: "n1" } });
  await client(fetch).notifications.create({ contents: { en: "Hi" } });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].body.idempotency_key, fetch.calls[1].body.idempotency_key);
});

test("resolves, not throws, when nobody matches the targeting", async () => {
  const fetch = fakeFetch({ body: { id: "", errors: ["All included players are not subscribed"] } });
  const result = await client(fetch).notifications.create({ contents: { en: "Hi" }, include_aliases: { external_id: ["nobody"] } });
  assert.equal(result.id, "");
  assert.deepEqual(result.errors, ["All included players are not subscribed"]);
});

test("throws PushGeniusError with the API's message and status", async () => {
  const fetch = fakeFetch({ status: 401, body: { errors: ["Invalid or missing API key"] } });
  await assert.rejects(client(fetch).notifications.get("n1"), (err) => {
    assert.ok(err instanceof PushGeniusError);
    assert.equal(err.status, 401);
    assert.equal(err.message, "Invalid or missing API key");
    assert.deepEqual(err.errors, ["Invalid or missing API key"]);
    return true;
  });
  assert.equal(fetch.calls.length, 1, "4xx is not retried");
});

test("handles an error body that isn't JSON", async () => {
  const fetch = async () => new Response("Bad Gateway", { status: 502 });
  await assert.rejects(client(fetch, { maxRetries: 0 }).notifications.get("n1"), (err) => {
    assert.equal(err.status, 502);
    assert.equal(err.message, "PushGenius API returned 502");
    assert.equal(err.body, "Bad Gateway");
    return true;
  });
});

test("gives up after maxRetries", async () => {
  const fetch = fakeFetch({ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
  await assert.rejects(client(fetch, { maxRetries: 2 }).notifications.get("n1"), { status: 500 });
  assert.equal(fetch.calls.length, 3);
});

test("honors Retry-After on 429", async () => {
  const fetch = fakeFetch({ status: 429, headers: { "Retry-After": "1" } }, { body: { id: "n1" } });
  const started = Date.now();
  await client(fetch).notifications.get("n1");
  assert.ok(Date.now() - started >= 950);
});

test("doesn't retry a user create that has no alias to match on", async () => {
  const fetch = fakeFetch({ status: 503 });
  await assert.rejects(client(fetch).users.create({ properties: { tags: { plan: "pro" } } }), { status: 503 });
  assert.equal(fetch.calls.length, 1);
});

test("reports a timeout", async () => {
  // A real request's socket keeps Node running until the timeout fires; this timer stands in for it.
  const fetch = (url, init) =>
    new Promise((_, reject) => {
      const socket = setTimeout(() => {}, 5000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(socket);
        reject(init.signal.reason);
      });
    });
  await assert.rejects(client(fetch, { timeout: 20, maxRetries: 0 }).notifications.get("n1"), {
    name: "PushGeniusError",
    message: "Request timed out after 20ms",
  });
});

test("lists notifications with paging, and listAll walks every page", async () => {
  const page = (n, start) => ({
    body: { total_count: n, offset: start, limit: 50, notifications: Array.from({ length: n }, (_, i) => ({ id: `n${start + i}` })) },
  });
  const fetch = fakeFetch(page(50, 0), page(3, 50));
  const ids = [];
  for await (const n of client(fetch).notifications.listAll()) ids.push(n.id);
  assert.equal(ids.length, 53);
  assert.equal(fetch.calls[0].url, `https://api.pushgeni.us/notifications?app_id=${APP_ID}&limit=50&offset=0`);
  assert.equal(fetch.calls[1].url, `https://api.pushgeni.us/notifications?app_id=${APP_ID}&limit=50&offset=50`);
});

test("cancels a notification", async () => {
  const fetch = fakeFetch({ body: { success: true } });
  assert.deepEqual(await client(fetch).notifications.cancel("n 1"), { success: true });
  assert.equal(fetch.calls[0].method, "DELETE");
  assert.equal(fetch.calls[0].url, "https://api.pushgeni.us/notifications/n%201");
});

test("user calls use the alias in the path and encode it", async () => {
  const user = { identity: { pushgenius_id: "u1", external_id: "a/b" }, properties: { tags: {} }, subscriptions: [] };
  const fetch = fakeFetch(...Array(6).fill({ body: user }));
  const users = client(fetch).users;
  await users.create({ identity: { external_id: "a/b" } });
  await users.get("external_id", "a/b");
  await users.update("external_id", "a/b", { properties: { tags: { plan: "pro" } } });
  await users.addAliases("external_id", "a/b", { crm_id: "C-1" });
  await users.addSubscription("external_id", "a/b", { type: "AndroidPush", token: "tok" });
  await users.delete("external_id", "a/b");
  const base = `https://api.pushgeni.us/apps/${APP_ID}/users`;
  assert.deepEqual(
    fetch.calls.map((c) => `${c.method} ${c.url}`),
    [
      `POST ${base}`,
      `GET ${base}/by/external_id/a%2Fb`,
      `PATCH ${base}/by/external_id/a%2Fb`,
      `POST ${base}/by/external_id/a%2Fb/identity`,
      `POST ${base}/by/external_id/a%2Fb/subscriptions`,
      `DELETE ${base}/by/external_id/a%2Fb`,
    ],
  );
  assert.deepEqual(fetch.calls[3].body, { identity: { crm_id: "C-1" } });
  assert.deepEqual(fetch.calls[4].body, { subscription: { type: "AndroidPush", token: "tok" } });
});

test("device calls send the app ID", async () => {
  const fetch = fakeFetch({ body: { success: true, id: "s1" } }, { body: { success: true } });
  const devices = client(fetch).devices;
  await devices.create({ device_type: 1, identifier: "tok" });
  await devices.update("s1", { tags: { plan: "pro" } });
  assert.equal(fetch.calls[0].body.app_id, APP_ID);
  assert.equal(fetch.calls[1].method, "PUT");
  assert.equal(fetch.calls[1].url, "https://api.pushgeni.us/players/s1");
});

test("uses a custom host without a trailing slash", async () => {
  const fetch = fakeFetch({ body: { id: "n1" } });
  await client(fetch, { host: "http://localhost:3001/" }).notifications.get("n1");
  assert.equal(fetch.calls[0].url, "http://localhost:3001/notifications/n1");
});

test("requires appId and apiKey", () => {
  assert.throws(() => new BigBrain({ apiKey: "k" }), /appId is required/);
  assert.throws(() => new BigBrain({ appId: APP_ID }), /apiKey is required/);
});

test("refuses to run in a browser unless told to", () => {
  globalThis.window = {};
  globalThis.document = {};
  try {
    assert.throws(() => client(fakeFetch()), /visible to anyone/);
    assert.ok(client(fakeFetch(), { dangerouslyAllowBrowser: true }));
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

test("PushGenius is the same class", () => {
  assert.equal(PushGenius, BigBrain);
});
