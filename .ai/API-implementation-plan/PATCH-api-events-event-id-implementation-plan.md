# API Endpoint Implementation Plan: PATCH /api/events/{event_id}

## 1. Endpoint Overview

The `PATCH /api/events/{event_id}` endpoint enables authenticated users to update metadata and grid configuration for their wedding seating events. This endpoint handles changes to event properties such as name, date, and grid dimensions, while explicitly excluding direct modifications to the plan data (tables, guests, seat assignments). When grid dimensions are modified, the endpoint automatically creates a snapshot to preserve the previous state, supporting the undo/redo system.

**Key Responsibilities:**

- Update event name, date, and/or grid dimensions
- Enforce ownership validation
- Prevent updates to soft-deleted events
- Create automatic snapshots on structural changes (grid dimension modifications)
- Log actions to audit trail
- Return complete updated event object

## 2. Request Details

### HTTP Method

`PATCH`

### URL Structure

```
/api/events/{event_id}
```

### Path Parameters

| Parameter  | Type | Required | Description                              |
| ---------- | ---- | -------- | ---------------------------------------- |
| `event_id` | UUID | Yes      | Unique identifier of the event to update |

### Headers

| Header          | Required | Description                                                    |
| --------------- | -------- | -------------------------------------------------------------- |
| `Authorization` | Yes      | Bearer token from Supabase Auth                                |
| `Content-Type`  | Yes      | Must be `application/json`                                     |
| `If-Match`      | No       | Optional optimistic concurrency control via `autosave_version` |

### Request Body

All fields are optional, but at least one must be provided. Follows `UpdateEventCommand` type.

```typescript
{
  name?: string;          // 1-150 characters
  event_date?: string | null;  // YYYY-MM-DD format or null
  grid_rows?: number;     // Positive integer
  grid_cols?: number;     // Positive integer
}
```

### Request Examples

**Update name only:**

```json
{
  "name": "Jane & John's Wedding"
}
```

**Update grid dimensions (triggers snapshot):**

```json
{
  "grid_rows": 25,
  "grid_cols": 35
}
```

**Update multiple fields:**

```json
{
  "name": "Updated Wedding",
  "event_date": "2026-06-15",
  "grid_rows": 20,
  "grid_cols": 30
}
```

**Clear event date:**

```json
{
  "event_date": null
}
```

## 3. Used Types

### Command Models (Input)

```typescript
// From src/types.ts
interface UpdateEventCommand {
  name?: string;
  event_date?: string | null;
  grid_rows?: number;
  grid_cols?: number;
}
```

### DTOs (Output)

```typescript
// From src/types.ts
interface EventDTO {
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

interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Database Types

```typescript
// From src/db/database.types.ts
type DBEventRow = Tables<"events">;
```

## 4. Response Details

### Success Response (200 OK)

Returns the complete updated event object as `EventDTO`.

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "owner_id": "123e4567-e89b-12d3-a456-426614174000",
  "name": "Jane & John's Wedding",
  "event_date": "2026-06-15",
  "grid": { "rows": 25, "cols": 35 },
  "plan_data": {
    "tables": [...],
    "guests": [...],
    "settings": { "color_palette": "default" }
  },
  "autosave_version": 4,
  "lock": {
    "held_by": null,
    "expires_at": null
  },
  "created_at": "2025-10-29T12:00:00.000Z",
  "updated_at": "2025-11-01T14:30:00.000Z"
}
```

### Error Responses

| Status Code | Error Code                | Description                                                     |
| ----------- | ------------------------- | --------------------------------------------------------------- |
| 400         | `VALIDATION_ERROR`        | Invalid request body (e.g., name too long, invalid date format) |
| 400         | `EMPTY_PATCH`             | No fields provided in request body                              |
| 400         | `INVALID_GRID_DIMENSIONS` | Grid dimensions ≤ 0 or exceed reasonable limits                 |
| 400         | `CONSTRAINT_VIOLATION`    | Database constraint violation                                   |
| 401         | `UNAUTHORIZED`            | Missing or invalid authentication token                         |
| 403         | `FORBIDDEN`               | User does not own this event                                    |
| 404         | `EVENT_NOT_FOUND`         | Event with given ID does not exist                              |
| 409         | `VERSION_CONFLICT`        | If-Match header value doesn't match current autosave_version    |
| 410         | `EVENT_DELETED`           | Event has been soft-deleted                                     |
| 500         | `INTERNAL_ERROR`          | Server-side error during processing                             |

