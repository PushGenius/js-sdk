# @pushgenius/javascript

Send push notifications and manage users from your server with the [PushGenius REST API](https://pushgeni.us/docs/api). No dependencies; runs on Node.js 20+, Bun and Deno.

For apps and websites, use the [mobile SDKs](https://pushgeni.us/docs/sdks) and the [Web SDK](https://pushgeni.us/docs/web) instead. This package needs your REST API key, which must never ship to a browser or an app.

## Install

```sh
npm install @pushgenius/javascript
```

## Set up

Find your app ID and REST API key in the dashboard under Settings.

```js
import { BigBrain } from "@pushgenius/javascript";

const bigBrain = new BigBrain({
  appId: process.env.PUSHGENIUS_APP_ID,
  apiKey: process.env.PUSHGENIUS_API_KEY,
});
```

The package is an ES module. From CommonJS, `require("@pushgenius/javascript")` works on Node.js 22.12 and later.

## Send a notification

```js
const { id, errors } = await bigBrain.notifications.create({
  headings: { en: "Your order shipped" },
  contents: { en: "Tap to track it." },
  data: { order_id: "42" },
  include_aliases: { external_id: ["user-123"] },
});
```

`external_id` is the ID your app passed to `BigBrain.login`. `data` reaches the app as the notification's `additionalData`.

If nobody matches the targeting, `create` still resolves: `id` is empty and `errors` says why. That's usually a user who hasn't opened the app since installing it, so log it rather than treating it as a failure.

### Targeting

Use exactly one. With none, the message goes to everyone subscribed.

```js
{ include_aliases: { external_id: ["user-123", "user-456"] } }
{ included_segments: ["Subscribed Users"], excluded_segments: ["Churned"] }
{ filters: [{ field: "tag", key: "plan", relation: "=", value: "pro" }] }
{ include_subscription_ids: ["5c2f…"] }
```

### Schedule, or deliver in each user's timezone

```js
await bigBrain.notifications.create({
  contents: { en: "Your weekly summary is ready." },
  included_segments: ["Subscribed Users"],
  send_after: "2026-11-27T15:00:00Z",
  delayed_option: "timezone",
  delivery_time_of_day: "9:00AM",
});
```

### Check delivery, list, cancel

```js
const n = await bigBrain.notifications.get(id);
console.log(n.successful, n.received, n.converted); // sent, received, clicked

const { notifications } = await bigBrain.notifications.list({ limit: 20 });
for await (const n of bigBrain.notifications.listAll()) {
  // every notification, newest first
}

await bigBrain.notifications.cancel(id);
```

## Users

Look users up and update them by any alias, most often `external_id`.

```js
const user = await bigBrain.users.get("external_id", "user-123");

await bigBrain.users.update("external_id", "user-123", {
  properties: { tags: { plan: "pro" }, language: "en" },
});

await bigBrain.users.addAliases("external_id", "user-123", { crm_id: "C-88412" });

await bigBrain.users.create({
  identity: { external_id: "user-789" },
  properties: { tags: { source: "import" } },
});

await bigBrain.users.delete("external_id", "user-123");
```

`bigBrain.devices` covers the older per-device endpoints (`/players`). The SDKs register devices themselves, so most backends never need it.

## Errors and retries

Failed requests throw a `PushGeniusError` with the HTTP `status` and the API's `errors`:

```js
import { PushGeniusError } from "@pushgenius/javascript";

try {
  await bigBrain.users.get("external_id", "nobody");
} catch (err) {
  if (err instanceof PushGeniusError && err.status === 404) {
    // no such user
  } else {
    throw err;
  }
}
```

Network errors, timeouts, 429s and 5xx responses are retried twice with backoff. Every `notifications.create` call gets an idempotency key, so a retry can never send the same notification twice. To make your own retries safe as well (a job queue re-running a task, say), pass a key that identifies the message:

```js
await bigBrain.notifications.create({ ..., idempotency_key: `order-${orderId}-shipped` });
```

## Options

| Option | Default | |
| --- | --- | --- |
| `appId` | required | Dashboard → Settings |
| `apiKey` | required | REST API key, Dashboard → Settings |
| `host` | `https://api.pushgeni.us` | |
| `timeout` | `30000` | Per attempt, in milliseconds |
| `maxRetries` | `2` | |
| `fetch` | global `fetch` | For tests or a custom agent |

## TypeScript

Types are included. Request and response fields use the API's snake_case names, so the [REST API docs](https://pushgeni.us/docs/api) apply as written.

```ts
import type { CreateNotificationParams, User } from "@pushgenius/javascript";
```
