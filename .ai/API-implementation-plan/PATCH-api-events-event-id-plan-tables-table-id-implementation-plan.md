# API Endpoint Implementation Plan: PATCH /api/events/{event_id}/plan/tables/{table_id}

## 1. Endpoint Overview

This endpoint updates specific fields of a table within an event's seating plan. It performs a partial update, allowing clients to modify table properties such as capacity, shape, label, and seat numbering configuration.

**Critical business rule**: If the capacity is reduced below the number of currently assigned seats, the endpoint must return a 409 conflict error with a list of affected guest IDs, preventing data loss and orphaned seat assignments.

The endpoint operates on the `plan_data` JSONB column within the `events` table, extracting the tables array, locating the target table by ID, applying the patch, validating constraints, and persisting the updated structure atomically.

## 2. Request Details

- **HTTP Method**: PATCH
- **URL Structure**: `/api/events/{event_id}/plan/tables/{table_id}`
- **Content-Type**: `application/json`
- **Authentication**: Required (Bearer token from Supabase Auth)

### Path Parameters

| Parameter  | Type   | Required | Description                                                       |
| ---------- | ------ | -------- | ----------------------------------------------------------------- |
| `event_id` | UUID   | Yes      | Unique identifier of the event containing the table               |
| `table_id` | string | Yes      | Identifier of the table within the event's plan_data.tables array |

### Request Body

The request body follows the `UpdateTableCommand` type, where all fields are optional (partial update):

```typescript
{
  "shape"?: "round" | "rectangular" | "long",
  "capacity"?: number,        // Must be > 0; triggers overflow validation
  "label"?: string,           // Max 150 characters
  "start_index"?: number,     // Must be >= 1
  "head_seat"?: number        // Must be >= 1 and <= capacity
}
```

**Validation Rules**:

- At least one field must be provided
- `capacity`: positive integer > 0
- `start_index`: integer >= 1
- `head_seat`: integer >= 1 and <= capacity (validated against new or existing capacity)
- `label`: string, max length 150 characters
- `shape`: must be one of the enum values from `table_shape_enum`

### Example Request

```json
PATCH /api/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890/plan/tables/t1

{
  "capacity": 8,
  "label": "Head Table",
  "head_seat": 1
}
```

## 3. Used Types

### Input Types

- **`UpdateTableCommand`**: Request body structure for partial table updates
  ```typescript
  interface UpdateTableCommand extends Partial<Omit<TableDTO, "id" | "seats">> {
    capacity?: number;
  }
  ```

### Output Types

- **`EventDTO`**: Full event response including updated plan_data
- **`TableDTO`**: Structure of individual table within plan_data
- **`PlanDataDTO`**: Structure of the plan_data JSONB field
- **`ApiErrorDTO`**: Standard error response envelope

### Internal Types

- **`SeatAssignmentDTO`**: Used to validate capacity against assigned seats
  ```typescript
  interface SeatAssignmentDTO {
    seat_no: number;
    guest_id?: string;
  }
  ```

### Database Types

- **`Tables<"events">`**: Supabase generated type for events table
- **`Enums<"table_shape_enum">`**: Enum for valid table shapes

## 4. Response Details

### Success Response (200 OK)

Returns the complete updated `EventDTO` with the modified table reflected in `plan_data`.

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "owner_id": "user-uuid",
  "name": "Sarah & John's Wedding",
  "event_date": "2025-06-15",
  "grid": { "rows": 10, "cols": 10 },
  "plan_data": {
    "tables": [
      {
        "id": "t1",
        "shape": "round",
        "capacity": 8,
        "label": "Head Table",
        "start_index": 1,
        "head_seat": 1,
        "seats": [
          { "seat_no": 1, "guest_id": "g1" },
          { "seat_no": 2, "guest_id": "g2" }
        ]
      }
    ],
    "guests": [...],
    "settings": {...}
  },
  "autosave_version": 15,
  "lock": { "held_by": null, "expires_at": null },
  "created_at": "2025-01-15T10:00:00Z",
  "updated_at": "2025-01-20T14:30:00Z"
}
```

### Error Responses

#### 400 Bad Request

Invalid input data or validation failure.

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Validation failed",
    "details": {
      "field": "capacity",
      "issue": "Must be greater than 0"
    }
  }
}
```