**Error Response Example:**

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Event name must be between 1 and 150 characters",
    "details": {
      "field": "name",
      "constraint": "length"
    }
  }
}
```

## 5. Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Client Request                                               │
│    PATCH /api/events/{event_id}                                 │
│    Headers: Authorization, Content-Type, [If-Match]             │
│    Body: { name?, event_date?, grid_rows?, grid_cols? }         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Astro Middleware (src/middleware/index.ts)                   │
│    - Extract & verify JWT from Authorization header             │
│    - Attach user to context.locals.user                         │
│    - Return 401 if authentication fails                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. API Route Handler (src/pages/api/events/[event_id].ts)       │
│    - Export: export const prerender = false                     │
│    - Handler: export async function PATCH(context)              │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. Input Validation                                             │
│    - Validate event_id as UUID (path param)                     │
│    - Parse & validate request body with Zod schema              │
│    - Check at least one field provided (non-empty patch)        │
│    - Validate field constraints (name length, date format, etc) │
│    - Return 400 if validation fails                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. EventService.updateEvent()                                   │
│    (src/lib/services/event.service.ts)                          │
│                                                                 │
│    a) Fetch existing event from Supabase                        │
│       - SELECT * FROM events WHERE id = event_id                │
│       - Return 404 if not found                                 │
│                                                                 │
│    b) Ownership & State Validation                              │
│       - Check owner_id === user.id (403 if not)                 │
│       - Check deleted_at IS NULL (410 if soft-deleted)          │
│                                                                 │
│    c) Optimistic Concurrency Check (if If-Match provided)       │
│       - Parse If-Match header as integer                        │
│       - Compare to current autosave_version                     │
│       - Return 409 if mismatch                                  │
│                                                                 │
│    d) Detect Structural Changes                                 │
│       - hasGridChange = (grid_rows changed OR grid_cols changed)│
│       - Store original grid values for snapshot label           │
│                                                                 │
│    e) Update Event Record                                       │
│       - UPDATE events SET                                       │
│           name = COALESCE(patch.name, current.name),            │
│           event_date = patch.event_date ?? current.event_date,  │
│           grid_rows = COALESCE(patch.grid_rows, current.rows),  │
│           grid_cols = COALESCE(patch.grid_cols, current.cols),  │
│           updated_at = NOW()                                    │
│         WHERE id = event_id                                     │
│       - Return updated row                                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. Conditional Snapshot Creation                                │
│    (src/lib/services/snapshot.service.ts)                       │
│                                                                 │
│    IF hasGridChange:                                            │
│      a) Generate snapshot label                                 │
│         - e.g., "Auto: Grid changed from 20×30 to 25×35"        │
│                                                                 │
│      b) Find previous snapshot                                  │
│         - SELECT id FROM snapshots                              │
│           WHERE event_id = event_id                             │
│           ORDER BY created_at DESC LIMIT 1                      │
│                                                                 │
│      c) Insert snapshot                                         │
│         - INSERT INTO snapshots (                               │
│             event_id, created_by, is_manual, label,             │
│             plan_data, previous_snapshot_id                     │
│           ) VALUES (                                            │
│             event_id, user.id, false, label,                    │
│             original_plan_data, previous_id                     │
│           )                                                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. Audit Logging                                                │
│    (src/lib/services/audit.service.ts)                          │
│                                                                 │
│    - Determine action_type based on what changed:               │
│      - If only name/date changed: 'event_metadata_updated'      │
│      - If grid changed: 'event_grid_resized'                    │
│                                                                 │
│    - INSERT INTO audit_log (                                    │
│        event_id, user_id, action_type, details                  │
│      ) VALUES (                                                 │
│        event_id, user.id, action_type,                          │
│        { changes: { name?, event_date?, grid_rows?, grid_cols? },│
│          snapshot_created: boolean }                            │
│      )                                                          │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 8. Response Transformation                                      │
│    - Map database row to EventDTO                               │
│    - Transform grid_rows/cols to grid: { rows, cols }           │
│    - Transform lock fields to lock: { held_by, expires_at }     │
│    - Cast plan_data JSONB to PlanDataDTO                        │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 9. Return Response                                              │
│    - Status: 200 OK                                             │
│    - Body: EventDTO (JSON)                                      │
└─────────────────────────────────────────────────────────────────┘
```

