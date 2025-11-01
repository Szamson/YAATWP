# API Endpoint Implementation Plan: Restore Event Snapshot

## 1. Endpoint Overview

This endpoint restores a previously saved snapshot of an event's seating plan. When invoked, it:

- Creates a new snapshot capturing the current event state (before restoration)
- Applies the target snapshot's `plan_data` to the event
- Increments the event's `autosave_version`
- Records a `snapshot_restored` audit log entry
- Returns the updated event with HTTP 202 Accepted status

This operation is idempotent-safe: restoring the same snapshot multiple times will produce the same plan state (though multiple snapshots and audit entries will be created).

**Use Cases:**

- Undo major plan changes by reverting to a known-good state
- Recover from accidental bulk deletions or modifications
- Compare different plan configurations by switching between snapshots

## 2. Request Details

- **HTTP Method**: POST
- **URL Structure**: `/api/events/{event_id}/snapshots/{snapshot_id}/restore`
- **Content-Type**: `application/json`
- **Authentication**: Required (Bearer token via Supabase Auth)

### Path Parameters

| Parameter     | Type | Required | Validation           | Description                           |
| ------------- | ---- | -------- | -------------------- | ------------------------------------- |
| `event_id`    | UUID | Yes      | Valid UUID v4 format | Target event to restore snapshot into |
| `snapshot_id` | UUID | Yes      | Valid UUID v4 format | Snapshot to restore from              |

### Query Parameters

None.

### Request Body

The request body must be an empty JSON object:

```typescript
RestoreSnapshotCommand = Record<string, never>;
```

**Example Request Body:**

```json
{}
```

**Validation Rules:**

- Body must parse as valid JSON
- Body must be an empty object (no properties allowed)
- Reject requests with any properties present

### Request Headers

| Header          | Required | Description                     |
| --------------- | -------- | ------------------------------- |
| `Authorization` | Yes      | Bearer token from Supabase Auth |
| `Content-Type`  | Yes      | Must be `application/json`      |

## 3. Used Types

### Command Models

```typescript
RestoreSnapshotCommand = Record<string, never>;
```

### Response DTOs

```typescript
EventDTO {
  id: UUID;
  owner_id: UUID;
  name: string;
  event_date: string | null;
  grid: { rows: number; cols: number };
  plan_data: PlanDataDTO;
  autosave_version: number;
  lock: LockStatusDTO;
  created_at: ISO8601Timestamp;
  updated_at: ISO8601Timestamp;
  deleted_at?: ISO8601Timestamp | null;
}

PlanDataDTO {
  tables: TableDTO[];
  guests: GuestDTO[];
  settings: PlanSettingsDTO;
}

LockStatusDTO {
  held_by: UUID | null;
  expires_at: ISO8601Timestamp | null;
}
```

### Database Types

```typescript
DBEventRow (from Tables<"events">)
DBSnapshotRow (from Tables<"snapshots">)
```

### Error Response

```typescript
ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

## 4. Response Details

### Success Response (202 Accepted)

The endpoint returns HTTP 202 to indicate the restore operation has been accepted and processed. The response includes the complete updated event.

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "owner_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "name": "Emma & James Wedding",
  "event_date": "2025-06-15",
  "grid": { "rows": 20, "cols": 30 },
  "plan_data": {
    "tables": [...],
    "guests": [...],
    "settings": { "color_palette": "default" }
  },
  "autosave_version": 42,
  "lock": {
    "held_by": null,
    "expires_at": null
  },
  "created_at": "2025-10-15T10:30:00Z",
  "updated_at": "2025-11-01T14:22:33Z"
}
```

**Key Response Fields:**

- `plan_data`: Contains the restored snapshot's plan configuration
- `autosave_version`: Incremented by 1 from previous version
- `updated_at`: Set to current timestamp
- `lock`: Current lock status (unchanged by restore)

### Error Responses