#### 401 Unauthorized

Missing or invalid authentication token.

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

#### 403 Forbidden

User does not own the event.

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to modify this event"
  }
}
```

#### 404 Not Found

Event or table not found.

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found or has been deleted"
  }
}
```

```json
{
  "error": {
    "code": "TABLE_NOT_FOUND",
    "message": "Table with id 't1' not found in event plan"
  }
}
```

#### 409 Conflict - Capacity Overflow

Attempting to reduce capacity below the number of assigned seats.

```json
{
  "error": {
    "code": "TABLE_CAPACITY_OVERFLOW",
    "message": "Cannot reduce capacity to 6: 8 seats are currently assigned",
    "details": {
      "requested_capacity": 6,
      "assigned_seats": 8,
      "affected_guest_ids": ["g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8"]
    }
  }
}
```

#### 500 Internal Server Error

Unexpected server error.

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

## 5. Data Flow

### High-Level Flow

```
Client Request
    ↓
API Route Handler (/api/events/[event_id]/plan/tables/[table_id].ts)
    ↓
Authentication Middleware (verify Supabase user)
    ↓
Input Validation (Zod schema)
    ↓
EventService.getEventById(event_id, user_id)
    ↓
Ownership Verification
    ↓
TableService.findTableInPlanData(plan_data, table_id)
    ↓
TableService.validateTablePatch(patch, current_table)
    ↓
[If capacity changed] TableService.validateCapacityChange(table, new_capacity)
    ↓
TableService.applyTablePatch(plan_data, table_id, patch)
    ↓
EventService.updateEventPlanData(event_id, updated_plan_data, user_id)
    ↓
AuditService.logTableUpdate(event_id, user_id, table_id, changes)
    ↓
Return EventDTO (200)
```

### Detailed Step-by-Step

1. **Request Reception**: API route receives PATCH request with event_id and table_id in path
2. **Authentication**: Astro middleware extracts user from `context.locals.supabase`
3. **Input Validation**:
   - Validate path parameters (UUID format for event_id, non-empty table_id)
   - Validate request body against UpdateTableCommand schema using Zod
4. **Event Retrieval**: Call `EventService.getEventById(supabase, event_id, user_id)`
   - Query events table with filters: id = event_id, owner_id = user_id, deleted_at IS NULL
   - Return 404 if not found
   - Return 403 if found but owner_id doesn't match
5. **Table Lookup**: Extract plan_data.tables array and find table with matching id
   - Return 404 TABLE_NOT_FOUND if table doesn't exist
6. **Patch Validation**: Validate the patch against business rules
   - If head_seat provided, ensure it's <= capacity (new or existing)
   - If start_index provided, ensure it's >= 1
   - Sanitize label if provided
7. **Capacity Overflow Check**: If capacity is being reduced
   - Count assigned seats in table.seats array (seats with guest_id defined)
   - If new capacity < assigned count, return 409 with affected_guest_ids
8. **Apply Patch**: Create updated plan_data with table modifications
   - Use immutable update pattern (spread operators)
   - Preserve all other tables and guests unchanged
9. **Persist Changes**: Update events table
   - Set plan_data = updated_plan_data
   - Increment autosave_version
   - Set updated_at = now()
   - Use optimistic locking if version provided in request header
10. **Audit Logging**: Create audit_log entry with action_type='table_update' and change details
11. **Response**: Return full EventDTO with updated data

### Database Interactions

**Single Transaction**:

```sql
BEGIN;
  -- 1. Fetch event
  SELECT * FROM events
  WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL;

  -- 2. Update event (with optimistic locking)
  UPDATE events
  SET
    plan_data = $3,
    autosave_version = autosave_version + 1,
    updated_at = now()
  WHERE id = $1 AND owner_id = $2;

  -- 3. Insert audit log
  INSERT INTO audit_log (event_id, user_id, action_type, details)
  VALUES ($1, $2, 'table_update', $4);
COMMIT;
```

## 6. Security Considerations

### Authentication

- **Requirement**: Valid Supabase authentication token in Authorization header
- **Implementation**: Use `context.locals.supabase.auth.getUser()` in middleware
- **Failure**: Return 401 UNAUTHORIZED if token missing or invalid