## 6. Security Considerations

### Authentication

- **Middleware Enforcement**: All requests must pass through Astro middleware which validates the JWT token from Supabase Auth
- **User Context**: Authenticated user object (`context.locals.user`) is required and contains `user.id`
- **Token Validation**: Supabase client automatically validates token signature and expiration

### Authorization

- **Ownership Check**: Only the event owner (`owner_id === user.id`) can update the event
- **Return 403 Forbidden** if user attempts to update another user's event
- **No Admin Override**: MVP does not support admin access to other users' events

### Input Validation

- **Zod Schema Validation**: Strict type and format validation for all input fields
- **SQL Injection Prevention**: Supabase client uses parameterized queries
- **Mass Assignment Protection**: Only explicitly defined fields in `UpdateEventCommand` are accepted
- **Grid Dimension Limits**:
  - Minimum: 1×1
  - Recommended maximum: 100×100 (prevents DoS via excessive grid size)
  - Validate in Zod schema

### Data Integrity

- **Soft Delete Respect**: Reject updates to soft-deleted events (410 Gone)
- **Optimistic Concurrency**: Optional `If-Match` header support to prevent lost updates
- **Atomic Updates**: Use database transactions for update + snapshot creation

### PII & GDPR Compliance

- This endpoint does not expose PII beyond event ownership
- Audit logs record metadata changes (non-PII)
- Event name may contain PII (user responsibility)

## 7. Error Handling

### Validation Errors (400 Bad Request)

**Empty Patch**

```typescript
if (Object.keys(validatedData).length === 0) {
  return new Response(
    JSON.stringify({
      error: {
        code: "EMPTY_PATCH",
        message: "At least one field must be provided for update",
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}
```

**Invalid Input**

```typescript
const schema = z
  .object({
    name: z.string().min(1).max(150).optional(),
    event_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    grid_rows: z.number().int().positive().max(100).optional(),
    grid_cols: z.number().int().positive().max(100).optional(),
  })
  .strict();

try {
  const validatedData = schema.parse(await context.request.json());
} catch (error) {
  return new Response(
    JSON.stringify({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request body",
        details: error.errors, // Zod error details
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}
```

### Authentication Errors (401 Unauthorized)

Handled by middleware before route handler executes.

```typescript
// In middleware
if (!user) {
  return new Response(
    JSON.stringify({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required",
      },
    }),
    { status: 401, headers: { "Content-Type": "application/json" } }
  );
}
```

### Authorization Errors (403 Forbidden)

```typescript
if (event.owner_id !== user.id) {
  return new Response(
    JSON.stringify({
      error: {
        code: "FORBIDDEN",
        message: "You do not have permission to update this event",
      },
    }),
    { status: 403, headers: { "Content-Type": "application/json" } }
  );
}
```

### Not Found Errors (404 Not Found)

```typescript
const { data: event, error } = await supabase.from("events").select("*").eq("id", eventId).single();

if (error || !event) {
  return new Response(
    JSON.stringify({
      error: {
        code: "EVENT_NOT_FOUND",
        message: "Event not found",
      },
    }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}
```

### Conflict Errors (409 Conflict)

```typescript
const ifMatch = context.request.headers.get("If-Match");
if (ifMatch !== null) {
  const expectedVersion = parseInt(ifMatch, 10);
  if (event.autosave_version !== expectedVersion) {
    return new Response(
      JSON.stringify({
        error: {
          code: "VERSION_CONFLICT",
          message: "Event has been modified by another request",
          details: {
            expected_version: expectedVersion,
            current_version: event.autosave_version,
          },
        },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  }
}
```

### Gone Errors (410 Gone)

```typescript
if (event.deleted_at !== null) {
  return new Response(
    JSON.stringify({
      error: {
        code: "EVENT_DELETED",
        message: "This event has been deleted",
      },
    }),
    { status: 410, headers: { "Content-Type": "application/json" } }
  );
}
```

### Server Errors (500 Internal Server Error)