| Status Code | Error Code                | Scenario                                               |
| ----------- | ------------------------- | ------------------------------------------------------ |
| 400         | `INVALID_UUID`            | Invalid format for `event_id` or `snapshot_id`         |
| 400         | `INVALID_REQUEST_BODY`    | Request body contains properties or is malformed       |
| 400         | `SNAPSHOT_EVENT_MISMATCH` | Snapshot doesn't belong to specified event             |
| 400         | `CORRUPTED_SNAPSHOT_DATA` | Snapshot contains invalid plan_data structure          |
| 401         | `UNAUTHORIZED`            | Missing or invalid authentication token                |
| 403         | `FORBIDDEN`               | User is not the owner of the event                     |
| 403         | `EVENT_LOCKED`            | Event is locked by another user (optional enforcement) |
| 404         | `EVENT_NOT_FOUND`         | Event doesn't exist or is soft-deleted                 |
| 404         | `SNAPSHOT_NOT_FOUND`      | Snapshot doesn't exist                                 |
| 500         | `INTERNAL_SERVER_ERROR`   | Database transaction failure or unexpected error       |

**Example Error Response (404):**

```json
{
  "error": {
    "code": "SNAPSHOT_NOT_FOUND",
    "message": "The requested snapshot does not exist",
    "details": {
      "snapshot_id": "123e4567-e89b-12d3-a456-426614174000"
    }
  }
}
```

## 5. Data Flow

### High-Level Flow

```
1. Client sends POST /api/events/{event_id}/snapshots/{snapshot_id}/restore
2. Middleware authenticates user via Supabase Auth
3. API endpoint handler extracts path parameters
4. SnapshotService validates inputs and permissions
5. Begin database transaction:
   a. Create pre-restore snapshot of current event state
   b. Update event with snapshot's plan_data
   c. Increment autosave_version
   d. Insert audit_log entry (snapshot_restored)
   e. Commit transaction
6. Map database row to EventDTO
7. Return 202 with EventDTO
```

### Detailed Service Layer Flow

```typescript
// Service: SnapshotService.restoreSnapshot()

async restoreSnapshot(
  userId: UUID,
  eventId: UUID,
  snapshotId: UUID,
  supabase: SupabaseClient
): Promise<EventDTO>
```

**Steps:**

1. **Validate Path Parameters**
   - Check UUID format for `eventId` and `snapshotId`
   - Return 400 if invalid

2. **Fetch Target Event**
   - Query `events` table for `eventId`
   - Include `deleted_at IS NULL` filter
   - Return 404 if not found or soft-deleted

3. **Verify Ownership**
   - Check `event.owner_id === userId`
   - Return 403 if mismatch

4. **Check Lock Status (Optional)**
   - If `event.lock_held_by` exists and not current user
   - Check if `event.lock_expires_at > now()`
   - Return 403 with `EVENT_LOCKED` if locked by another user

5. **Fetch Target Snapshot**
   - Query `snapshots` table for `snapshotId`
   - Return 404 if not found

6. **Validate Snapshot Belongs to Event**
   - Check `snapshot.event_id === eventId`
   - Return 400 with `SNAPSHOT_EVENT_MISMATCH` if mismatch

7. **Validate Snapshot Plan Data**
   - Parse `snapshot.plan_data` as `PlanDataDTO`
   - Use Zod schema validation
   - Return 400 with `CORRUPTED_SNAPSHOT_DATA` if invalid

8. **Begin Transaction**

   **8a. Create Pre-Restore Snapshot**

   ```sql
   INSERT INTO snapshots (
     event_id,
     created_by,
     is_manual,
     label,
     plan_data,
     previous_snapshot_id
   ) VALUES (
     $1, $2, false,
     'Auto-snapshot before restore',
     $3, -- current event.plan_data
     $4  -- latest snapshot id
   )
   RETURNING id
   ```

   **8b. Update Event**

   ```sql
   UPDATE events
   SET
     plan_data = $1,              -- snapshot.plan_data
     autosave_version = autosave_version + 1,
     updated_at = now()
   WHERE id = $2
   RETURNING *
   ```

   **8c. Insert Audit Log**

   ```sql
   INSERT INTO audit_log (
     event_id,
     user_id,
     action_type,
     details
   ) VALUES (
     $1, $2, 'snapshot_restored',
     jsonb_build_object(
       'snapshot_id', $3,
       'snapshot_label', $4,
       'pre_restore_snapshot_id', $5
     )
   )
   ```

9. **Commit Transaction**
   - Rollback on any error

10. **Map to EventDTO**
    - Transform `DBEventRow` to `EventDTO`
    - Include grid transformation (rows/cols)
    - Include lock status transformation

11. **Return EventDTO with 202 Status**

### Database Interactions

