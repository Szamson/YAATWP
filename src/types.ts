// Shared DTO & Command Model Types for Wedding Seating App
// --------------------------------------------------------
// These types are derived from database row definitions (src/db/database.types.ts)
// and shaped according to the REST API plan. Each DTO either:
//  - Picks or omits fields from a Supabase row type (Tables<...>)
//  - Refines JSONB embedded structures (plan_data) into richer typed interfaces
//  - References database enums via Enums<...>
// Commands represent inbound request bodies; DTOs represent outbound responses.

import type { Tables, Enums } from "./db/database.types";

// Utility scalar aliases for semantic clarity.
export type UUID = string; // UUID v4 expected (runtime validation elsewhere)
export type ISO8601Timestamp = string; // e.g. '2025-10-29T12:34:56.789Z'
export type CursorToken = string; // Opaque, signed
export type IdempotencyKey = UUID; // Header value; alias retained for documentation

// Generic paginated response wrapper.
export interface PaginatedDTO<T> {
  items: T[];
  next_cursor?: CursorToken | null;
}

// Standard API error envelope.
export interface ApiErrorDTO {
  error: {
    code: string; // Machine-readable code (e.g. EVENT_NOT_FOUND)
    message: string; // Human readable description
    details?: Record<string, unknown>; // Optional structured metadata
  };
}

// --------------------------------------------------------
// Profile
// --------------------------------------------------------
export type ProfileDTO = Pick<
  Tables<"profiles">,
  "user_id" | "display_name" | "avatar_url" | "created_at" | "updated_at"
>;

export interface UpdateProfileCommand {
  display_name: string; // Required 1..120 chars
  avatar_url?: string | null;
}

// --------------------------------------------------------
// Embedded Plan Data (stored in events.plan_data & snapshots.plan_data JSONB)
// --------------------------------------------------------
// The database stores plan_data as JSON (typed as Json). We refine that shape here.
// Runtime validation (e.g., zod) should enforce these contracts when reading/writing.

export interface SeatAssignmentDTO {
  seat_no: number; // 1-based seat number within table capacity
  guest_id?: string; // Undefined if seat empty
}

export interface GuestDTO {
  id: string;
  name: string; // Required <=150 chars
  note?: string; // Dietary, etc.
  tag?: string; // Group label
  rsvp?: string; // Canonicalized RSVP status string (e.g. Yes/No/Maybe)
}

export interface TableDTO {
  id: string;
  shape: Enums<"table_shape_enum">;
  capacity: number; // >0
  label?: string; // Display label ("Table 1")
  start_index: number; // Seat numbering start (>=1)
  head_seat: number; // Seat considered head (1..capacity)
  seats: SeatAssignmentDTO[]; // Length <= capacity; missing entries treated as empty
}

export interface PlanSettingsDTO {
  color_palette: string; // e.g. 'default'
}

export interface PlanDataDTO {
  tables: TableDTO[];
  guests: GuestDTO[];
  settings: PlanSettingsDTO;
}

// Public (sanitized) guest variant – may omit sensitive fields when include_pii=false.
export interface PublicGuestDTO extends Pick<GuestDTO, "id" | "name" | "tag" | "rsvp"> {
  note?: string; // Present only if share link allows PII
}

export interface PublicPlanDataDTO extends Omit<PlanDataDTO, "guests"> {
  guests: PublicGuestDTO[];
}

// --------------------------------------------------------
// Events
// --------------------------------------------------------
export type DBEventRow = Tables<"events">;

export interface EventDTO {
  id: UUID;
  owner_id: UUID;
  name: string;
  event_date: string | null; // 'YYYY-MM-DD' or null
  grid: { rows: number; cols: number }; // Derived from grid_rows / grid_cols
  plan_data: PlanDataDTO; // Refined JSONB
  autosave_version: number;
  lock: LockStatusDTO; // Derived from lock_held_by / lock_expires_at
  created_at: ISO8601Timestamp;
  updated_at: ISO8601Timestamp;
  deleted_at?: ISO8601Timestamp | null; // Present if soft-deleted
}

// Light summary (list view) – excludes heavy plan_data by default.
export interface EventSummaryDTO extends Omit<EventDTO, "plan_data" | "lock"> {
  // Optional inclusion flags allow projection; absent by default.
  plan_data?: PlanDataDTO;
  lock?: LockStatusDTO;
}

export interface CreateEventCommand {
  name: string; // 1..150 chars
  event_date?: string | null; // Optional
  grid_rows: number; // >0
  grid_cols: number; // >0
}

export interface UpdateEventCommand {
  name?: string;
  event_date?: string | null;
  grid_rows?: number; // Structural change may trigger snapshot
  grid_cols?: number; // Structural change may trigger snapshot
}

