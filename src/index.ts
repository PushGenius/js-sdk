import type {
  CreateDeviceParams,
  CreateNotificationParams,
  CreateNotificationResponse,
  CreateUserParams,
  Device,
  Notification,
  NotificationList,
  SubscriptionParams,
  UpdateDeviceParams,
  UpdateUserParams,
  User,
} from "./types.js";

export type * from "./types.js";

export const VERSION = "0.1.0";

export type BigBrainOptions = {
  /** Dashboard → Settings. */
  appId: string;
  /** REST API key from Dashboard → Settings. Keep it on your server. */
  apiKey: string;
  /** Defaults to https://api.pushgeni.us. */
  host?: string;
  /** Per attempt, in milliseconds. Defaults to 30 seconds. */
  timeout?: number;
  /** Retries after a network error, a timeout, a 429 or a 5xx. Defaults to 2. */
  maxRetries?: number;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** The REST API key grants full access to your app, so browsers are refused unless you set this. */
  dangerouslyAllowBrowser?: boolean;
};

/** A non-2xx response from the API, or a request that never got one. */
export class PushGeniusError extends Error {
  /** HTTP status, or undefined when the request failed before a response arrived. */
  readonly status?: number;
  /** The API's `errors` array, when it sent one. */
  readonly errors: string[];
  readonly body?: unknown;

  constructor(message: string, init: { status?: number; errors?: string[]; body?: unknown; cause?: unknown } = {}) {
    super(message, { cause: init.cause });
    this.name = "PushGeniusError";
    this.status = init.status;
    this.errors = init.errors ?? [];
    this.body = init.body;
  }
}

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Whether repeating the request is harmless, so it can be retried. */
  idempotent: boolean;
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Server-side client for the PushGenius REST API.
 *
 * ```js
 * import { BigBrain } from "@pushgenius/javascript";
 *
 * const bigBrain = new BigBrain({ appId: process.env.PUSHGENIUS_APP_ID, apiKey: process.env.PUSHGENIUS_API_KEY });
 * await bigBrain.notifications.create({
 *   headings: { en: "Your order shipped" },
 *   contents: { en: "Tap to track it." },
 *   include_aliases: { external_id: ["user-123"] },
 * });
 * ```
 */
export class BigBrain {
  readonly appId: string;
  readonly notifications: Notifications;
  readonly users: Users;
  /** The older per-device endpoints. Most apps use `users` instead. */
  readonly devices: Devices;