| Operation                   | Table       | Type   | RLS Applied               |
| --------------------------- | ----------- | ------ | ------------------------- |
| Fetch event                 | `events`    | SELECT | Yes (owner check)         |
| Fetch snapshot              | `snapshots` | SELECT | Yes (via event ownership) |
| Create pre-restore snapshot | `snapshots` | INSERT | Yes                       |
| Update event                | `events`    | UPDATE | Yes (owner check)         |
| Insert audit log            | `audit_log` | INSERT | Yes                       |

## 6. Security Considerations

### Authentication

- **Requirement**: Valid Supabase Auth Bearer token
- **Implementation**: Use `context.locals.supabase` from Astro middleware
- **Failure Mode**: Return 401 Unauthorized if token missing/invalid

### Authorization

- **Ownership Check**: `event.owner_id === authenticated_user_id`
- **RLS Policies**: Supabase RLS enforces row-level permissions
- **Failure Mode**: Return 403 Forbidden if user doesn't own event

### Lock Enforcement (Optional)

- **Check**: If `lock_held_by` is set and not current user
- **Validation**: `lock_expires_at > now()`
- **Behavior**: Block restore if another user holds active lock
- **Rationale**: Prevents conflicting edits during collaborative sessions
- **Trade-off**: May need to allow owners to force-restore regardless of lock

### Input Validation

1. **UUID Validation**:
   - Use Zod schema: `z.string().uuid()`
   - Prevent injection attacks via malformed UUIDs

2. **Request Body Validation**:
   - Enforce empty object with Zod: `z.object({}).strict()`
   - Reject unexpected properties

3. **Snapshot Plan Data Validation**:
   - Validate against `PlanDataDTO` Zod schema before applying
   - Prevent corruption from malformed snapshot data
   - Check array sizes, required fields, type constraints

### Cross-Event Security

- **Threat**: User attempts to restore snapshot from Event A into Event B
- **Mitigation**: Validate `snapshot.event_id === event_id` from path
- **Impact**: Prevents unauthorized data copying between events

### Rate Limiting (Future Enhancement)

- Track restore frequency per user/event
- Apply rate limits via `admin_flags.rate_limit_exports_daily` (repurpose or create new flag)
- Prevent abuse/resource exhaustion

### GDPR/CCPA Compliance

- **PII Handling**: Snapshot restoration doesn't change consent model
- **Data Retention**: Pre-restore snapshots count toward retention policies
- **Audit Trail**: `audit_log` entry provides restoration trace for compliance

## 7. Error Handling

### Validation Errors (400 Bad Request)

| Error Code                | Condition                        | Response Message                                   |
| ------------------------- | -------------------------------- | -------------------------------------------------- |
| `INVALID_UUID`            | Path parameter not valid UUID v4 | "Invalid UUID format for event_id or snapshot_id"  |
| `INVALID_REQUEST_BODY`    | Request body not empty object    | "Request body must be an empty object"             |
| `SNAPSHOT_EVENT_MISMATCH` | `snapshot.event_id !== event_id` | "Snapshot does not belong to the specified event"  |
| `CORRUPTED_SNAPSHOT_DATA` | `plan_data` fails Zod validation | "Snapshot contains invalid or corrupted plan data" |

**Implementation Pattern**:

```typescript
try {
  z.string().uuid().parse(eventId);
} catch (error) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_UUID",
        message: "Invalid UUID format for event_id",
        details: { field: "event_id", value: eventId },
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}
```

### Authentication Errors (401 Unauthorized)

| Error Code     | Condition                      | Response Message          |
| -------------- | ------------------------------ | ------------------------- |
| `UNAUTHORIZED` | No auth token or invalid token | "Authentication required" |

**Implementation**: Handled by Astro middleware before reaching endpoint handler.

### Authorization Errors (403 Forbidden)

| Error Code     | Condition                    | Response Message                                                 |
| -------------- | ---------------------------- | ---------------------------------------------------------------- |
| `FORBIDDEN`    | User doesn't own event       | "You do not have permission to restore snapshots for this event" |
| `EVENT_LOCKED` | Event locked by another user | "Event is currently locked by another user"                      |

### Not Found Errors (404 Not Found)

| Error Code           | Condition                           | Response Message     |
| -------------------- | ----------------------------------- | -------------------- |
| `EVENT_NOT_FOUND`    | Event doesn't exist or soft-deleted | "Event not found"    |
| `SNAPSHOT_NOT_FOUND` | Snapshot doesn't exist              | "Snapshot not found" |