// Empty body marker for restore endpoint – represented as an object type.
export type RestoreEventCommand = Record<string, never>; // Explicitly no properties

// --------------------------------------------------------
// Plan Mutation Commands & Operations (Undo/Redo capable)
// --------------------------------------------------------
export interface BulkPlanOpsCommand {
  version: number; // Expected current autosave_version (mirrors If-Match header usage)
  ops: PlanOperation[];
}

// Seat reference used in multiple ops.
export interface SeatRefDTO {
  table_id: string;
  seat_no: number;
}

// Discriminated union representing atomic plan modifications.
export type PlanOperation =
  | {
      op: "add_table";
      table: TableDTO;
    }
  | {
      op: "update_table";
      id: string;
      patch: Partial<Omit<TableDTO, "id" | "seats">> & { capacity?: number };
    }
  | {
      op: "remove_table";
      id: string;
    }
  | {
      op: "add_guest";
      guest: GuestDTO;
    }
  | {
      op: "update_guest";
      id: string;
      patch: Partial<Omit<GuestDTO, "id">>;
    }
  | {
      op: "remove_guest";
      id: string;
    }
  | {
      op: "assign_guest_seat";
      guest_id: string;
      table_id: string;
      seat_no?: number; // seat_no optional for random assignment
    }
  | {
      op: "swap_seats";
      a: SeatRefDTO;
      b: SeatRefDTO;
    }
  | {
      op: "move_guest_table";
      guest_id: string;
      to_table_id: string;
      seat_no?: number;
    }
  | {
      op: "change_seat_order_settings";
      table_id: string;
      start_index: number;
      head_seat: number;
      direction?: "clockwise";
    };

// Single-operation command shortcuts mirroring dedicated endpoints.
export type CreateTableCommand = Omit<TableDTO, "id" | "seats">; // seats array auto-initialized empty; id generated server-side
export interface UpdateTableCommand extends Partial<Omit<TableDTO, "id" | "seats">> {
  capacity?: number; // Triggers overflow validation
}
export type DeleteTableCommand = Record<string, never>; // Path-driven marker

export type AddGuestCommand = Omit<GuestDTO, "id">;
export type UpdateGuestCommand = Partial<Omit<GuestDTO, "id">>;
export type DeleteGuestCommand = Record<string, never>; // Path-driven marker

export interface AssignGuestSeatCommand {
  guest_id: string;
  table_id: string;
}
export interface SeatSwapCommand {
  a: SeatRefDTO;
  b: SeatRefDTO;
}
export interface ChangeSeatOrderCommand {
  table_id: string;
  start_index: number;
  head_seat: number;
  direction?: "clockwise";
}

// --------------------------------------------------------
// Locking
// --------------------------------------------------------
export interface AcquireLockCommand {
  minutes?: number;
}
export type ReleaseLockCommand = Record<string, never>; // Path-driven marker
export interface LockStatusDTO {
  held_by: UUID | null;
  expires_at: ISO8601Timestamp | null;
}
export type EventLockDTO = LockStatusDTO; // Alias for clarity within EventDTO

// --------------------------------------------------------
// Snapshots
// --------------------------------------------------------
export type DBSnapshotRow = Tables<"snapshots">;

export type SnapshotDTO = Pick<
  DBSnapshotRow,
  "id" | "event_id" | "created_at" | "created_by" | "is_manual" | "label" | "previous_snapshot_id"
>;
export interface SnapshotDetailDTO extends SnapshotDTO {
  plan_data: PlanDataDTO;
}
export interface CreateSnapshotCommand {
  label?: string;
}
export type RestoreSnapshotCommand = Record<string, never>; // Path-driven marker

// --------------------------------------------------------
// Share Links & Public Access
// --------------------------------------------------------
export type DBShareLinkRow = Tables<"share_links">;

export interface ShareLinkDTO
  extends Pick<
    DBShareLinkRow,
    | "id"
    | "event_id"
    | "token"
    | "expires_at"
    | "include_pii"
    | "revoked_at"
    | "created_at"
    | "created_by"
    | "last_accessed_at"
  > {
  url: string; // Computed externally (e.g., `${origin}/share/${token}`)
}

export interface CreateShareLinkCommand {
  password?: string; // Optional; min length 8 (runtime validation)
  expires_at?: ISO8601Timestamp | null;
  include_pii?: boolean; // Default false
}

export interface UpdateShareLinkCommand {
  password?: string; // Empty string => remove password protection
  expires_at?: ISO8601Timestamp | null;
  include_pii?: boolean;
}

export type RevokeShareLinkCommand = Record<string, never>; // Path-driven marker

export interface ShareLinkAuthCommand {
  password: string;
}
export interface ShareLinkAuthResultDTO {
  access_token: string;
  expires_in: number;
}

