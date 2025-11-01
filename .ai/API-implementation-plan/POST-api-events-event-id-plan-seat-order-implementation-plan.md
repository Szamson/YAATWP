# API Endpoint Implementation Plan: POST /api/events/{event_id}/plan/seat-order

## 1. Endpoint Overview

This endpoint allows authenticated event owners to modify the seat ordering configuration for a specific table within their seating plan. The operation updates three key properties of a table:

- `start_index`: The seat number at which seat numbering begins (>=1)
- `head_seat`: The designated head seat position (1..capacity)
- `direction`: The direction of seat numbering (currently only "clockwise" supported, reserved for future expansion)

The operation modifies the embedded JSONB `plan_data` structure within the `events` table, increments the `autosave_version` for optimistic concurrency control, and creates an audit log entry. This endpoint is part of the plan mutation API surface and supports undo/redo functionality through versioning.

**Key Characteristics:**

- Mutates embedded JSONB data (not relational tables)
- Implements optimistic locking via `autosave_version`
- Respects soft single-editor lock if held by another user
- Creates audit trail for compliance
- Returns updated table metadata to client

## 2. Request Details

**HTTP Method:** POST

**URL Structure:** `/api/events/{event_id}/plan/seat-order`

**Path Parameters:**

- `event_id` (UUID, required): The unique identifier of the event containing the table

**Request Headers:**

- `Authorization: Bearer <JWT>` (required): Supabase JWT token for authentication
- `Content-Type: application/json` (required)
- `If-Match: <autosave_version>` (optional but recommended): Expected autosave version for optimistic locking

**Request Body:**

```typescript
{
  "table_id": "string",        // Required: ID of table within plan_data.tables
  "start_index": number,       // Required: Seat numbering start (>=1)
  "head_seat": number,         // Required: Designated head seat (1..capacity)
  "direction": "clockwise"     // Optional: Currently only "clockwise" valid
}
```

**Request Body Schema (Zod):**

```typescript
const ChangeSeatOrderSchema = z.object({
  table_id: z.string().min(1, "Table ID is required"),
  start_index: z.number().int().positive().min(1, "Start index must be >= 1"),
  head_seat: z.number().int().positive().min(1, "Head seat must be >= 1"),
  direction: z.enum(["clockwise"]).optional(),
});
```

**Validation Rules:**

1. `event_id` must be a valid UUID format
2. Request body must conform to schema
3. `head_seat` must be <= table capacity (validated after fetching table)
4. `table_id` must exist in event's plan_data.tables array
5. User must be authenticated (valid JWT)
6. User must be the event owner (enforced via RLS + service logic)
7. Event must not be soft-deleted (`deleted_at` is null)
8. If lock is held, it must be held by the requesting user or expired

## 3. Used Types

**Command Models:**

```typescript
// From src/types.ts
interface ChangeSeatOrderCommand {
  table_id: string;
  start_index: number;
  head_seat: number;
  direction?: "clockwise";
}
```

**DTOs:**