### Server Errors (500 Internal Server Error)

| Error Code              | Condition                                          | Response Message                                            |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `INTERNAL_SERVER_ERROR` | Database transaction failure, unexpected exception | "An unexpected error occurred while restoring the snapshot" |

**Implementation Pattern**:

```typescript
try {
  // Transaction logic
} catch (error) {
  console.error("Snapshot restore failed:", error);
  return new Response(
    JSON.stringify({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred while restoring the snapshot",
        details: { timestamp: new Date().toISOString() },
      },
    }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}
```

### Error Logging Strategy

1. **Client Errors (4xx)**: Log at INFO level with request context
2. **Server Errors (5xx)**: Log at ERROR level with full stack trace
3. **Audit Trail**: All successful restores logged to `audit_log` table
4. **Monitoring**: Track restore failure rate, response times, validation errors

## 8. Performance Considerations

### Database Performance

1. **Indexes Required**:
   - `events(id)` - Primary key (already indexed)
   - `events(owner_id)` - For ownership checks
   - `snapshots(id)` - Primary key (already indexed)
   - `snapshots(event_id)` - For fetching event snapshots
   - `events(deleted_at)` - For filtering soft-deleted events

2. **Query Optimization**:
   - Use single SELECT with owner check: `WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`
   - Avoid N+1 queries by fetching event and snapshot in parallel (when possible)

3. **Transaction Scope**:
   - Keep transaction short: only include write operations
   - Read event/snapshot outside transaction when possible
   - Use `RETURNING *` to avoid additional SELECT after UPDATE

### JSONB Performance

- **plan_data Size**: Large plans (100+ tables, 1000+ guests) may cause slowdowns
- **Serialization**: Minimize plan_data parsing/stringifying overhead
- **Mitigation**:
  - Consider plan_data size limits (e.g., max 2MB)
  - Use JSONB binary format (automatically handled by PostgreSQL)
  - Avoid redundant validation passes

### Snapshot Creation Overhead

- **Auto-Snapshot on Restore**: Creates additional snapshot each time
- **Storage Impact**: Snapshots table grows rapidly with frequent restores
- **Mitigation**:
  - Implement snapshot retention policy (delete old auto-snapshots)
  - Consider debouncing/coalescing rapid restores
  - Set `is_manual = false` to allow cleanup of auto-snapshots

### Response Time Target

- **Expected**: < 500ms for typical plan sizes (10 tables, 100 guests)
- **Acceptable**: < 2s for large plans (50 tables, 500 guests)
- **Bottlenecks**:
  - Snapshot plan_data validation (Zod schema)
  - JSONB serialization/deserialization
  - Transaction commit latency

### Concurrency

- **Race Condition**: Multiple restore operations on same event
- **Impact**: `autosave_version` may skip numbers, multiple pre-restore snapshots created
- **Mitigation**: Not critical; eventual consistency acceptable
- **Future Enhancement**: Optimistic locking with version check

### Caching Strategy

- **Events**: Not cached (always fetch fresh for ownership/lock checks)
- **Snapshots**: Not cached (immutable but infrequent access)
- **Future**: Consider caching frequently restored snapshots

## 9. Implementation Steps

### Step 1: Create Zod Validation Schemas

**File**: `src/lib/validation/snapshot.validation.ts`

```typescript
import { z } from "zod";

export const restoreSnapshotParamsSchema = z.object({
  event_id: z.string().uuid(),
  snapshot_id: z.string().uuid(),
});

export const restoreSnapshotBodySchema = z.object({}).strict();
```

### Step 2: Create SnapshotService

**File**: `src/lib/services/snapshot.service.ts`

**Methods to Implement**:

```typescript
class SnapshotService {
  /**
   * Restore a snapshot to an event
   * @throws {AppError} with appropriate status code and error code
   */
  async restoreSnapshot(userId: UUID, eventId: UUID, snapshotId: UUID, supabase: SupabaseClient): Promise<EventDTO>;

  /**
   * Create pre-restore snapshot (internal helper)
   */
  private async createPreRestoreSnapshot(
    eventId: UUID,
    userId: UUID,
    currentPlanData: PlanDataDTO,
    previousSnapshotId: UUID | null,
    supabase: SupabaseClient
  ): Promise<UUID>;

  /**
   * Validate snapshot plan data structure
   */
  private validatePlanData(planData: unknown): PlanDataDTO;
}
```