  private readonly apiKey: string;
  private readonly host: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BigBrainOptions) {
    if (!options?.appId) throw new PushGeniusError("appId is required");
    if (!options.apiKey) throw new PushGeniusError("apiKey is required");
    if (typeof window !== "undefined" && typeof document !== "undefined" && !options.dangerouslyAllowBrowser) {
      throw new PushGeniusError(
        "@pushgenius/javascript runs on your server: the REST API key would be visible to anyone using this page. " +
          "In the browser, use the PushGenius Web SDK instead.",
      );
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (!fetchImpl) throw new PushGeniusError("No fetch available; pass one in options.fetch");

    this.appId = options.appId;
    this.apiKey = options.apiKey;
    this.host = (options.host ?? "https://api.pushgeni.us").replace(/\/+$/, "");
    this.timeout = options.timeout ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.fetchImpl = fetchImpl;
    this.notifications = new Notifications(this);
    this.users = new Users(this);
    this.devices = new Devices(this);
  }

  /** @internal */
  async request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const url = new URL(this.host + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Key ${this.apiKey}`,
      Accept: "application/json",
      "User-Agent": `pushgenius-javascript/${VERSION}`,
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const init = { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) };

    for (let attempt = 0; ; attempt++) {
      const canRetry = options.idempotent && attempt < this.maxRetries;
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.timeout) });
      } catch (cause) {
        if (canRetry) {
          await sleep(backoff(attempt));
          continue;
        }
        const timedOut = cause instanceof Error && cause.name === "TimeoutError";
        throw new PushGeniusError(
          timedOut ? `Request timed out after ${this.timeout}ms` : `Request failed: ${errorMessage(cause)}`,
          { cause },
        );
      }

      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      if (canRetry && RETRYABLE_STATUS.has(response.status)) {
        await sleep(retryAfter(response) ?? backoff(attempt));
        continue;
      }
      throw await toError(response);
    }
  }
}

/** Same class, for code that prefers the product name. */
export { BigBrain as PushGenius };

class Notifications {
  constructor(private readonly client: BigBrain) {}

  /**
   * Send, or schedule, a notification. When nobody matches the targeting it still resolves,
   * with an empty `id` and `errors` saying why.
   */
  create(params: CreateNotificationParams): Promise<CreateNotificationResponse> {
    const body = { ...params, app_id: this.client.appId, idempotency_key: params.idempotency_key ?? crypto.randomUUID() };
    return this.client.request("POST", "/notifications", { body, idempotent: true });
  }

  /** Sent and delivered counts update as devices report back. */
  get(id: string): Promise<Notification> {
    return this.client.request("GET", `/notifications/${encodeURIComponent(id)}`, { idempotent: true });
  }

  /** Newest first. `limit` is at most 50. */
  list(params: { limit?: number; offset?: number } = {}): Promise<NotificationList> {
    return this.client.request("GET", "/notifications", {
      query: { app_id: this.client.appId, limit: params.limit, offset: params.offset },
      idempotent: true,
    });
  }

  /** Every notification, newest first, fetched 50 at a time as you iterate. */
  async *listAll(): AsyncGenerator<Notification> {
    const limit = 50;
    for (let offset = 0; ; offset += limit) {
      const page = await this.list({ limit, offset });
      yield* page.notifications;
      if (page.notifications.length < limit) return;
    }
  }

  /** Stops a scheduled notification, or the rest of one still sending. */
  cancel(id: string): Promise<{ success: boolean }> {
    return this.client.request("DELETE", `/notifications/${encodeURIComponent(id)}`, { idempotent: true });
  }
}

class Users {
  constructor(private readonly client: BigBrain) {}

  private path(label: string, id: string, suffix = "") {
    return `/apps/${encodeURIComponent(this.client.appId)}/users/by/${encodeURIComponent(label)}/${encodeURIComponent(id)}${suffix}`;
  }

  /** Creates a user, or updates the one that already has any of the given aliases. */
  create(params: CreateUserParams): Promise<User> {
    return this.client.request("POST", `/apps/${encodeURIComponent(this.client.appId)}/users`, {
      body: params,
      // Without an alias to match on, a repeat would create a second user.
      idempotent: Boolean(params.identity && Object.keys(params.identity).length),
    });
  }

  /** Looks a user up by any alias, for example `get("external_id", "user-123")`. Throws a 404 error if none. */
  get(label: string, id: string): Promise<User> {
    return this.client.request("GET", this.path(label, id), { idempotent: true });
  }

  /** Sets tags, language, timezone or country, and adds aliases. */
  update(label: string, id: string, params: UpdateUserParams): Promise<User> {
    return this.client.request("PATCH", this.path(label, id), { body: params, idempotent: true });
  }

  /** Deletes the user and their subscriptions. */
  delete(label: string, id: string): Promise<{ success: boolean }> {
    return this.client.request("DELETE", this.path(label, id), { idempotent: true });
  }

  addAliases(label: string, id: string, identity: Record<string, string>): Promise<User> {
    return this.client.request("POST", this.path(label, id, "/identity"), { body: { identity }, idempotent: true });
  }

  /** Adds a device or browser subscription to the user, or moves it there if another user has it. */
  addSubscription(label: string, id: string, subscription: SubscriptionParams): Promise<User> {
    return this.client.request("POST", this.path(label, id, "/subscriptions"), {
      body: { subscription },
      idempotent: true,
    });
  }
}

class Devices {
  constructor(private readonly client: BigBrain) {}

  create(params: CreateDeviceParams): Promise<{ success: boolean; id: string }> {
    return this.client.request("POST", "/players", {
      body: { ...params, app_id: this.client.appId },
      idempotent: Boolean(params.identifier),
    });
  }

  get(id: string): Promise<Device> {
    return this.client.request("GET", `/players/${encodeURIComponent(id)}`, { idempotent: true });
  }

  update(id: string, params: UpdateDeviceParams): Promise<{ success: boolean }> {
    return this.client.request("PUT", `/players/${encodeURIComponent(id)}`, {
      body: { ...params, app_id: this.client.appId },
      idempotent: true,
    });
  }
}

async function toError(response: Response) {
  const text = await response.text().catch(() => "");
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // Not JSON; keep the text.
  }
  const raw = (body as { errors?: unknown } | undefined)?.errors;
  const errors = Array.isArray(raw) ? raw.map(String) : [];
  const message = errors[0] ?? `PushGenius API returned ${response.status}`;
  return new PushGeniusError(message, { status: response.status, errors, body });
}

function retryAfter(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : undefined;
}

function backoff(attempt: number) {
  return Math.min(500 * 2 ** attempt, 8000) * (0.5 + Math.random() / 2);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