### Authorization

- **Ownership Verification**: Query events table with `owner_id = authenticated_user_id`
- **Principle**: Users can only modify events they own
- **Failure**: Return 403 FORBIDDEN if event exists but user is not owner
- **Soft Delete Check**: Ensure `deleted_at IS NULL` to prevent modification of deleted events

### Input Validation

- **Path Parameter Sanitization**:
  - Validate event_id is a valid UUID format
  - Ensure table_id is non-empty and doesn't contain SQL injection patterns
- **Body Validation**:
  - Use Zod schema to enforce type safety and constraints
  - Sanitize string inputs (label) to prevent XSS
  - Validate numeric bounds (capacity > 0, start_index >= 1)
  - Whitelist shape values against enum

### Data Integrity

- **Capacity Overflow Protection**: Prevent capacity reduction that would orphan guests
- **Seat Number Consistency**: Validate head_seat is within capacity bounds
- **JSONB Schema Integrity**: Ensure plan_data structure remains valid after update
- **Atomicity**: Use database transactions to prevent partial updates

### Rate Limiting (Future)

- Consider implementing rate limits on table updates per event per minute
- Store in admin_flags table or use in-memory cache

### Potential Threats

| Threat                                  | Mitigation                                              |
| --------------------------------------- | ------------------------------------------------------- |
| IDOR (Insecure Direct Object Reference) | Verify ownership via owner_id check                     |
| SQL Injection                           | Use parameterized queries; Supabase client handles this |
| XSS in label field                      | Sanitize string inputs before storage                   |
| Race conditions on concurrent edits     | Optimistic locking with autosave_version (optional)     |
| Malicious capacity values               | Validate positive integers within reasonable bounds     |
| Unauthorized deletion via capacity=0    | Enforce capacity > 0 constraint                         |

## 7. Error Handling

### Error Scenarios and Responses

| Scenario                | HTTP Status | Error Code              | Details                                         |
| ----------------------- | ----------- | ----------------------- | ----------------------------------------------- |
| Missing auth token      | 401         | UNAUTHORIZED            | Authentication required                         |
| Invalid auth token      | 401         | UNAUTHORIZED            | Invalid or expired token                        |
| Invalid event_id format | 400         | INVALID_INPUT           | Must be a valid UUID                            |
| Invalid request body    | 400         | INVALID_INPUT           | Zod validation errors in details                |
| capacity <= 0           | 400         | INVALID_INPUT           | Capacity must be greater than 0                 |
| start_index < 1         | 400         | INVALID_INPUT           | Start index must be >= 1                        |
| head_seat out of range  | 400         | INVALID_INPUT           | Head seat must be between 1 and capacity        |
| Invalid shape value     | 400         | INVALID_INPUT           | Shape must be round, rectangular, or long       |
| label too long          | 400         | INVALID_INPUT           | Label must be <= 150 characters                 |
| Empty patch body        | 400         | INVALID_INPUT           | At least one field must be provided             |
| Event not found         | 404         | EVENT_NOT_FOUND         | Event not found or has been deleted             |
| Table not found         | 404         | TABLE_NOT_FOUND         | Table with id '{table_id}' not found            |
| User not event owner    | 403         | FORBIDDEN               | You do not have permission to modify this event |
| Capacity overflow       | 409         | TABLE_CAPACITY_OVERFLOW | Includes affected_guest_ids in details          |
| Database error          | 500         | INTERNAL_ERROR          | Logged but not exposed to client                |
| JSONB parse error       | 500         | INTERNAL_ERROR          | Logged but not exposed to client                |

### Error Handling Strategy

**Input Validation Errors (400)**:

```typescript
try {
  const validatedBody = updateTableCommandSchema.parse(await request.json());
} catch (error) {
  if (error instanceof z.ZodError) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Validation failed",
          details: error.errors,
        },
      }),
      { status: 400 }
    );
  }
}
```

**Capacity Overflow (409)**:

```typescript
const validation = await TableService.validateCapacityChange(table, patch.capacity, userId);

if (!validation.valid) {
  return new Response(
    JSON.stringify({
      error: {
        code: "TABLE_CAPACITY_OVERFLOW",
        message: `Cannot reduce capacity to ${patch.capacity}: ${validation.assignedCount} seats are currently assigned`,
        details: {
          requested_capacity: patch.capacity,
          assigned_seats: validation.assignedCount,
          affected_guest_ids: validation.affectedGuestIds,
        },
      },
    }),
    { status: 409 }
  );
}
```

**Database Errors (500)**:

```typescript
try {
  await EventService.updateEventPlanData(supabase, eventId, updatedPlanData, userId);
} catch (error) {
  console.error("Database error updating table:", error);
  return new Response(
    JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    }),
    { status: 500 }
  );
}
```

### Logging Strategy

- **Error Level**: Log all 500 errors with full stack traces
- **Warning Level**: Log 409 capacity overflow attempts
- **Info Level**: Log successful table updates with change summary
- **Audit Trail**: Record all modifications in audit_log table regardless of outcome

## 8. Performance Considerations

### Potential Bottlenecks

1. **JSONB Updates**: Updating JSONB columns requires full column rewrite
2. **Large plan_data**: Events with 100+ tables may have significant JSONB payloads
3. **Concurrent Updates**: Multiple users editing different tables in the same event
4. **Audit Log Writes**: Additional INSERT for each operation

### Optimization Strategies

**Database Level**:

- Use GIN index on `plan_data` for fast JSONB path queries (future)
- Implement optimistic locking with autosave_version to handle concurrency
- Consider JSONB partial update functions if performance degrades with large plans

**Application Level**:

- Return only modified event in response (already doing this)
- Implement client-side debouncing for rapid updates
- Consider WebSocket-based real-time updates for collaborative editing (future)

**Caching**:

- Cache event ownership checks for the duration of request (avoid duplicate queries)
- Use Supabase RLS policies to simplify authorization logic

**Query Optimization**:

```sql
-- Efficient single query with ownership check
SELECT * FROM events
WHERE id = $1
  AND owner_id = $2
  AND deleted_at IS NULL
LIMIT 1;
```

### Benchmarks (Target)

- **Response Time**: < 200ms for typical update (10 tables)
- **Response Time**: < 500ms for large event (100 tables)
- **Throughput**: > 100 requests/second per server instance
- **JSONB Size Limit**: Soft limit of 10MB per plan_data (to maintain performance)

### Monitoring

- Track p95 and p99 latencies for this endpoint
- Monitor JSONB column sizes over time
- Alert on autosave_version conflicts (potential concurrent edit issues)
- Track 409 error rate (user experience indicator)

## 9. Implementation Steps

### Step 1: Create Zod Validation Schema

**File**: `src/lib/schemas/table.schema.ts`

```typescript
import { z } from "zod";

export const updateTableCommandSchema = z
  .object({
    shape: z.enum(["round", "rectangular", "long"]).optional(),
    capacity: z.number().int().positive().optional(),
    label: z.string().max(150).optional(),
    start_index: z.number().int().min(1).optional(),
    head_seat: z.number().int().min(1).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" })
  .refine((data) => !data.head_seat || !data.capacity || data.head_seat <= data.capacity, {
    message: "head_seat must be less than or equal to capacity",
  });
```

### Step 2: Create Table Service

**File**: `src/lib/services/table.service.ts`

```typescript
import type { PlanDataDTO, TableDTO, UpdateTableCommand } from "../../types";

export class TableService {
  /**
   * Find a table by ID within plan_data
   */
  static findTable(planData: PlanDataDTO, tableId: string): TableDTO | null {
    return planData.tables.find((t) => t.id === tableId) ?? null;
  }

  /**
   * Validate capacity change against assigned seats
   */
  static validateCapacityChange(
    table: TableDTO,
    newCapacity: number
  ): { valid: boolean; assignedCount?: number; affectedGuestIds?: string[] } {
    const assignedSeats = table.seats.filter((s) => s.guest_id);
    const assignedCount = assignedSeats.length;

    if (newCapacity < assignedCount) {
      return {
        valid: false,
        assignedCount,
        affectedGuestIds: assignedSeats.map((s) => s.guest_id!).filter(Boolean),
      };
    }

    return { valid: true };
  }

  /**
   * Apply patch to table within plan_data (immutable)
   */
  static applyTablePatch(planData: PlanDataDTO, tableId: string, patch: UpdateTableCommand): PlanDataDTO {
    return {
      ...planData,
      tables: planData.tables.map((table) => {
        if (table.id !== tableId) return table;

        const updated = { ...table, ...patch };

        // If capacity changed, ensure head_seat is within bounds
        if (patch.capacity && updated.head_seat > patch.capacity) {
          updated.head_seat = patch.capacity;
        }

        return updated;
      }),
    };
  }

  /**
   * Sanitize label to prevent XSS
   */
  static sanitizeLabel(label: string): string {
    return label.replace(/[<>]/g, "").trim().substring(0, 150);
  }
}
```