**Key Logic**:

1. Fetch and validate event (ownership, not deleted)
2. Fetch and validate snapshot (exists, belongs to event)
3. Validate snapshot plan_data structure
4. Begin transaction:
   - Create pre-restore snapshot
   - Update event with snapshot plan_data
   - Increment autosave_version
   - Insert audit log entry
5. Return mapped EventDTO

### Step 3: Create API Endpoint Handler

**File**: `src/pages/api/events/[event_id]/snapshots/[snapshot_id]/restore.ts`

```typescript
import type { APIRoute } from "astro";
import { SnapshotService } from "@/lib/services/snapshot.service";
import { restoreSnapshotParamsSchema, restoreSnapshotBodySchema } from "@/lib/validation/snapshot.validation";
import type { ApiErrorDTO, EventDTO } from "@/types";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    // 1. Extract authenticated user from middleware
    const supabase = context.locals.supabase;
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
          },
        } as ApiErrorDTO),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Validate path parameters
    const paramsResult = restoreSnapshotParamsSchema.safeParse(context.params);
    if (!paramsResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_UUID",
            message: "Invalid UUID format for event_id or snapshot_id",
            details: paramsResult.error.flatten(),
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Validate request body (must be empty object)
    const body = await context.request.json();
    const bodyResult = restoreSnapshotBodySchema.safeParse(body);
    if (!bodyResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_REQUEST_BODY",
            message: "Request body must be an empty object",
            details: bodyResult.error.flatten(),
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Call service layer
    const snapshotService = new SnapshotService();
    const restoredEvent = await snapshotService.restoreSnapshot(
      user.id,
      paramsResult.data.event_id,
      paramsResult.data.snapshot_id,
      supabase
    );

    // 5. Return 202 with EventDTO
    return new Response(JSON.stringify(restoredEvent), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Handle known AppError instances with specific status codes
    if (error instanceof AppError) {
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        } as ApiErrorDTO),
        { status: error.statusCode, headers: { "Content-Type": "application/json" } }
      );
    }

    // Handle unexpected errors
    console.error("Unexpected error in snapshot restore:", error);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "An unexpected error occurred while restoring the snapshot",
          details: { timestamp: new Date().toISOString() },
        },
      } as ApiErrorDTO),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
```

### Step 4: Create Custom Error Classes

**File**: `src/lib/errors/app-error.ts`

```typescript
export class AppError extends Error {
  constructor(
    public code: string,
    public message: string,
    public statusCode: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "AppError";
  }
}

// Factory functions for common errors
export class ErrorFactory {
  static eventNotFound(eventId: string): AppError {
    return new AppError("EVENT_NOT_FOUND", "Event not found", 404, { event_id: eventId });
  }

  static snapshotNotFound(snapshotId: string): AppError {
    return new AppError("SNAPSHOT_NOT_FOUND", "Snapshot not found", 404, { snapshot_id: snapshotId });
  }

  static forbidden(message: string): AppError {
    return new AppError("FORBIDDEN", message, 403);
  }

  static snapshotEventMismatch(): AppError {
    return new AppError("SNAPSHOT_EVENT_MISMATCH", "Snapshot does not belong to the specified event", 400);
  }

  static corruptedSnapshotData(): AppError {
    return new AppError("CORRUPTED_SNAPSHOT_DATA", "Snapshot contains invalid or corrupted plan data", 400);
  }
}
```

### Step 5: Implement Database Transaction Logic

**In SnapshotService.restoreSnapshot()**:

```typescript
// Begin transaction using Supabase transaction API or raw SQL
const { data: preRestoreSnapshot, error: snapshotError } = await supabase
  .from("snapshots")
  .insert({
    event_id: eventId,
    created_by: userId,
    is_manual: false,
    label: "Auto-snapshot before restore",
    plan_data: currentEvent.plan_data,
    previous_snapshot_id: latestSnapshotId, // fetch separately or pass as param
  })
  .select("id")
  .single();

if (snapshotError) throw new Error("Failed to create pre-restore snapshot");

const { data: updatedEvent, error: updateError } = await supabase
  .from("events")
  .update({
    plan_data: targetSnapshot.plan_data,
    autosave_version: currentEvent.autosave_version + 1,
    updated_at: new Date().toISOString(),
  })
  .eq("id", eventId)
  .select()
  .single();

if (updateError) throw new Error("Failed to update event");

const { error: auditError } = await supabase.from("audit_log").insert({
  event_id: eventId,
  user_id: userId,
  action_type: "snapshot_restored",
  details: {
    snapshot_id: snapshotId,
    snapshot_label: targetSnapshot.label,
    pre_restore_snapshot_id: preRestoreSnapshot.id,
  },
});

if (auditError) throw new Error("Failed to log audit entry");
```