```typescript
// Response type
interface TableDTO {
  id: string;
  shape: Enums<"table_shape_enum">;
  capacity: number;
  label?: string;
  start_index: number;
  head_seat: number;
  seats: SeatAssignmentDTO[];
}

// Embedded in plan_data
interface PlanDataDTO {
  tables: TableDTO[];
  guests: GuestDTO[];
  settings: PlanSettingsDTO;
}

// Error response
interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

**Database Types:**

```typescript
// From src/db/database.types.ts
type EventRow = Tables<"events">;
type AuditLogRow = Tables<"audit_log">;
type ActionTypeEnum = Enums<"action_type_enum">; // 'seat_order_changed'
```

## 4. Response Details

**Success Response (200 OK):**

```json
{
  "id": "t1",
  "shape": "round",
  "capacity": 10,
  "label": "Table 1",
  "start_index": 1,
  "head_seat": 3,
  "seats": [
    { "seat_no": 1, "guest_id": "g1" },
    { "seat_no": 2, "guest_id": "g2" }
  ]
}
```

Returns the complete updated `TableDTO` object from the modified plan_data.

**Additional Response Headers:**

- `ETag: "<new_autosave_version>"`: New version for next optimistic lock check

**Error Responses:**

| Status Code | Error Code          | Scenario                            | Response Body                                                                                                                                                              |
| ----------- | ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400         | INVALID_INPUT       | Request body validation fails       | `{ "error": { "code": "INVALID_INPUT", "message": "Validation error", "details": { "field": "start_index", "issue": "must be >= 1" } } }`                                  |
| 400         | INVALID_SEAT_NUMBER | head_seat exceeds table capacity    | `{ "error": { "code": "INVALID_SEAT_NUMBER", "message": "Head seat 15 exceeds table capacity 10" } }`                                                                      |
| 400         | INVALID_START_INDEX | start_index is invalid              | `{ "error": { "code": "INVALID_START_INDEX", "message": "Start index must be at least 1" } }`                                                                              |
| 400         | INVALID_DIRECTION   | Invalid direction value provided    | `{ "error": { "code": "INVALID_DIRECTION", "message": "Direction must be 'clockwise'" } }`                                                                                 |
| 401         | UNAUTHORIZED        | Missing or invalid JWT              | `{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }`                                                                                            |
| 403         | FORBIDDEN           | User is not event owner             | `{ "error": { "code": "FORBIDDEN", "message": "You do not have permission to modify this event" } }`                                                                       |
| 404         | EVENT_NOT_FOUND     | Event doesn't exist or soft-deleted | `{ "error": { "code": "EVENT_NOT_FOUND", "message": "Event not found" } }`                                                                                                 |
| 404         | TABLE_NOT_FOUND     | table_id not found in plan_data     | `{ "error": { "code": "TABLE_NOT_FOUND", "message": "Table 't5' not found in event plan" } }`                                                                              |
| 409         | LOCK_HELD           | Another user holds the lock         | `{ "error": { "code": "LOCK_HELD", "message": "Event is locked by another user", "details": { "held_by": "uuid", "expires_at": "2025-11-01T12:00:00Z" } } }`               |
| 409         | VERSION_CONFLICT    | autosave_version mismatch           | `{ "error": { "code": "VERSION_CONFLICT", "message": "Event has been modified. Please refresh and retry.", "details": { "current_version": 5, "provided_version": 3 } } }` |
| 500         | INTERNAL_ERROR      | Database or unexpected error        | `{ "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }`                                                                                     |

## 5. Data Flow

### High-Level Flow:

```
Client Request
    ↓
Astro Middleware (JWT validation via Supabase)
    ↓
API Route Handler (/api/events/[event_id]/plan/seat-order.ts)
    ↓
Input Validation (Zod schema)
    ↓
EventPlanService.updateTableSeatOrder()
    ├→ Fetch event via Supabase (RLS applies owner check)
    ├→ Validate event exists and not deleted
    ├→ Check lock status
    ├→ Validate version (if If-Match header present)
    ├→ Parse plan_data JSONB
    ├→ Find table by table_id
    ├→ Validate head_seat <= capacity
    ├→ Update table properties in plan_data
    ├→ Increment autosave_version
    ├→ Update event row (plan_data, autosave_version, updated_at)
    ↓
AuditService.logAction()
    └→ Insert audit_log entry (action: 'seat_order_changed')
    ↓
Return updated TableDTO to client
```

### Detailed Step-by-Step:

1. **Request Reception**: Astro API route receives POST request
2. **Authentication**: Middleware validates JWT from `Authorization` header using `context.locals.supabase`
3. **Path Parameter Extraction**: Extract `event_id` from route params
4. **Body Parsing**: Parse and validate request body against Zod schema
5. **Service Invocation**: Call `EventPlanService.updateTableSeatOrder(supabase, userId, eventId, command)`
6. **Event Fetch**: Query `events` table filtering by `id = event_id` and `deleted_at IS NULL`
   - RLS policy ensures only owner can see/modify
7. **Ownership Check**: Verify `event.owner_id === userId` (may be redundant with RLS but explicit check adds safety)
8. **Lock Validation**: Check if `lock_held_by` is null or equals userId, and `lock_expires_at` is null or past
9. **Version Check**: If `If-Match` header present, compare with `event.autosave_version`
10. **Plan Data Parsing**: Deserialize `event.plan_data` as `PlanDataDTO`
11. **Table Lookup**: Find table in `plan_data.tables` array matching `command.table_id`
12. **Capacity Validation**: Ensure `command.head_seat <= table.capacity`
13. **Table Update**: Modify table object:
    - `table.start_index = command.start_index`
    - `table.head_seat = command.head_seat`
    - `table.direction = command.direction ?? "clockwise"` (if we store direction)
14. **Plan Data Update**: Replace old table with updated table in array
15. **Event Update**: Execute Supabase update:
    ```typescript
    await supabase
      .from("events")
      .update({
        plan_data: updatedPlanData,
        autosave_version: event.autosave_version + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .eq("autosave_version", event.autosave_version) // Optimistic lock
      .select()
      .single();
    ```
16. **Audit Logging**: Insert audit_log entry:
    ```typescript
    await supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "seat_order_changed",
      details: {
        table_id: command.table_id,
        old_start_index: oldTable.start_index,
        new_start_index: command.start_index,
        old_head_seat: oldTable.head_seat,
        new_head_seat: command.head_seat,
      },
    });
    ```
17. **Response Formation**: Extract updated table from updated plan_data
18. **Response Headers**: Set `ETag` header with new autosave_version
19. **Return**: Send 200 response with `TableDTO`

### Database Interactions:

**Read Operations:**

1. `SELECT * FROM events WHERE id = $1 AND deleted_at IS NULL` (via Supabase client, RLS applies)

**Write Operations:**

1. `UPDATE events SET plan_data = $1, autosave_version = $2, updated_at = $3 WHERE id = $4 AND autosave_version = $5` (optimistic lock)
2. `INSERT INTO audit_log (event_id, user_id, action_type, details, created_at) VALUES (...)`

**RLS Policies Applied:**

- Events table: `owner_id = auth.uid()` for SELECT and UPDATE
- Audit_log table: Service role or permissive INSERT for authenticated users

## 6. Security Considerations

### Authentication

- **Mechanism**: Supabase JWT tokens validated by middleware
- **Implementation**: Use `context.locals.supabase` which is pre-configured with user's JWT
- **Failure Handling**: Return 401 if no valid session found

### Authorization

- **Owner Verification**: Leveraged via Supabase RLS policies on `events` table
- **Explicit Check**: Service layer should still verify `event.owner_id === userId` for defense-in-depth
- **Lock Respect**: Check `lock_held_by` to prevent concurrent edits (soft lock, not blocking)
- **Failure Handling**: Return 403 if user is not owner, 409 if lock held by another user

### Input Validation

- **Schema Validation**: Use Zod to validate all input parameters before processing
- **Type Safety**: TypeScript enforces type correctness at compile time
- **JSONB Validation**: After parsing plan_data, validate structure matches `PlanDataDTO` schema
- **Sanitization**: Table ID should be alphanumeric; prevent injection via parameterized queries (Supabase client handles this)

### Concurrency Control

- **Optimistic Locking**: Use `autosave_version` comparison in UPDATE WHERE clause
- **Atomic Updates**: Single UPDATE query ensures atomicity of version increment and data change
- **Conflict Resolution**: Return 409 VERSION_CONFLICT if version mismatch; client must refresh and retry

### Data Integrity

- **Transaction Safety**: Supabase handles transactional integrity; audit log insert should not block main update (use try-catch)
- **JSONB Validation**: Ensure plan_data structure remains valid after modification
- **Constraint Enforcement**: head_seat <= capacity validation prevents invalid state

### Audit Trail

- **Action Logging**: Every successful seat order change logged to `audit_log` with details
- **User Tracking**: `user_id` captured from authenticated session
- **Timestamp**: `created_at` automatically set via database default
- **Details Capture**: Old and new values stored in `details` JSONB for change tracking

### Lock Bypass Prevention

- **Lock Check**: Verify lock is not held by another user before allowing modification
- **Expiration Handling**: Allow modification if lock is expired (lock_expires_at < now())
- **Lock Owner Exception**: Allow modification if lock held by requesting user

### Error Information Disclosure

- **Generic Errors**: Don't expose internal database errors or stack traces to client
- **Sanitized Messages**: Return user-friendly error messages
- **Logging**: Log detailed errors server-side for debugging

## 7. Error Handling

### Error Classification and Handling Strategy

#### Client Errors (4xx)

**400 Bad Request - Input Validation Errors**

- **Trigger**: Zod schema validation failure, head_seat > capacity, invalid start_index
- **Handling**:
  ```typescript
  if (!validationResult.success) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Validation failed",
          details: validationResult.error.flatten(),
        },
      }),
      { status: 400 }
    );
  }
  ```
- **User Action**: Fix request body and retry

**401 Unauthorized**

- **Trigger**: No JWT token, invalid token, expired token
- **Handling**: Middleware should handle; route should check `context.locals.userId`
  ```typescript
  if (!userId) {
    return new Response(
      JSON.stringify({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required",
        },
      }),
      { status: 401 }
    );
  }
  ```
- **User Action**: Re-authenticate

**403 Forbidden**

- **Trigger**: User is not the event owner
- **Handling**:
  ```typescript
  if (event.owner_id !== userId) {
    return new Response(
      JSON.stringify({
        error: {
          code: "FORBIDDEN",
          message: "You do not have permission to modify this event",
        },
      }),
      { status: 403 }
    );
  }
  ```
- **User Action**: Cannot proceed; different user needed

**404 Not Found**

- **Trigger**: Event not found, event soft-deleted, table not found
- **Handling**:

  ```typescript
  if (!event || event.deleted_at !== null) {
    return new Response(
      JSON.stringify({
        error: {
          code: "EVENT_NOT_FOUND",
          message: "Event not found",
        },
      }),
      { status: 404 }
    );
  }

  if (!table) {
    return new Response(
      JSON.stringify({
        error: {
          code: "TABLE_NOT_FOUND",
          message: `Table '${tableId}' not found in event plan`,
        },
      }),
      { status: 404 }
    );
  }
  ```

- **User Action**: Verify event/table ID; may need to refresh data

**409 Conflict**

- **Triggers**:
  - Version conflict: `autosave_version` mismatch
  - Lock held: Another user has acquired lock and it hasn't expired
- **Handling**:

  ```typescript
  // Version conflict
  if (ifMatchVersion && event.autosave_version !== ifMatchVersion) {
    return new Response(
      JSON.stringify({
        error: {
          code: "VERSION_CONFLICT",
          message: "Event has been modified. Please refresh and retry.",
          details: {
            current_version: event.autosave_version,
            provided_version: ifMatchVersion,
          },
        },
      }),
      { status: 409 }
    );
  }

  // Lock held
  const lockHeldByOther =
    event.lock_held_by &&
    event.lock_held_by !== userId &&
    event.lock_expires_at &&
    new Date(event.lock_expires_at) > new Date();
  if (lockHeldByOther) {
    return new Response(
      JSON.stringify({
        error: {
          code: "LOCK_HELD",
          message: "Event is locked by another user",
          details: {
            held_by: event.lock_held_by,
            expires_at: event.lock_expires_at,
          },
        },
      }),
      { status: 409 }
    );
  }
  ```

- **User Action**: Refresh page to get latest version; wait for lock to expire or contact lock holder

#### Server Errors (5xx)

**500 Internal Server Error**

- **Triggers**: Database errors, unexpected exceptions, JSONB parsing failures
- **Handling**:
  ```typescript
  try {
    // ... operation
  } catch (error) {
    console.error("Error updating seat order:", {
      eventId,
      userId,
      tableId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

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
- **User Action**: Retry; contact support if persists
- **Developer Action**: Check logs, investigate database issues

### Error Logging Strategy

**Log Levels:**

- **ERROR**: All 500 errors, database failures, unexpected exceptions
- **WARN**: 409 conflicts, lock held situations (may indicate UI issues)
- **INFO**: Successful operations (optional, for analytics)

**Log Content:**

```typescript
interface ErrorLogEntry {
  timestamp: string;
  level: "ERROR" | "WARN" | "INFO";
  endpoint: string;
  userId: string;
  eventId: string;
  operation: string;
  errorCode?: string;
  errorMessage?: string;
  details?: Record<string, unknown>;
  stack?: string;
}
```

**Implementation:**

```typescript
const logError = (context: ErrorLogEntry) => {
  console.error(
    JSON.stringify({
      ...context,
      timestamp: new Date().toISOString(),
    })
  );
};
```

### Audit Log Failures

Audit logging failures should NOT block the main operation:

```typescript
try {
  await supabase.from('audit_log').insert({ ... });
} catch (auditError) {
  // Log but don't fail the request
  console.error('Failed to create audit log entry:', {
    eventId,
    userId,
    action: 'seat_order_changed',
    error: auditError
  });
  // Continue - main operation succeeded
}
```

## 8. Performance Considerations

### Expected Load

- **Request Frequency**: Low-medium (manual user actions, not bulk)
- **Concurrent Users**: 1-5 per event (typical small wedding planning team)
- **Data Size**: Plan data JSONB typically < 100KB for MVP events

### Potential Bottlenecks

1. **JSONB Parsing and Serialization**
   - Parsing large plan_data can be CPU-intensive
   - Mitigation: Acceptable for MVP; tables array typically small (< 50 tables)

2. **Database Roundtrips**
   - Multiple queries (SELECT event, UPDATE event, INSERT audit_log)
   - Mitigation: Use connection pooling; Supabase handles this

3. **Lock Contention**
   - Multiple simultaneous requests for same event
   - Mitigation: Optimistic locking with autosave_version prevents data corruption; users get clear conflict errors

4. **Audit Log Insert Latency**
   - Audit insert shouldn't block response
   - Mitigation: Use fire-and-forget pattern with error logging

### Optimization Strategies

**Current (MVP):**

- Keep all operations synchronous for simplicity and data consistency
- Rely on Supabase's optimized JSONB operations
- Use database indexes on `events.id` and `events.owner_id` (should exist)

**Future Optimizations (Post-MVP):**

- Consider moving audit logging to background queue (e.g., message queue)
- Implement caching layer for frequently accessed events (Redis)
- Use database triggers for audit logging instead of application code
- Add database index on `events.autosave_version` if version conflicts become common
- Implement JSONB partial updates if plan_data grows significantly large

### Response Time Targets

- **p50**: < 200ms
- **p95**: < 500ms
- **p99**: < 1000ms

### Monitoring Metrics

- Request duration by status code
- Version conflict rate (409 responses)
- Lock held conflict rate
- Audit log insertion failures
- JSONB parsing time

## 9. Implementation Steps

### Step 1: Create Service Layer Structure

**File**: `src/lib/services/event-plan.service.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/database.types";
import type { ChangeSeatOrderCommand, TableDTO, PlanDataDTO } from "../../types";

export class EventPlanService {
  constructor(private supabase: SupabaseClient<Database>) {}

  async updateTableSeatOrder(
    userId: string,
    eventId: string,
    command: ChangeSeatOrderCommand
  ): Promise<{ table: TableDTO; newVersion: number }> {
    // Implementation in Step 4
  }

  private validatePlanData(planData: unknown): PlanDataDTO {
    // Validate and cast plan_data JSONB
  }
}
```

**File**: `src/lib/services/audit.service.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/database.types";

export class AuditService {
  constructor(private supabase: SupabaseClient<Database>) {}

  async logSeatOrderChanged(
    eventId: string,
    userId: string,
    details: {
      table_id: string;
      old_start_index: number;
      new_start_index: number;
      old_head_seat: number;
      new_head_seat: number;
    }
  ): Promise<void> {
    try {
      await this.supabase.from("audit_log").insert({
        event_id: eventId,
        user_id: userId,
        action_type: "seat_order_changed",
        details: details as any, // Cast to satisfy JSONB type
      });
    } catch (error) {
      console.error("Audit log insertion failed:", { eventId, userId, error });
      // Don't throw - audit failure shouldn't block main operation
    }
  }
}
```

### Step 2: Create Validation Schema

**File**: `src/lib/validation/seat-order.schema.ts`

```typescript
import { z } from "zod";

export const ChangeSeatOrderSchema = z.object({
  table_id: z.string().min(1, "Table ID is required"),
  start_index: z.number().int().positive().min(1, "Start index must be at least 1"),
  head_seat: z.number().int().positive().min(1, "Head seat must be at least 1"),
  direction: z.enum(["clockwise"]).optional(),
});

export type ChangeSeatOrderInput = z.infer<typeof ChangeSeatOrderSchema>;
```

### Step 3: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/plan/seat-order.ts`

```typescript
import type { APIRoute } from "astro";
import { ChangeSeatOrderSchema } from "../../../../lib/validation/seat-order.schema";
import { EventPlanService } from "../../../../lib/services/event-plan.service";
import { AuditService } from "../../../../lib/services/audit.service";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    // Extract dependencies
    const supabase = context.locals.supabase;
    const userId = context.locals.userId;
    const eventId = context.params.event_id;

    // Authentication check
    if (!userId || !supabase) {
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

    // Validate event_id format
    if (!eventId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId)) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid event ID format",
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse and validate request body
    const body = await context.request.json();
    const validationResult = ChangeSeatOrderSchema.safeParse(body);

    if (!validationResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Validation failed",
            details: validationResult.error.flatten(),
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Extract If-Match header for version check
    const ifMatchHeader = context.request.headers.get("If-Match");
    const expectedVersion = ifMatchHeader ? parseInt(ifMatchHeader, 10) : undefined;

    // Initialize services
    const eventPlanService = new EventPlanService(supabase);
    const auditService = new AuditService(supabase);

    // Execute update
    const result = await eventPlanService.updateTableSeatOrder(userId, eventId, validationResult.data, expectedVersion);

    // Log to audit trail (fire-and-forget)
    const oldTable = result.oldTable; // Service should return this
    auditService.logSeatOrderChanged(eventId, userId, {
      table_id: validationResult.data.table_id,
      old_start_index: oldTable.start_index,
      new_start_index: validationResult.data.start_index,
      old_head_seat: oldTable.head_seat,
      new_head_seat: validationResult.data.head_seat,
    });

    // Return success response
    return new Response(JSON.stringify(result.table), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: result.newVersion.toString(),
      },
    });
  } catch (error: any) {
    // Handle known error types
    if (error.code === "EVENT_NOT_FOUND") {
      return new Response(
        JSON.stringify({
          error: {
            code: "EVENT_NOT_FOUND",
            message: error.message,
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.code === "TABLE_NOT_FOUND") {
      return new Response(
        JSON.stringify({
          error: {
            code: "TABLE_NOT_FOUND",
            message: error.message,
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.code === "FORBIDDEN") {
      return new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: error.message,
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.code === "VERSION_CONFLICT") {
      return new Response(
        JSON.stringify({
          error: {
            code: "VERSION_CONFLICT",
            message: error.message,
            details: error.details,
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.code === "LOCK_HELD") {
      return new Response(
        JSON.stringify({
          error: {
            code: "LOCK_HELD",
            message: error.message,
            details: error.details,
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.code === "INVALID_SEAT_NUMBER") {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_SEAT_NUMBER",
            message: error.message,
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Log unexpected errors
    console.error("Unexpected error in seat-order endpoint:", {
      eventId: context.params.event_id,
      userId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Return generic error
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
};
```

### Step 4: Implement Service Logic

**File**: `src/lib/services/event-plan.service.ts` (full implementation)

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "../../db/database.types";
import type { ChangeSeatOrderCommand, TableDTO, PlanDataDTO } from "../../types";

class ServiceError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export class EventPlanService {
  constructor(private supabase: SupabaseClient<Database>) {}

  async updateTableSeatOrder(
    userId: string,
    eventId: string,
    command: ChangeSeatOrderCommand,
    expectedVersion?: number
  ): Promise<{ table: TableDTO; newVersion: number; oldTable: TableDTO }> {
    // Step 1: Fetch event
    const { data: event, error: fetchError } = await this.supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .is("deleted_at", null)
      .single();

    if (fetchError || !event) {
      throw new ServiceError("EVENT_NOT_FOUND", "Event not found");
    }

    // Step 2: Verify ownership
    if (event.owner_id !== userId) {
      throw new ServiceError("FORBIDDEN", "You do not have permission to modify this event");
    }

    // Step 3: Check version conflict
    if (expectedVersion !== undefined && event.autosave_version !== expectedVersion) {
      throw new ServiceError("VERSION_CONFLICT", "Event has been modified. Please refresh and retry.", {
        current_version: event.autosave_version,
        provided_version: expectedVersion,
      });
    }

    // Step 4: Check lock status
    const lockHeldByOther =
      event.lock_held_by &&
      event.lock_held_by !== userId &&
      event.lock_expires_at &&
      new Date(event.lock_expires_at) > new Date();

    if (lockHeldByOther) {
      throw new ServiceError("LOCK_HELD", "Event is locked by another user", {
        held_by: event.lock_held_by,
        expires_at: event.lock_expires_at,
      });
    }

    // Step 5: Parse and validate plan_data
    const planData = this.validatePlanData(event.plan_data);

    // Step 6: Find target table
    const tableIndex = planData.tables.findIndex((t) => t.id === command.table_id);
    if (tableIndex === -1) {
      throw new ServiceError("TABLE_NOT_FOUND", `Table '${command.table_id}' not found in event plan`);
    }

    const oldTable = { ...planData.tables[tableIndex] };

    // Step 7: Validate head_seat against capacity
    if (command.head_seat > oldTable.capacity) {
      throw new ServiceError(
        "INVALID_SEAT_NUMBER",
        `Head seat ${command.head_seat} exceeds table capacity ${oldTable.capacity}`
      );
    }

    // Step 8: Update table properties
    const updatedTable: TableDTO = {
      ...oldTable,
      start_index: command.start_index,
      head_seat: command.head_seat,
      // direction not stored in current schema; reserved for future
    };

    // Step 9: Update plan_data
    const updatedPlanData: PlanDataDTO = {
      ...planData,
      tables: [...planData.tables.slice(0, tableIndex), updatedTable, ...planData.tables.slice(tableIndex + 1)],
    };

    // Step 10: Persist to database with optimistic lock
    const newVersion = event.autosave_version + 1;
    const { data: updatedEvent, error: updateError } = await this.supabase
      .from("events")
      .update({
        plan_data: updatedPlanData as any, // Cast to satisfy JSONB type
        autosave_version: newVersion,
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .eq("autosave_version", event.autosave_version) // Optimistic lock
      .select()
      .single();

    if (updateError) {
      // Check if optimistic lock failed (no rows updated)
      if (updateError.code === "PGRST116") {
        throw new ServiceError("VERSION_CONFLICT", "Event was modified concurrently. Please refresh and retry.", {
          current_version: event.autosave_version + 1, // Estimate
          provided_version: event.autosave_version,
        });
      }

      console.error("Database update error:", updateError);
      throw new ServiceError("INTERNAL_ERROR", "Failed to update event");
    }

    // Step 11: Return updated table and new version
    return {
      table: updatedTable,
      newVersion,
      oldTable,
    };
  }

  private validatePlanData(planData: unknown): PlanDataDTO {
    // Basic runtime validation
    if (!planData || typeof planData !== "object") {
      throw new ServiceError("INTERNAL_ERROR", "Invalid plan_data structure");
    }

    const data = planData as any;

    if (!Array.isArray(data.tables)) {
      throw new ServiceError("INTERNAL_ERROR", "plan_data.tables must be an array");
    }

    if (!Array.isArray(data.guests)) {
      throw new ServiceError("INTERNAL_ERROR", "plan_data.guests must be an array");
    }

    // Could add more rigorous validation with Zod schema for plan_data
    return data as PlanDataDTO;
  }
}
```

### Step 5: Update Middleware (if not already configured)

**File**: `src/middleware/index.ts`

Ensure middleware extracts userId from Supabase session:

```typescript
import { defineMiddleware } from "astro:middleware";
import { createServerClient } from "@supabase/ssr";

export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createServerClient(import.meta.env.PUBLIC_SUPABASE_URL, import.meta.env.PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      get: (key) => context.cookies.get(key)?.value,
      set: (key, value, options) => context.cookies.set(key, value, options),
      remove: (key, options) => context.cookies.delete(key, options),
    },
  });

  // Get user session
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Attach to context
  context.locals.supabase = supabase;
  context.locals.userId = user?.id;

  return next();
});
```

### Step 6: Add TypeScript Definitions for Context Locals

**File**: `src/env.d.ts`

```typescript
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string;
  readonly PUBLIC_SUPABASE_ANON_KEY: string;
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace App {
  interface Locals {
    supabase: import("./db/supabase.client").SupabaseClient;
    userId?: string;
  }
}
```

### Step 7: Write Unit Tests

**File**: `src/lib/services/__tests__/event-plan.service.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventPlanService } from "../event-plan.service";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("EventPlanService.updateTableSeatOrder", () => {
  let mockSupabase: any;
  let service: EventPlanService;

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
      update: vi.fn(() => mockSupabase),
      eq: vi.fn(() => mockSupabase),
      is: vi.fn(() => mockSupabase),
      single: vi.fn(),
    };
    service = new EventPlanService(mockSupabase as any);
  });

  it("should update table seat order successfully", async () => {
    const mockEvent = {
      id: "event-1",
      owner_id: "user-1",
      autosave_version: 5,
      lock_held_by: null,
      lock_expires_at: null,
      deleted_at: null,
      plan_data: {
        tables: [{ id: "t1", capacity: 10, start_index: 1, head_seat: 1, seats: [] }],
        guests: [],
        settings: { color_palette: "default" },
      },
    };

    mockSupabase.single
      .mockResolvedValueOnce({ data: mockEvent, error: null })
      .mockResolvedValueOnce({ data: { ...mockEvent, autosave_version: 6 }, error: null });

    const result = await service.updateTableSeatOrder("user-1", "event-1", {
      table_id: "t1",
      start_index: 2,
      head_seat: 3,
    });

    expect(result.table.start_index).toBe(2);
    expect(result.table.head_seat).toBe(3);
    expect(result.newVersion).toBe(6);
  });

  it("should throw EVENT_NOT_FOUND for non-existent event", async () => {
    mockSupabase.single.mockResolvedValue({ data: null, error: { code: "404" } });

    await expect(
      service.updateTableSeatOrder("user-1", "event-999", {
        table_id: "t1",
        start_index: 1,
        head_seat: 1,
      })
    ).rejects.toThrow("Event not found");
  });

  it("should throw FORBIDDEN for non-owner", async () => {
    const mockEvent = {
      id: "event-1",
      owner_id: "user-2",
      autosave_version: 5,
      deleted_at: null,
      plan_data: { tables: [], guests: [], settings: {} },
    };

    mockSupabase.single.mockResolvedValue({ data: mockEvent, error: null });

    await expect(
      service.updateTableSeatOrder("user-1", "event-1", {
        table_id: "t1",
        start_index: 1,
        head_seat: 1,
      })
    ).rejects.toThrow("You do not have permission");
  });

  it("should throw INVALID_SEAT_NUMBER when head_seat exceeds capacity", async () => {
    const mockEvent = {
      id: "event-1",
      owner_id: "user-1",
      autosave_version: 5,
      lock_held_by: null,
      deleted_at: null,
      plan_data: {
        tables: [{ id: "t1", capacity: 10, start_index: 1, head_seat: 1, seats: [] }],
        guests: [],
        settings: {},
      },
    };

    mockSupabase.single.mockResolvedValue({ data: mockEvent, error: null });

    await expect(
      service.updateTableSeatOrder("user-1", "event-1", {
        table_id: "t1",
        start_index: 1,
        head_seat: 15,
      })
    ).rejects.toThrow("exceeds table capacity");
  });
});
```

### Step 8: Write Integration Tests

**File**: `src/pages/api/events/__tests__/seat-order.integration.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";