// Public event view (sanitized). Mirror of EventDTO with PublicPlanData.
export interface PublicEventViewDTO extends Omit<EventDTO, "plan_data"> {
  plan_data: PublicPlanDataDTO;
}

// --------------------------------------------------------
// Share Link Access Logs
// --------------------------------------------------------
export type ShareLinkAccessLogDTO = Pick<
  Tables<"access_logs">,
  "id" | "event_id" | "share_link_id" | "accessed_at" | "geo_country" | "user_agent" | "pii_exposed"
>;

// --------------------------------------------------------
// Audit Log
// --------------------------------------------------------
export type AuditLogEntryDTO = Pick<
  Tables<"audit_log">,
  "id" | "event_id" | "share_link_id" | "user_id" | "action_type" | "details" | "created_at"
>;

// --------------------------------------------------------
// Guest Imports
// --------------------------------------------------------
export type GuestImportStatusDTO = Pick<
  Tables<"guest_imports">,
  | "id"
  | "event_id"
  | "user_id"
  | "status"
  | "row_count"
  | "duplicate_count"
  | "error_count"
  | "started_at"
  | "completed_at"
  | "audit_trail"
>;

export interface UploadGuestImportMetaCommand {
  consent_text: string;
}

export interface DuplicateDecisionDTO {
  group_id: string; // Identifier for duplicate group cluster
  action: "merge" | "reject";
  keep_id?: string; // Required when action=merge to indicate kept guest
}

export interface ResolveDuplicatesCommand {
  decisions: DuplicateDecisionDTO[];
}
export type FinalizeImportCommand = Record<string, never>; // Path-driven marker

// Optional internal representation of import error rows (for CSV/XLSX streaming).
export interface ImportErrorRowDTO {
  row_number: number;
  field: string;
  error: string;
}

// --------------------------------------------------------
// Flattened Guest Projection
// --------------------------------------------------------
export interface GuestListItemDTO extends Pick<GuestDTO, "id" | "name" | "tag" | "rsvp"> {
  table_id?: string; // Present if seated
  seat_no?: number; // Present if seated
  unseated: boolean; // Convenience flag
}

// --------------------------------------------------------
// Exports
// --------------------------------------------------------
export interface CreateExportCommand {
  type: "pdf" | "png" | "xlsx" | "csv";
  include_notes?: boolean; // default false
  orientation?: "landscape" | "portrait"; // default landscape for PDF/PNG
}

export interface ExportStatusDTO {
  export_id: UUID;
  status: "pending" | "completed" | "failed";
  download_url?: string; // Present when completed
}

// --------------------------------------------------------
// Data Requests (DSAR)
// --------------------------------------------------------
export interface CreateDataRequestCommand {
  type: Enums<"data_request_type_enum">;
  event_id?: UUID | null; // Null for account-wide request
}

export type DataRequestDTO = Pick<
  Tables<"data_requests">,
  "id" | "user_id" | "event_id" | "type" | "status" | "requested_at" | "processed_at" | "result_url"
>;

// --------------------------------------------------------
// Analytics Events
// --------------------------------------------------------
export interface AnalyticsEventCommandItem {
  event_type: Enums<"analytics_event_type_enum">;
  event_id?: UUID | null;
  metadata?: Record<string, unknown>; // Sanitized server-side; PII stripped
}

export interface AnalyticsEventIngestCommand {
  events: AnalyticsEventCommandItem[];
}
export interface AnalyticsIngestResultDTO {
  accepted: number;
}

// --------------------------------------------------------
// Admin Flags
// --------------------------------------------------------
export type AdminFlagsDTO = Pick<
  Tables<"admin_flags">,
  "user_id" | "max_manual_snapshots" | "rate_limit_exports_daily" | "created_at" | "updated_at"
>;

// --------------------------------------------------------
// Health
// --------------------------------------------------------
export interface HealthDTO {
  status: "ok";
  time: ISO8601Timestamp;
  build?: { version: string; commit: string };
}

// --------------------------------------------------------
// Helper: derive EventDTO from DB row at runtime (illustrative, not runtime code)
// --------------------------------------------------------
// Example conversion comment (not executed):
// function mapEventRow(row: DBEventRow): EventDTO {
//   return {
//     id: row.id,
//     owner_id: row.owner_id,
//     name: row.name,
//     event_date: row.event_date,
//     grid: { rows: row.grid_rows, cols: row.grid_cols },
//     plan_data: row.plan_data as PlanDataDTO, // validated prior to casting
//     autosave_version: row.autosave_version,
//     lock: { held_by: row.lock_held_by, expires_at: row.lock_expires_at },
//     created_at: row.created_at,
//     updated_at: row.updated_at,
//     deleted_at: row.deleted_at,
//   };
// }

// --------------------------------------------------------
// End of types
// --------------------------------------------------------