### Step 3: Create/Update Event Service

**File**: `src/lib/services/event.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { EventDTO, PlanDataDTO } from "../../types";
import type { Tables } from "../db/database.types";

export class EventService {
  /**
   * Get event by ID with ownership verification
   */
  static async getEventById(
    supabase: SupabaseClient,
    eventId: string,
    userId: string
  ): Promise<Tables<"events"> | null> {
    const { data, error } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .eq("owner_id", userId)
      .is("deleted_at", null)
      .single();

    if (error) {
      console.error("Error fetching event:", error);
      return null;
    }

    return data;
  }

  /**
   * Update event plan_data and increment version
   */
  static async updateEventPlanData(
    supabase: SupabaseClient,
    eventId: string,
    planData: PlanDataDTO,
    userId: string
  ): Promise<Tables<"events"> | null> {
    const { data, error } = await supabase
      .from("events")
      .update({
        plan_data: planData as any,
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .eq("owner_id", userId)
      .select()
      .single();

    if (error) {
      console.error("Error updating event:", error);
      throw error;
    }

    return data;
  }

  /**
   * Convert DB row to EventDTO
   */
  static toEventDTO(row: Tables<"events">): EventDTO {
    return {
      id: row.id,
      owner_id: row.owner_id,
      name: row.name,
      event_date: row.event_date,
      grid: { rows: row.grid_rows, cols: row.grid_cols },
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
}
```

### Step 4: Create/Update Audit Service

**File**: `src/lib/services/audit.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UpdateTableCommand } from "../../types";

export class AuditService {
  /**
   * Log table update action
   */
  static async logTableUpdate(
    supabase: SupabaseClient,
    eventId: string,
    userId: string,
    tableId: string,
    changes: UpdateTableCommand
  ): Promise<void> {
    const { error } = await supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "table_update",
      details: {
        table_id: tableId,
        changes,
      },
    });

    if (error) {
      console.error("Error logging table update:", error);
      // Don't throw - audit failure shouldn't break the operation
    }
  }
}
```

### Step 5: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/plan/tables/[table_id].ts`