```typescript
try {
  // ... operation logic
} catch (error) {
  console.error("Error updating event:", error);
  return new Response(
    JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}
```

## 8. Performance Considerations

### Database Queries

- **Single Event Fetch**: Use `.single()` to fetch exactly one row
- **Indexed Lookups**: Event lookup by primary key (`id`) is O(1) via index
- **Conditional Snapshot**: Only execute INSERT when grid changes
- **Audit Log**: Async/fire-and-forget pattern acceptable (non-critical path)

### Potential Bottlenecks

1. **Large plan_data JSONB**: Event with hundreds of tables/guests results in large payload
   - Mitigation: Consider returning `EventSummaryDTO` (without plan_data) as optional response format
   - Future: Support `?include=plan_data` query parameter

2. **Snapshot Creation**: Deep copy of plan_data for structural changes
   - Mitigation: JSONB copying is efficient in PostgreSQL
   - Alternative: Store delta/diff instead of full copy (future enhancement)

3. **Concurrent Updates**: Multiple users editing same event metadata
   - Mitigation: Optimistic concurrency via `If-Match` header
   - Database-level: Row-level locking not required for metadata updates

### Optimization Strategies

- **Response Payload**: Default to full `EventDTO`; consider conditional inclusion
- **Snapshot Throttling**: Prevent rapid grid dimension changes from creating excessive snapshots
  - Implementation: Check last snapshot timestamp; debounce within 30 seconds
- **Caching**: Event metadata could be cached (future enhancement)
- **Connection Pooling**: Supabase client handles connection pooling automatically

### Load Testing Targets

- **Response Time**: < 200ms (p95) for metadata-only updates
- **Response Time**: < 500ms (p95) for grid changes with snapshot
- **Throughput**: 100 req/sec per event (reasonable concurrent edit scenario)

## 9. Implementation Steps

### Step 1: Create Service Layer Structure

**File**: `src/lib/services/event.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UpdateEventCommand, EventDTO } from "../types";

export class EventService {
  constructor(private supabase: SupabaseClient) {}

  async updateEvent(
    eventId: string,
    userId: string,
    updateData: UpdateEventCommand,
    ifMatchVersion?: number
  ): Promise<EventDTO> {
    // Implementation in Step 3
  }

  private mapRowToDTO(row: any): EventDTO {
    // Implementation in Step 4
  }
}
```

**File**: `src/lib/services/snapshot.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { PlanDataDTO } from "../types";

export class SnapshotService {
  constructor(private supabase: SupabaseClient) {}

  async createAutoSnapshot(eventId: string, userId: string, label: string, planData: PlanDataDTO): Promise<void> {
    // Implementation in Step 5
  }
}
```

**File**: `src/lib/services/audit.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { Enums } from "../db/database.types";

export class AuditService {
  constructor(private supabase: SupabaseClient) {}

  async logAction(
    eventId: string,
    userId: string,
    actionType: Enums<"action_type_enum">,
    details?: Record<string, unknown>
  ): Promise<void> {
    // Implementation in Step 6
  }
}
```

### Step 2: Create Zod Validation Schema

**File**: `src/lib/validators/event.validators.ts`

```typescript
import { z } from "zod";

export const updateEventSchema = z
  .object({
    name: z.string().min(1, "Name must not be empty").max(150, "Name must not exceed 150 characters").optional(),
    event_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Event date must be in YYYY-MM-DD format")
      .nullable()
      .optional(),
    grid_rows: z
      .number()
      .int("Grid rows must be an integer")
      .positive("Grid rows must be positive")
      .max(100, "Grid rows cannot exceed 100")
      .optional(),
    grid_cols: z
      .number()
      .int("Grid columns must be an integer")
      .positive("Grid columns must be positive")
      .max(100, "Grid columns cannot exceed 100")
      .optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const eventIdSchema = z.string().uuid("Invalid event ID format");
```

### Step 3: Implement EventService.updateEvent()

