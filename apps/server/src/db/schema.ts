import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { BookingWindow, DateOverride, EventKind, RoundRobinStrategy, WeeklyRule } from "@timebook/core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const created = () => ts("created_at").notNull().defaultNow();

export type Role = "owner" | "admin" | "member";

export const orgSettings = pgTable("org_settings", {
  id: integer("id").primaryKey().default(1),
  name: text("name").notNull().default("My Company"),
  brandColor: text("brand_color").notNull().default("#2563eb"),
  logoUrl: text("logo_url"),
  allowedEmailDomains: jsonb("allowed_email_domains").$type<string[]>().notNull().default([]),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    username: text("username").notNull(),
    passwordHash: text("password_hash"),
    role: text("role").$type<Role>().notNull().default("member"),
    timezone: text("timezone").notNull().default("UTC"),
    oidcSubject: text("oidc_subject"),
    welcomeMessage: text("welcome_message"),
    disabledAt: ts("disabled_at"),
    createdAt: created(),
  },
  (t) => [
    uniqueIndex("users_email_idx").on(t.email),
    uniqueIndex("users_username_idx").on(t.username),
    uniqueIndex("users_oidc_subject_idx").on(t.oidcSubject),
    // Exactly one owner per deployment.
    uniqueIndex("users_single_owner_idx").on(t.role).where(sql`${t.role} = 'owner'`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(), // sha256 of the cookie token
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: created(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** One-time tokens: invites and password resets. */
export const authTokens = pgTable("auth_tokens", {
  id: text("id").primaryKey(), // sha256 of the token
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").$type<"invite" | "password_reset">().notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: created(),
});

/** Short-lived state for OAuth/OIDC redirects. */
export const oauthStates = pgTable("oauth_states", {
  state: text("state").primaryKey(),
  provider: text("provider").notNull(),
  userId: uuid("user_id"),
  codeVerifier: text("code_verifier").notNull(),
  nonce: text("nonce"),
  returnTo: text("return_to"),
  expiresAt: ts("expires_at").notNull(),
});

export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: created(),
  },
  (t) => [uniqueIndex("teams_slug_idx").on(t.slug)],
);

export const teamMembers = pgTable(
  "team_members",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"manager" | "member">().notNull().default("member"),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.userId] })],
);

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    weekly: jsonb("weekly").$type<WeeklyRule[]>().notNull(),
    overrides: jsonb("overrides").$type<DateOverride[]>().notNull().default([]),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: created(),
  },
  (t) => [index("schedules_user_idx").on(t.userId)],
);

export type LocationType = "google_meet" | "microsoft_teams" | "link" | "phone" | "in_person" | "custom";
export interface EventLocation {
  type: LocationType;
  value?: string;
}
export interface EventQuestion {
  id: string;
  label: string;
  type: "text" | "textarea" | "phone" | "select" | "checkbox";
  required: boolean;
  options?: string[];
}

export const eventTypes = pgTable(
  "event_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind").$type<EventKind>().notNull().default("one_on_one"),
    durationMinutes: integer("duration_minutes").notNull().default(30),
    slotIntervalMinutes: integer("slot_interval_minutes"),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    minimumNoticeMinutes: integer("minimum_notice_minutes").notNull().default(240),
    bookingWindow: jsonb("booking_window").$type<BookingWindow | null>().default({ type: "rolling", days: 60 }),
    dailyLimit: integer("daily_limit"),
    weeklyLimit: integer("weekly_limit"),
    seats: integer("seats"),
    location: jsonb("location").$type<EventLocation>().notNull().default({ type: "link" }),
    questions: jsonb("questions").$type<EventQuestion[]>().notNull().default([]),
    reminderMinutes: jsonb("reminder_minutes").$type<number[]>().notNull().default([1440, 60]),
    rrStrategy: text("rr_strategy").$type<RoundRobinStrategy>().notNull().default("maximize_availability"),
    rrMaxImbalance: integer("rr_max_imbalance"),
    redirectUrl: text("redirect_url"),
    color: text("color").notNull().default("#2563eb"),
    hidden: boolean("hidden").notNull().default(false),
    active: boolean("active").notNull().default(true),
    createdAt: created(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("event_types_owner_slug_idx").on(t.ownerUserId, t.slug).where(sql`${t.ownerUserId} is not null`),
    uniqueIndex("event_types_team_slug_idx").on(t.teamId, t.slug).where(sql`${t.teamId} is not null`),
  ],
);