### Step 6: Add Zod Schema for PlanDataDTO Validation

**File**: `src/lib/validation/plan-data.validation.ts`

```typescript
import { z } from "zod";

const seatAssignmentSchema = z.object({
  seat_no: z.number().int().positive(),
  guest_id: z.string().optional(),
});

const guestSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(150),
  note: z.string().optional(),
  tag: z.string().optional(),
  rsvp: z.string().optional(),
});

const tableSchema = z.object({
  id: z.string(),
  shape: z.enum(["round", "rectangular", "long"]),
  capacity: z.number().int().positive(),
  label: z.string().optional(),
  start_index: z.number().int().positive(),
  head_seat: z.number().int().positive(),
  seats: z.array(seatAssignmentSchema),
});

const planSettingsSchema = z.object({
  color_palette: z.string(),
});

export const planDataSchema = z.object({
  tables: z.array(tableSchema),
  guests: z.array(guestSchema),
  settings: planSettingsSchema,
});
```

### Step 7: Create EventDTO Mapper Utility

**File**: `src/lib/mappers/event.mapper.ts`

```typescript
import type { DBEventRow } from "@/db/database.types";
import type { EventDTO } from "@/types";

export class EventMapper {
  static toDTO(row: DBEventRow): EventDTO {
    return {
      id: row.id,
      owner_id: row.owner_id,
      name: row.name,
      event_date: row.event_date,
      grid: {
        rows: row.grid_rows,
        cols: row.grid_cols,
      },
      plan_data: row.plan_data as PlanDataDTO, // Already validated
      autosave_version: row.autosave_version,
      lock: {
        held_by: row.lock_held_by,
        expires_at: row.lock_expires_at,
      },
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
    };
  }
}
```

### Step 8: Add Unit Tests

**File**: `src/lib/services/__tests__/snapshot.service.test.ts`

**Test Cases**:

1. ✅ Successfully restores snapshot with valid inputs
2. ✅ Returns 404 when event doesn't exist
3. ✅ Returns 404 when snapshot doesn't exist
4. ✅ Returns 403 when user doesn't own event
5. ✅ Returns 400 when snapshot doesn't belong to event
6. ✅ Returns 400 when snapshot plan_data is corrupted
7. ✅ Creates pre-restore snapshot correctly
8. ✅ Increments autosave_version by 1
9. ✅ Creates audit log entry with correct action_type
10. ✅ Handles transaction rollback on error

### Step 9: Add Integration Tests

**File**: `tests/integration/api/events/snapshots/restore.test.ts`

**Test Scenarios**:

1. Full end-to-end restore flow with valid data
2. Restore with locked event (if lock enforcement enabled)
3. Concurrent restore attempts (race condition handling)
4. Restore with large plan_data (performance test)
5. Restore after event has been modified (version conflict)

### Step 10: Update API Documentation

**File**: `.ai/api-plan.md`

Update the endpoint documentation with:

- Detailed request/response examples
- Error code reference table
- Rate limiting notes (if implemented)
- Link to this implementation plan

### Step 11: Configure RLS Policies

Ensure Supabase RLS policies allow:

- Users to SELECT snapshots for their owned events
- Users to INSERT snapshots for their owned events
- Users to UPDATE events they own
- Users to INSERT audit_log entries

**Example RLS Policy** (Supabase SQL):

```sql
CREATE POLICY "Users can restore snapshots for owned events"
ON snapshots FOR SELECT
USING (
  event_id IN (
    SELECT id FROM events WHERE owner_id = auth.uid() AND deleted_at IS NULL
  )
);
```

### Step 12: Performance Testing & Optimization

1. **Benchmark Restore Time**:
   - Test with various plan_data sizes (small, medium, large)
   - Measure p50, p95, p99 latencies
   - Target: < 500ms for median case