```typescript
async updateEvent(
  eventId: string,
  userId: string,
  updateData: UpdateEventCommand,
  ifMatchVersion?: number
): Promise<EventDTO> {
  // 1. Fetch existing event
  const { data: event, error: fetchError } = await this.supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .single();

  if (fetchError || !event) {
    throw new Error("EVENT_NOT_FOUND");
  }

  // 2. Ownership validation
  if (event.owner_id !== userId) {
    throw new Error("FORBIDDEN");
  }

  // 3. Soft delete check
  if (event.deleted_at !== null) {
    throw new Error("EVENT_DELETED");
  }

  // 4. Optimistic concurrency check
  if (ifMatchVersion !== undefined && event.autosave_version !== ifMatchVersion) {
    throw new Error("VERSION_CONFLICT");
  }

  // 5. Detect grid changes
  const hasGridChange =
    (updateData.grid_rows !== undefined && updateData.grid_rows !== event.grid_rows) ||
    (updateData.grid_cols !== undefined && updateData.grid_cols !== event.grid_cols);

  // 6. Prepare update object
  const updates: any = {
    updated_at: new Date().toISOString(),
  };

  if (updateData.name !== undefined) updates.name = updateData.name;
  if (updateData.event_date !== undefined) updates.event_date = updateData.event_date;
  if (updateData.grid_rows !== undefined) updates.grid_rows = updateData.grid_rows;
  if (updateData.grid_cols !== undefined) updates.grid_cols = updateData.grid_cols;

  // 7. Update event
  const { data: updatedEvent, error: updateError } = await this.supabase
    .from("events")
    .update(updates)
    .eq("id", eventId)
    .select("*")
    .single();

  if (updateError || !updatedEvent) {
    throw new Error("UPDATE_FAILED");
  }

  // 8. Create snapshot if grid changed
  if (hasGridChange) {
    const snapshotService = new SnapshotService(this.supabase);
    const label = `Auto: Grid changed from ${event.grid_rows}×${event.grid_cols} to ${updatedEvent.grid_rows}×${updatedEvent.grid_cols}`;
    await snapshotService.createAutoSnapshot(eventId, userId, label, event.plan_data);
  }

  // 9. Return mapped DTO
  return this.mapRowToDTO(updatedEvent);
}
```

### Step 4: Implement DTO Mapping

```typescript
private mapRowToDTO(row: any): EventDTO {
  return {
    id: row.id,
    owner_id: row.owner_id,
    name: row.name,
    event_date: row.event_date,
    grid: {
      rows: row.grid_rows,
      cols: row.grid_cols,
    },
    plan_data: row.plan_data as PlanDataDTO,
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
```

### Step 5: Implement SnapshotService.createAutoSnapshot()

```typescript
async createAutoSnapshot(
  eventId: string,
  userId: string,
  label: string,
  planData: PlanDataDTO
): Promise<void> {
  // 1. Find previous snapshot
  const { data: previousSnapshot } = await this.supabase
    .from("snapshots")
    .select("id")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  // 2. Insert new snapshot
  const { error } = await this.supabase.from("snapshots").insert({
    event_id: eventId,
    created_by: userId,
    is_manual: false,
    label,
    plan_data: planData,
    previous_snapshot_id: previousSnapshot?.id || null,
  });

  if (error) {
    console.error("Failed to create snapshot:", error);
    // Non-fatal: log but don't fail the update
  }
}
```

### Step 6: Implement AuditService.logAction()

```typescript
async logAction(
  eventId: string,
  userId: string,
  actionType: Enums<"action_type_enum">,
  details?: Record<string, unknown>
): Promise<void> {
  const { error } = await this.supabase.from("audit_log").insert({
    event_id: eventId,
    user_id: userId,
    action_type: actionType,
    details: details || null,
  });

  if (error) {
    console.error("Failed to log audit action:", error);
    // Non-fatal: log but continue
  }
}
```

### Step 7: Create API Route Handler

**File**: `src/pages/api/events/[event_id].ts`

