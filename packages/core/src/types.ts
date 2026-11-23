/**
 * Core scheduling types.
 *
 * All instants are UTC epoch milliseconds. Local wall-clock values (weekly hours,
 * date overrides) are interpreted in the schedule's IANA time zone.
 */

/** ISO weekday: Monday = 1 ... Sunday = 7. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A local wall-clock range such as { start: "09:00", end: "17:00" }. `end` may be "24:00". */
export interface TimeRange {
  start: string;
  end: string;
}

export interface WeeklyRule {
  day: Weekday;
  ranges: TimeRange[];
}

/** Replaces the weekly rule for one local date. An empty `ranges` array marks the day unavailable. */
export interface DateOverride {
  date: string; // YYYY-MM-DD
  ranges: TimeRange[];
}

export interface Schedule {
  timezone: string;
  weekly: WeeklyRule[];
  overrides: DateOverride[];
}

export interface Interval {
  start: number;
  end: number;
}

export type EventKind = "one_on_one" | "group" | "collective" | "round_robin";

export type BookingWindow =
  | { type: "rolling"; days: number }
  | { type: "range"; start: string; end: string }; // local dates, inclusive

export interface HostInput {
  hostId: string;
  schedule: Schedule;
  /** Busy time from calendars and from this host's other bookings (already expanded by their buffers). */
  busy: Interval[];
  /**
   * Confirmed bookings of *this* event type for this host. Used for daily/weekly limits
   * and, for group events, for seat counting.
   */
  eventBookings?: Interval[];
  /** Round robin only: higher number = preferred. Default 0. */
  priority?: number;
  /** Round robin only: share of meetings under equal distribution. Default 1. */
  weight?: number;
  /** Round robin only: bookings counted for fairness (any window the caller chooses). */
  fairnessCount?: number;
  /** Round robin only: when this host was last assigned a booking of this event type (booking creation time). */
  lastBookedAt?: number | null;
}

export interface SlotQuery {
  kind: EventKind;
  /** Compute slots that start within [rangeStart, rangeEnd). */
  rangeStart: number;
  rangeEnd: number;
  now: number;
  durationMinutes: number;
  /** Spacing between candidate start times. Defaults to the duration. */
  slotIntervalMinutes?: number | null;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  minimumNoticeMinutes?: number;
  bookingWindow?: BookingWindow | null;
  /** Max meetings of this event type per host per local day / ISO week. */
  dailyLimit?: number | null;
  weeklyLimit?: number | null;
  /** Group events: invitees per slot. */
  seats?: number | null;
  /** Round robin: hide hosts this many meetings (weighted) ahead of the least-loaded host. */
  maxImbalance?: number | null;
  hosts: HostInput[];
  /** When true, the result includes per-host reasons for every candidate that was rejected. */
  explain?: boolean;
}

export type BlockReason =
  | "PAST"
  | "MINIMUM_NOTICE"
  | "OUTSIDE_BOOKING_WINDOW"
  | "OUTSIDE_WORKING_HOURS"
  | "BUSY"
  | "BUFFER_CONFLICT"
  | "DAILY_LIMIT"
  | "WEEKLY_LIMIT"
  | "FULL"
  | "FAIRNESS";

export interface Slot {
  start: number;
  end: number;
  /** Hosts who can take this slot (collective: all hosts; round robin: eligible hosts). */
  hostIds: string[];
  /** Group events only. */
  seatsRemaining?: number;
}

export interface CandidateExplanation {
  start: number;
  end: number;
  available: boolean;
  hosts: { hostId: string; available: boolean; reasons: BlockReason[] }[];
}

export interface SlotResult {
  slots: Slot[];
  explanations?: CandidateExplanation[];
}

export type RoundRobinStrategy = "maximize_availability" | "equal_distribution";

export interface AssignmentCandidate {
  hostId: string;
  priority?: number;
  weight?: number;
  fairnessCount?: number;
  lastBookedAt?: number | null;
}

export interface Assignment {
  hostId: string;
  reason: string;
}