2. **Database Query Analysis**:
   - Use `EXPLAIN ANALYZE` on restore queries
   - Verify index usage on `events(owner_id)`, `snapshots(event_id)`

3. **Load Testing**:
   - Simulate concurrent restores on same event
   - Verify transaction isolation prevents data corruption

### Step 13: Deploy & Monitor

1. **Deployment Checklist**:
   - ✅ Database migrations applied (if any indexes added)
   - ✅ Environment variables configured
   - ✅ RLS policies deployed to Supabase
   - ✅ API endpoint tested in staging environment

2. **Monitoring Setup**:
   - Track restore endpoint response times
   - Alert on 5xx error rate > 1%
   - Monitor snapshot table growth rate
   - Track autosave_version increments per event

3. **Post-Deployment Validation**:
   - Manual smoke test: Create event → Create snapshot → Restore snapshot
   - Verify audit log entries appear correctly
   - Check pre-restore snapshots are created

---

## Appendix: Example Service Implementation

```typescript
// src/lib/services/snapshot.service.ts

import type { SupabaseClient } from "@/db/supabase.client";
import type { EventDTO, UUID, PlanDataDTO } from "@/types";
import { EventMapper } from "@/lib/mappers/event.mapper";
import { ErrorFactory } from "@/lib/errors/app-error";
import { planDataSchema } from "@/lib/validation/plan-data.validation";

export class SnapshotService {
  async restoreSnapshot(userId: UUID, eventId: UUID, snapshotId: UUID, supabase: SupabaseClient): Promise<EventDTO> {
    // 1. Fetch event with ownership check
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .is("deleted_at", null)
      .single();

    if (eventError || !event) {
      throw ErrorFactory.eventNotFound(eventId);
    }

    if (event.owner_id !== userId) {
      throw ErrorFactory.forbidden("You do not have permission to restore snapshots for this event");
    }

    // 2. Check lock status (optional enforcement)
    if (event.lock_held_by && event.lock_held_by !== userId) {
      const lockExpiry = new Date(event.lock_expires_at);
      if (lockExpiry > new Date()) {
        throw ErrorFactory.forbidden("Event is currently locked by another user");
      }
    }

    // 3. Fetch target snapshot
    const { data: snapshot, error: snapshotError } = await supabase
      .from("snapshots")
      .select("*")
      .eq("id", snapshotId)
      .single();

    if (snapshotError || !snapshot) {
      throw ErrorFactory.snapshotNotFound(snapshotId);
    }

    // 4. Validate snapshot belongs to event
    if (snapshot.event_id !== eventId) {
      throw ErrorFactory.snapshotEventMismatch();
    }

    // 5. Validate snapshot plan_data structure
    const validationResult = planDataSchema.safeParse(snapshot.plan_data);
    if (!validationResult.success) {
      throw ErrorFactory.corruptedSnapshotData();
    }

    const restoredPlanData = validationResult.data;

    // 6. Get latest snapshot ID for chaining
    const { data: latestSnapshot } = await supabase
      .from("snapshots")
      .select("id")
      .eq("event_id", eventId)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    // 7. Begin transaction: create pre-restore snapshot
    const { data: preRestoreSnapshot, error: preRestoreError } = await supabase
      .from("snapshots")
      .insert({
        event_id: eventId,
        created_by: userId,
        is_manual: false,
        label: "Auto-snapshot before restore",
        plan_data: event.plan_data,
        previous_snapshot_id: latestSnapshot?.id || null,
      })
      .select("id")
      .single();

    if (preRestoreError) {
      throw new Error("Failed to create pre-restore snapshot");
    }

    // 8. Update event with restored plan_data
    const { data: updatedEvent, error: updateError } = await supabase
      .from("events")
      .update({
        plan_data: restoredPlanData,
        autosave_version: event.autosave_version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .select()
      .single();

    if (updateError || !updatedEvent) {
      throw new Error("Failed to update event");
    }

    // 9. Insert audit log entry
    const { error: auditError } = await supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "snapshot_restored",
      details: {
        snapshot_id: snapshotId,
        snapshot_label: snapshot.label,
        pre_restore_snapshot_id: preRestoreSnapshot.id,
      },
    });

    if (auditError) {
      throw new Error("Failed to log audit entry");
    }

    // 10. Map to DTO and return
    return EventMapper.toDTO(updatedEvent);
  }
}
```