```typescript
import type { APIContext } from "astro";
import { eventIdSchema, updateEventSchema } from "../../../lib/validators/event.validators";
import { EventService } from "../../../lib/services/event.service";
import { AuditService } from "../../../lib/services/audit.service";

export const prerender = false;

export async function PATCH(context: APIContext): Promise<Response> {
  try {
    // 1. Get authenticated user
    const user = context.locals.user;
    if (!user) {
      return new Response(
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Validate event_id from path
    const eventId = context.params.event_id;
    const eventIdValidation = eventIdSchema.safeParse(eventId);
    if (!eventIdValidation.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid event ID",
            details: eventIdValidation.error.errors,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Parse and validate request body
    const body = await context.request.json();
    const validation = updateEventSchema.safeParse(body);
    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request body",
            details: validation.error.errors,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Extract If-Match header (optional)
    const ifMatchHeader = context.request.headers.get("If-Match");
    const ifMatchVersion = ifMatchHeader ? parseInt(ifMatchHeader, 10) : undefined;

    // 5. Update event via service
    const supabase = context.locals.supabase;
    const eventService = new EventService(supabase);
    const auditService = new AuditService(supabase);

    const updatedEvent = await eventService.updateEvent(
      eventIdValidation.data,
      user.id,
      validation.data,
      ifMatchVersion
    );

    // 6. Log audit action
    const hasGridChange = validation.data.grid_rows !== undefined || validation.data.grid_cols !== undefined;
    const actionType = hasGridChange ? "table_update" : "guest_edit"; // Adjust based on actual enum
    await auditService.logAction(eventIdValidation.data, user.id, actionType, {
      changes: validation.data,
      snapshot_created: hasGridChange,
    });

    // 7. Return success response
    return new Response(JSON.stringify(updatedEvent), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    // Error handling
    console.error("PATCH /api/events/[event_id] error:", error);

    if (error.message === "EVENT_NOT_FOUND") {
      return new Response(
        JSON.stringify({
          error: {
            code: "EVENT_NOT_FOUND",
            message: "Event not found",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.message === "FORBIDDEN") {
      return new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "You do not have permission to update this event",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.message === "EVENT_DELETED") {
      return new Response(
        JSON.stringify({
          error: {
            code: "EVENT_DELETED",
            message: "This event has been deleted",
          },
        }),
        { status: 410, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.message === "VERSION_CONFLICT") {
      return new Response(
        JSON.stringify({
          error: {
            code: "VERSION_CONFLICT",
            message: "Event has been modified by another request",
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
```

### Step 8: Update Middleware (if needed)

Ensure `src/middleware/index.ts` extracts and validates the JWT, attaching `user` and `supabase` client to `context.locals`.

```typescript
// Verify middleware sets:
// - context.locals.user (authenticated user object with id)
// - context.locals.supabase (SupabaseClient instance)
```

### Step 9: Add Unit Tests

**File**: `src/lib/services/__tests__/event.service.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { EventService } from "../event.service";

describe("EventService.updateEvent", () => {
  it("should update event name successfully", async () => {
    // Mock Supabase client
    // Test implementation
  });

  it("should throw FORBIDDEN when user is not owner", async () => {
    // Test implementation
  });

  it("should throw EVENT_DELETED when event is soft-deleted", async () => {
    // Test implementation
  });

  it("should create snapshot when grid dimensions change", async () => {
    // Test implementation
  });

  it("should throw VERSION_CONFLICT on If-Match mismatch", async () => {
    // Test implementation
  });
});
```

### Step 10: Integration Testing

**Manual Testing Checklist:**

- [ ] Update event name only
- [ ] Update event date to valid date
- [ ] Clear event date (set to null)
- [ ] Update grid dimensions (verify snapshot creation)
- [ ] Attempt update without auth token (401)
- [ ] Attempt update of another user's event (403)
- [ ] Attempt update with invalid UUID (400)
- [ ] Attempt update with empty body (400)
- [ ] Attempt update with name > 150 chars (400)
- [ ] Attempt update with invalid date format (400)
- [ ] Attempt update with If-Match header (version match)
- [ ] Attempt update with If-Match header (version mismatch → 409)
- [ ] Verify audit_log entry created
- [ ] Verify snapshot created only on grid change

### Step 11: Documentation

Update API documentation with:

- Endpoint description
- Request/response examples
- Error code reference
- Snapshot creation behavior
- If-Match header usage

---

## Summary

This implementation plan provides a comprehensive guide to implementing the `PATCH /api/events/{event_id}` endpoint with:

- Robust input validation using Zod
- Service layer separation for testability and maintainability
- Automatic snapshot creation on structural changes
- Comprehensive error handling with appropriate status codes
- Security through authentication and authorization checks
- Audit trail logging
- Optimistic concurrency control support
- Performance considerations and optimization strategies

The modular approach ensures the endpoint is maintainable, testable, and follows the project's architectural guidelines.