describe("POST /api/events/{event_id}/plan/seat-order", () => {
  let supabase: any;
  let authToken: string;
  let eventId: string;

  beforeAll(async () => {
    // Setup test database and authenticate
    supabase = createClient(process.env.PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

    // Create test user and event
    // ... setup code
  });

  afterAll(async () => {
    // Cleanup test data
  });

  it("should update seat order and return updated table", async () => {
    const response = await fetch(`http://localhost:4321/api/events/${eventId}/plan/seat-order`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        table_id: "t1",
        start_index: 2,
        head_seat: 5,
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.start_index).toBe(2);
    expect(data.head_seat).toBe(5);
  });

  it("should return 400 for invalid input", async () => {
    const response = await fetch(`http://localhost:4321/api/events/${eventId}/plan/seat-order`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        table_id: "t1",
        start_index: -1, // Invalid
        head_seat: 5,
      }),
    });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error.code).toBe("INVALID_INPUT");
  });

  it("should return 401 without authentication", async () => {
    const response = await fetch(`http://localhost:4321/api/events/${eventId}/plan/seat-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        table_id: "t1",
        start_index: 1,
        head_seat: 1,
      }),
    });

    expect(response.status).toBe(401);
  });
});
```

### Step 9: Update API Documentation

**File**: `docs/api/events-plan-seat-order.md`

Create comprehensive API documentation with:

- Endpoint description
- Request/response examples
- Error scenarios
- Code samples in different languages
- Rate limiting info (if applicable)

### Step 10: Add Monitoring and Logging

**File**: `src/lib/monitoring/logger.ts`

```typescript
export interface LogContext {
  endpoint: string;
  userId?: string;
  eventId?: string;
  duration?: number;
  statusCode?: number;
  errorCode?: string;
  [key: string]: unknown;
}

export const logger = {
  info: (message: string, context?: LogContext) => {
    console.log(
      JSON.stringify({
        level: "INFO",
        timestamp: new Date().toISOString(),
        message,
        ...context,
      })
    );
  },

  error: (message: string, context?: LogContext) => {
    console.error(
      JSON.stringify({
        level: "ERROR",
        timestamp: new Date().toISOString(),
        message,
        ...context,
      })
    );
  },

  warn: (message: string, context?: LogContext) => {
    console.warn(
      JSON.stringify({
        level: "WARN",
        timestamp: new Date().toISOString(),
        message,
        ...context,
      })
    );
  },
};
```

Use in route handler:

```typescript
import { logger } from "../../../../lib/monitoring/logger";

// In route handler
const startTime = Date.now();

// ... operation

logger.info("Seat order updated successfully", {
  endpoint: "POST /api/events/:id/plan/seat-order",
  userId,
  eventId,
  duration: Date.now() - startTime,
  statusCode: 200,
});
```

### Step 11: Deploy and Verify

1. **Local Testing**: Run `npm run dev` and test endpoint manually
2. **Run Test Suite**: Execute `npm run test` to verify all tests pass
3. **Check Linting**: Run `npm run lint` and fix any issues
4. **Type Checking**: Run `npm run type-check` to ensure TypeScript correctness
5. **Build Verification**: Run `npm run build` to ensure production build succeeds
6. **Staging Deployment**: Deploy to staging environment
7. **Smoke Testing**: Execute basic smoke tests on staging
8. **Production Deployment**: Deploy to production
9. **Monitor Logs**: Watch logs for errors or performance issues
10. **Update Status Page**: Mark endpoint as available in API status dashboard

---

## Summary

This implementation plan provides a complete roadmap for developing the `POST /api/events/{event_id}/plan/seat-order` endpoint. The plan emphasizes:

- **Type Safety**: Comprehensive TypeScript types and Zod validation
- **Security**: JWT authentication, ownership verification, lock checking, optimistic locking
- **Error Handling**: Detailed error scenarios with appropriate status codes
- **Performance**: Efficient JSONB operations with minimal database roundtrips
- **Maintainability**: Service layer separation, comprehensive testing, structured logging
- **Compliance**: Audit logging for regulatory requirements

The implementation follows the project's architectural guidelines (Astro 5, TypeScript 5, Supabase, React 19, Tailwind 4) and adheres to coding best practices outlined in the project documentation.