```typescript
import type { APIRoute } from "astro";
import { updateTableCommandSchema } from "../../../../../../lib/schemas/table.schema";
import { EventService } from "../../../../../../lib/services/event.service";
import { TableService } from "../../../../../../lib/services/table.service";
import { AuditService } from "../../../../../../lib/services/audit.service";
import type { ApiErrorDTO, UpdateTableCommand, PlanDataDTO } from "../../../../../../types";

export const prerender = false;

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const supabase = locals.supabase;

  // Step 1: Authentication
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

  // Step 2: Validate path parameters
  const { event_id, table_id } = params;

  if (!event_id || !table_id) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Missing event_id or table_id",
        },
      } as ApiErrorDTO),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(event_id)) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Invalid event_id format",
        },
      } as ApiErrorDTO),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 3: Validate request body
  let patch: UpdateTableCommand;
  try {
    const body = await request.json();
    patch = updateTableCommandSchema.parse(body);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Validation failed",
          details: error instanceof Error ? error.message : error,
        },
      } as ApiErrorDTO),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Sanitize label if provided
  if (patch.label) {
    patch.label = TableService.sanitizeLabel(patch.label);
  }

  // Step 4: Fetch event with ownership verification
  const event = await EventService.getEventById(supabase, event_id, user.id);

  if (!event) {
    return new Response(
      JSON.stringify({
        error: {
          code: "EVENT_NOT_FOUND",
          message: "Event not found or has been deleted",
        },
      } as ApiErrorDTO),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 5: Find table in plan_data
  const planData = event.plan_data as PlanDataDTO;
  const table = TableService.findTable(planData, table_id);

  if (!table) {
    return new Response(
      JSON.stringify({
        error: {
          code: "TABLE_NOT_FOUND",
          message: `Table with id '${table_id}' not found in event plan`,
        },
      } as ApiErrorDTO),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 6: Validate capacity change if applicable
  if (patch.capacity !== undefined && patch.capacity !== table.capacity) {
    const validation = TableService.validateCapacityChange(table, patch.capacity);

    if (!validation.valid) {
      return new Response(
        JSON.stringify({
          error: {
            code: "TABLE_CAPACITY_OVERFLOW",
            message: `Cannot reduce capacity to ${patch.capacity}: ${validation.assignedCount} seats are currently assigned`,
            details: {
              requested_capacity: patch.capacity,
              assigned_seats: validation.assignedCount,
              affected_guest_ids: validation.affectedGuestIds,
            },
          },
        } as ApiErrorDTO),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // Step 7: Validate head_seat against existing capacity if not changing capacity
  if (patch.head_seat && !patch.capacity) {
    if (patch.head_seat > table.capacity) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: `head_seat (${patch.head_seat}) must be <= capacity (${table.capacity})`,
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // Step 8: Apply patch to plan_data
  const updatedPlanData = TableService.applyTablePatch(planData, table_id, patch);

  // Step 9: Persist changes
  try {
    const updatedEvent = await EventService.updateEventPlanData(supabase, event_id, updatedPlanData, user.id);

    if (!updatedEvent) {
      throw new Error("Failed to update event");
    }

    // Step 10: Audit logging (async, non-blocking)
    AuditService.logTableUpdate(supabase, event_id, user.id, table_id, patch);

    // Step 11: Return success response
    const eventDTO = EventService.toEventDTO(updatedEvent);

    return new Response(JSON.stringify(eventDTO), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error updating table:", error);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
        },
      } as ApiErrorDTO),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
```

### Step 6: Update Middleware (if needed)

**File**: `src/middleware/index.ts`

Ensure Supabase client is available in `context.locals`:

```typescript
import { defineMiddleware } from "astro:middleware";
import { createServerClient } from "../db/supabase.client";

export const onRequest = defineMiddleware(async (context, next) => {
  context.locals.supabase = createServerClient(context);
  return next();
});
```

### Step 7: Add Tests

**File**: `src/pages/api/events/[event_id]/plan/tables/[table_id].test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
// Test cases:
// - Successful table update (200)
// - Capacity overflow (409)
// - Table not found (404)
// - Event not found (404)
// - Unauthorized (401)
// - Invalid input (400)
// - head_seat out of range (400)
```

### Step 8: Update API Documentation

Add endpoint documentation to project API reference with examples.

### Step 9: Manual Testing Checklist

- [ ] Test successful table update with all fields
- [ ] Test partial updates (single field)
- [ ] Test capacity overflow scenario
- [ ] Test capacity increase (should succeed)
- [ ] Test unauthorized access
- [ ] Test non-existent event
- [ ] Test non-existent table
- [ ] Test invalid UUID format
- [ ] Test invalid request body
- [ ] Test head_seat validation
- [ ] Test label sanitization
- [ ] Verify audit log entries created
- [ ] Verify autosave_version incremented

### Step 10: Performance Testing

- [ ] Test with small plan_data (5 tables)
- [ ] Test with medium plan_data (50 tables)
- [ ] Test with large plan_data (100+ tables)
- [ ] Measure response times
- [ ] Test concurrent updates to different tables

---

## Implementation Checklist

- [ ] Create Zod validation schema
- [ ] Implement TableService with validation methods
- [ ] Create/update EventService
- [ ] Create/update AuditService
- [ ] Implement API route handler
- [ ] Verify middleware configuration
- [ ] Write unit tests for services
- [ ] Write integration tests for endpoint
- [ ] Update API documentation
- [ ] Perform manual testing
- [ ] Conduct performance testing
- [ ] Review security considerations
- [ ] Deploy to staging environment
- [ ] Final QA approval
