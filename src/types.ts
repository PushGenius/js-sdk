/** Request and response shapes for the PushGenius REST API. Fields are snake_case, as on the wire. */

/** Text per language code, for example `{ en: "Hello", es: "Hola" }`. */
export type LocalizedText = Record<string, string>;

export type WebPushType = "ChromePush" | "FirefoxPush" | "SafariPush";
export type SubscriptionType = "iOSPush" | "AndroidPush" | WebPushType;

export type Filter =
  | {
      field: "tag";
      key: string;
      relation: "=" | "!=" | "exists" | "not_exists" | ">" | "<";
      value?: string;
    }
  | {
      field: "last_session" | "session_count" | "country" | "language" | "app_version";
      relation: "=" | "!=" | ">" | "<";
      value: string;
      hours_ago?: string;
    }
  | { operator: "AND" | "OR" };

/** Users to send to, by alias label. `external_id` is the ID your app passes to `login`. */
export type IncludeAliases = {
  external_id?: string[];
  pushgenius_id?: string[];
  [label: string]: string[] | undefined;
};

export type CreateNotificationParams = {
  contents?: LocalizedText;
  headings?: LocalizedText;
  subtitle?: LocalizedText;
  /** Delivered to the app as the notification's `additionalData`. */
  data?: Record<string, unknown>;
  url?: string;
  web_url?: string;

  // Targeting: use exactly one. With none, the message goes to the "Subscribed Users" segment.
  include_aliases?: IncludeAliases;
  include_subscription_ids?: string[];
  included_segments?: string[];
  excluded_segments?: string[];
  filters?: Filter[];

  /** ISO 8601 time to hold the message until. */
  send_after?: string;
  delayed_option?: "timezone" | "last-active";
  /** With `delayed_option: "timezone"`, the local time each device receives it, like `"9:00AM"`. */
  delivery_time_of_day?: string;
  ttl?: number;
  priority?: number;
  collapse_id?: string;
  chrome_web_icon?: string;
  chrome_web_image?: string;

  /**
   * Sending twice with the same key creates one notification. The SDK makes one per call when you
   * leave it out, so its own retries never send twice; set it to make your own retries safe too.
   */
  idempotency_key?: string;
  [extra: string]: unknown;
};

export type CreateNotificationResponse = {
  /** Empty when nobody matched the targeting; `errors` then says why. */
  id: string;
  external_id?: string | null;
  errors?: string[] | Record<string, unknown>;
  invalid_aliases?: Record<string, string[]>;
  invalid_player_ids?: string[];
};

export type Notification = {
  id: string;
  app_id: string;
  headings: LocalizedText | null;
  contents: LocalizedText | null;
  data: Record<string, unknown> | null;
  url: string | null;
  send_after: string | null;
  /** Unix seconds. */
  queued_at: number;
  /** Unix seconds, or null while sending. */
  completed_at: number | null;
  canceled: boolean;
  /** Devices APNs, FCM or the browser push service accepted it for. */
  successful: number;
  failed: number;
  remaining: number;
  /** Devices that reported it arrived. */
  received: number;
  /** Devices where it was tapped or clicked. */
  converted: number;
};

export type NotificationList = {
  total_count: number;
  offset: number;
  limit: number;
  notifications: Notification[];
};

export type SubscriptionParams = {
  type: SubscriptionType;
  token: string;
  enabled?: boolean;
  notification_types?: number;
  sdk?: string;
  device_os?: string;
  device_model?: string;
  app_version?: string;
  web_auth?: string;
  web_p256?: string;
};

export type Subscription = {
  id: string;
  type: SubscriptionType;
  token: string | null;
  enabled: boolean;
  notification_types: number;
  sdk?: string | null;
  device_os?: string | null;
  device_model?: string | null;
};

export type UserProperties = {
  tags?: Record<string, string>;
  language?: string;
  timezone_id?: string;
  country?: string;
};

export type CreateUserParams = {
  identity?: Record<string, string>;
  properties?: UserProperties;
  subscriptions?: SubscriptionParams[];
};

export type UpdateUserParams = {
  /** Aliases to add, by label. */
  identity?: Record<string, string>;
  properties?: UserProperties;
};

export type User = {
  identity: {
    pushgenius_id: string;
    external_id?: string | null;
    [label: string]: string | null | undefined;
  };
  properties: {
    tags: Record<string, string>;
    language?: string | null;
    timezone_id?: string | null;
    country?: string | null;
  };
  subscriptions: Subscription[];
};

export type CreateDeviceParams = {
  /** 0 iOS, 1 Android, 5 Chrome, 8 Firefox. */
  device_type: number;
  identifier?: string;
  external_user_id?: string;
  tags?: Record<string, string>;
  language?: string;
  timezone_id?: string;
  game_version?: string;
  device_model?: string;
  device_os?: string;
  sdk?: string;
  notification_types?: number;
  web_auth?: string;
  web_p256?: string;
};

export type UpdateDeviceParams = Partial<Omit<CreateDeviceParams, "device_type">>;

export type Device = {
  id: string;
  identifier: string | null;
  device_type: number;
  session_count: number;
  language: string | null;
  timezone_id: string | null;
  device_os: string | null;
  device_model: string | null;
  tags: Record<string, string>;
  invalid_identifier: boolean;
  external_user_id: string | null;
};