export const eventTypeHosts = pgTable(
  "event_type_hosts",
  {
    eventTypeId: uuid("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(0),
    weight: integer("weight").notNull().default(1),
    scheduleId: uuid("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
  },
  (t) => [primaryKey({ columns: [t.eventTypeId, t.userId] })],
);

export interface BookingLocation {
  type: LocationType;
  value?: string;
  joinUrl?: string;
}

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventTypeId: uuid("event_type_id")
      .notNull()
      .references(() => eventTypes.id, { onDelete: "cascade" }),
    hostUserId: uuid("host_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
    bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
    status: text("status").$type<"confirmed" | "cancelled">().notNull().default("confirmed"),
    title: text("title").notNull(),
    location: jsonb("location").$type<BookingLocation>().notNull(),
    inviteeName: text("invitee_name").notNull(),
    inviteeEmail: text("invitee_email").notNull(),
    inviteeTimezone: text("invitee_timezone").notNull(),
    answers: jsonb("answers").$type<Record<string, string | boolean>>().notNull().default({}),
    manageTokenHash: text("manage_token_hash").notNull(),
    /** Encrypted copy so reminder emails can include the manage link. */
    manageTokenEnc: text("manage_token_enc").notNull(),
    /** Stable iCalendar UID shared by a booking and its reschedules. */
    icsUid: text("ics_uid").notNull(),
    assignmentReason: text("assignment_reason"),
    cancelReason: text("cancel_reason"),
    cancelledBy: text("cancelled_by").$type<"host" | "invitee" | "admin">(),
    rescheduledFromId: uuid("rescheduled_from_id"),
    noShow: boolean("no_show").notNull().default(false),
    createdAt: created(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("bookings_host_start_idx").on(t.hostUserId, t.startAt),
    index("bookings_event_start_idx").on(t.eventTypeId, t.startAt),
    index("bookings_invitee_email_idx").on(t.inviteeEmail),
  ],
);

/** Every host of a booking (collective bookings have several). Used for busy-time checks. */
export const bookingHosts = pgTable(
  "booking_hosts",
  {
    bookingId: uuid("booking_id")
      .notNull()
      .references(() => bookings.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.userId] }), index("booking_hosts_user_idx").on(t.userId)],
);

export type CalendarProvider = "google" | "microsoft" | "ics";

export const calendarConnections = pgTable(
  "calendar_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").$type<CalendarProvider>().notNull(),
    accountEmail: text("account_email"),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: ts("token_expires_at"),
    icsUrlEnc: text("ics_url_enc"),
    lastError: text("last_error"),
    lastErrorAt: ts("last_error_at"),
    createdAt: created(),
  },
  (t) => [index("calendar_connections_user_idx").on(t.userId)],
);

export const calendars = pgTable(
  "calendars",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => calendarConnections.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    checkConflicts: boolean("check_conflicts").notNull().default(true),
    isDestination: boolean("is_destination").notNull().default(false),
    readOnly: boolean("read_only").notNull().default(false),
  },
  (t) => [uniqueIndex("calendars_conn_ext_idx").on(t.connectionId, t.externalId)],
);

export const bookingCalendarEvents = pgTable("booking_calendar_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  calendarId: uuid("calendar_id")
    .notNull()
    .references(() => calendars.id, { onDelete: "cascade" }),
  externalEventId: text("external_event_id").notNull(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: created(),
  },
  (t) => [uniqueIndex("api_keys_hash_idx").on(t.keyHash)],
);

export type WebhookEvent = "booking.created" | "booking.rescheduled" | "booking.cancelled";

export const webhooks = pgTable("webhooks", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scope: text("scope").$type<"user" | "org">().notNull().default("user"),
  url: text("url").notNull(),
  secretEnc: text("secret_enc").notNull(),
  events: jsonb("events").$type<WebhookEvent[]>().notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: created(),
});

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").$type<"pending" | "succeeded" | "failed">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    lastError: text("last_error"),
    createdAt: created(),
    deliveredAt: ts("delivered_at"),
  },
  (t) => [index("webhook_deliveries_webhook_idx").on(t.webhookId, t.createdAt)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    runAt: ts("run_at").notNull().defaultNow(),
    status: text("status").$type<"pending" | "running" | "done" | "failed">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    lockedAt: ts("locked_at"),
    dedupeKey: text("dedupe_key"),
    createdAt: created(),
  },
  (t) => [
    index("jobs_due_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_idx").on(t.dedupeKey).where(sql`${t.dedupeKey} is not null and ${t.status} = 'pending'`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorUserId: uuid("actor_user_id"),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    createdAt: created(),
  },
  (t) => [index("audit_log_created_idx").on(t.createdAt)],
);
