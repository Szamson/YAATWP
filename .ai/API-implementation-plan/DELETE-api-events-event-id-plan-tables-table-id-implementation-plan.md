# API Endpoint Implementation Plan: DELETE /api/events/{event_id}/plan/tables/{table_id}

## 1. Endpoint Overview

This endpoint removes a table from an event's seating plan. When a table is deleted, all guests assigned to seats at that table become unseated but remain in the event's guest list. The operation increments the event's autosave version and creates an audit log entry. The endpoint responds with `204 No Content` on success.

**Key Behaviors:**

- Removes the specified table from `events.plan_data.tables` array
- Unassigns all guests seated at the table (removes their seat assignments)
- Guests remain in `events.plan_data.guests` array (unseated state)
- Increments `autosave_version` for optimistic concurrency control
- Creates audit log entry with action type `table_update` or similar
- Requires event ownership or active lock
- Supports concurrent modification detection via `If-Match` header

## 2. Request Details

- **HTTP Method**: DELETE
- **URL Structure**: `/api/events/{event_id}/plan/tables/{table_id}`
- **Authentication**: Required (Supabase JWT via `Authorization: Bearer <token>`)

### Path Parameters

| Parameter | Type   | Required | Description                                  |
| --------- | ------ | -------- | -------------------------------------------- |
| event_id  | UUID   | Yes      | The unique identifier of the event           |
| table_id  | string | Yes      | The identifier of the table within plan_data |

### Headers

| Header        | Type   | Required | Description                                                 |
| ------------- | ------ | -------- | ----------------------------------------------------------- |
| Authorization | string | Yes      | Bearer token containing Supabase JWT                        |
| If-Match      | string | No       | Current autosave_version for optimistic concurrency control |

### Request Body

None (DELETE operation with path parameters only).

### Validation Rules

- **event_id**:
  - Must be a valid UUID v4 format
  - Must reference an existing event
  - Event must not be soft-deleted (`deleted_at` is null)
- **table_id**:
  - Must be a non-empty string
  - Should match pattern: alphanumeric characters, hyphens, underscores (e.g., `/^[a-zA-Z0-9_-]+$/`)
  - Must exist in `plan_data.tables` array
- **Authorization**:
  - User must be authenticated
  - User must be the event owner (`owner_id` matches JWT user_id)
  - OR user must hold an active lock (`lock_held_by` matches user_id and `lock_expires_at` > now)
- **If-Match** (if provided):
  - Must match current `autosave_version` of the event

## 3. Used Types

### Command Models

```typescript
// From types.ts
export type DeleteTableCommand = Record<string, never>; // Path-driven marker
```

### DTOs

```typescript
// From types.ts
export interface PlanDataDTO {
  tables: TableDTO[];
  guests: GuestDTO[];
  settings: PlanSettingsDTO;
}

export interface TableDTO {
  id: string;
  shape: Enums<"table_shape_enum">;
  capacity: number;
  label?: string;
  start_index: number;
  head_seat: number;
  seats: SeatAssignmentDTO[];
}

export interface SeatAssignmentDTO {
  seat_no: number;
  guest_id?: string;
}

export interface GuestDTO {
  id: string;
  name: string;
  note?: string;
  tag?: string;
  rsvp?: string;
}

export interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Internal Service Types

```typescript
// For service layer
interface DeleteTableResult {
  autosave_version: number;
  plan_data: PlanDataDTO;
  unseated_guest_ids: string[];
}
```

## 4. Response Details

### Success Response

**Status Code**: `204 No Content`

**Headers**:

```
ETag: "<new_autosave_version>"
```

**Body**: Empty

### Error Responses

#### 400 Bad Request

Invalid input (malformed UUID, invalid table_id format).

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid event_id format",
    "details": {
      "field": "event_id",
      "value": "not-a-uuid"
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

#### 404 Not Found

Event or table not found, or event is soft-deleted.

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
    "message": "Table with specified ID does not exist in the event plan",
    "details": {
      "table_id": "t123"
    }
  }
}
```

#### 409 Conflict

Version mismatch or lock conflict.

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Event has been modified. Please refresh and try again.",
    "details": {
      "expected_version": 5,
      "current_version": 7
    }
  }
}
```

```json
{
  "error": {
    "code": "LOCK_CONFLICT",
    "message": "Event is locked by another user",
    "details": {
      "held_by": "user-uuid",
      "expires_at": "2025-11-01T15:30:00Z"
    }
  }
}
```

#### 500 Internal Server Error

Unexpected server-side errors.

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

1. **Request Reception**: Astro API route receives DELETE request
2. **Authentication**: Extract and verify Supabase JWT from Authorization header
3. **Path Parameter Extraction**: Parse `event_id` and `table_id` from URL
4. **Input Validation**: Validate UUID format and table_id pattern
5. **Service Invocation**: Call `EventPlanService.deleteTable()`
6. **Authorization Check**: Verify user owns event or holds lock
7. **Concurrency Check**: Validate If-Match header against current version
8. **Event Retrieval**: Fetch event with current plan_data from database
9. **Table Existence Check**: Verify table exists in plan_data.tables
10. **Plan Mutation**:
    - Remove table from tables array
    - Find all guests with seat assignments to this table
    - Remove those seat assignments (set guest seat references to undefined/null)
11. **Database Update**:
    - Update events.plan_data with modified structure
    - Increment events.autosave_version
    - Update events.updated_at timestamp
12. **Audit Logging**: Create audit_log entry with action_type 'table_update' or 'table_delete'
13. **Response**: Return 204 No Content with ETag header

### Database Interactions

**Tables Accessed:**

- `events` (read and update)
- `audit_log` (insert)
- `auth.users` (implicit via RLS/JWT validation)

**Transaction Boundary:**
The entire operation should be wrapped in a database transaction to ensure atomicity:

```sql
BEGIN;
  -- 1. SELECT event with FOR UPDATE to lock row
  -- 2. Validate ownership/lock
  -- 3. Validate version (if If-Match provided)
  -- 4. UPDATE plan_data and autosave_version
  -- 5. INSERT audit_log entry
COMMIT;
```

### JSONB Manipulation Strategy

Using PostgreSQL JSONB operators:

```sql
UPDATE events
SET
  plan_data = jsonb_set(
    plan_data,
    '{tables}',
    (
      SELECT jsonb_agg(table_elem)
      FROM jsonb_array_elements(plan_data->'tables') AS table_elem
      WHERE table_elem->>'id' != $table_id
    )
  ),
  autosave_version = autosave_version + 1,
  updated_at = NOW()
WHERE id = $event_id
  AND deleted_at IS NULL
  AND (owner_id = $user_id OR lock_held_by = $user_id)
RETURNING autosave_version, plan_data;
```

For unseating guests (remove guest_id from seats), use application logic to:

1. Find the table being deleted
2. Extract all guest_ids from its seats array
3. Iterate through all remaining tables and clear those guest_ids from their seats

Alternatively, handle guest unseating in the application layer for clarity.

## 6. Security Considerations

### Authentication

- **JWT Validation**: Use Supabase client from `context.locals` (per implementation rules)
- **Token Extraction**: Parse Bearer token from Authorization header
- **Session Validation**: Ensure token is not expired and user exists

### Authorization

- **Ownership Check**: Verify `events.owner_id` matches authenticated user's ID
- **Lock Check**: If event is locked (`lock_held_by` is not null), verify:
  - Lock is held by current user, OR
  - Lock has expired (`lock_expires_at` < now())
- **Soft Delete Check**: Ensure `events.deleted_at` is null

### Row-Level Security (RLS)

- Leverage Supabase RLS policies on `events` table to enforce ownership
- Service role operations (if needed) should be minimized and well-audited

### Input Sanitization

- **UUID Validation**: Use Zod schema to validate event_id format
- **table_id Sanitization**: Validate against safe pattern to prevent JSONB injection
- **Header Validation**: Sanitize If-Match header value

### Concurrency Protection

- **Optimistic Locking**: Use If-Match header with autosave_version
- **Database Row Locking**: Use SELECT ... FOR UPDATE in transaction to prevent race conditions
- **Lock Expiry**: Respect lock_expires_at to prevent stale locks

### Audit Trail

- Log all deletions to `audit_log` with:
  - `event_id`
  - `user_id`
  - `action_type`: 'table_update' (or add 'table_delete' to enum if not present)
  - `details`: JSONB with table_id, unseated_guest_count, table metadata

### Rate Limiting

- Consider implementing rate limits to prevent abuse (e.g., max 100 table deletions per minute per user)
- Use middleware or Supabase Edge Functions for rate limiting

## 7. Error Handling

### Validation Errors (400)

**Scenario**: Invalid event_id format

```typescript
if (!isValidUUID(event_id)) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_INPUT",
        message: "Invalid event_id format",
        details: { field: "event_id", value: event_id },
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}
```

**Scenario**: Invalid table_id format

```typescript
if (!/^[a-zA-Z0-9_-]+$/.test(table_id)) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_INPUT",
        message: "Invalid table_id format",
        details: { field: "table_id", value: table_id },
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}
```

### Authentication Errors (401)

**Scenario**: Missing or invalid JWT

```typescript
const {
  data: { user },
  error,
} = await supabase.auth.getUser();
if (error || !user) {
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

### Authorization Errors (404 to avoid info leak)

**Scenario**: User does not own event

- Return 404 instead of 403 to avoid leaking information about event existence

```typescript
// Handled by ownership check in service layer
throw new Error("EVENT_NOT_FOUND");
```

### Not Found Errors (404)

**Scenario**: Event does not exist or is soft-deleted

```typescript
if (!event || event.deleted_at !== null) {
  return new Response(
    JSON.stringify({
      error: {
        code: "EVENT_NOT_FOUND",
        message: "Event not found or has been deleted",
      },
    }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}
```

**Scenario**: Table does not exist in plan_data

```typescript
const tableExists = event.plan_data.tables.some((t) => t.id === table_id);
if (!tableExists) {
  return new Response(
    JSON.stringify({
      error: {
        code: "TABLE_NOT_FOUND",
        message: "Table with specified ID does not exist in the event plan",
        details: { table_id },
      },
    }),
    { status: 404, headers: { "Content-Type": "application/json" } }
  );
}
```

### Conflict Errors (409)

**Scenario**: Version mismatch (If-Match header doesn't match)

```typescript
const ifMatchVersion = parseInt(request.headers.get("If-Match") || "");
if (ifMatchVersion && ifMatchVersion !== event.autosave_version) {
  return new Response(
    JSON.stringify({
      error: {
        code: "VERSION_CONFLICT",
        message: "Event has been modified. Please refresh and try again.",
        details: {
          expected_version: ifMatchVersion,
          current_version: event.autosave_version,
        },
      },
    }),
    { status: 409, headers: { "Content-Type": "application/json" } }
  );
}
```

**Scenario**: Lock held by another user

```typescript
if (event.lock_held_by && event.lock_held_by !== user.id) {
  if (new Date(event.lock_expires_at!) > new Date()) {
    return new Response(
      JSON.stringify({
        error: {
          code: "LOCK_CONFLICT",
          message: "Event is locked by another user",
          details: {
            held_by: event.lock_held_by,
            expires_at: event.lock_expires_at,
          },
        },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  }
}
```

### Server Errors (500)

**Scenario**: Database connection failure, unexpected errors

```typescript
try {
  // ... operation logic
} catch (error) {
  console.error("Error deleting table:", error);
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

### Error Logging Strategy

- Log all errors with context (user_id, event_id, table_id, stack trace)
- Use structured logging for easier querying
- Don't expose sensitive details in error responses (e.g., internal DB errors)
- Create audit_log entry for failed attempts if appropriate (security audit)

## 8. Performance Considerations

### Potential Bottlenecks

1. **JSONB Array Manipulation**: Removing elements from large tables/guests arrays can be slow
   - **Mitigation**: Use efficient JSONB operators; consider indexing on plan_data paths if query patterns emerge

2. **Transaction Lock Contention**: Multiple concurrent edits to same event
   - **Mitigation**: Use row-level locking with reasonable timeout; encourage lock acquisition pattern

3. **Large Plan Data**: Events with hundreds of tables/guests
   - **Mitigation**:
     - Limit max tables per event (business rule)
     - Consider pagination for large plan_data retrieval (though not for this endpoint)
     - Use JSONB containment operators efficiently

4. **Audit Log Inserts**: High-frequency deletions creating many audit rows
   - **Mitigation**: Batch audit logging or use asynchronous logging (background worker)

### Optimization Strategies

1. **Database Indexes**:

   ```sql
   CREATE INDEX idx_events_owner_id ON events(owner_id);
   CREATE INDEX idx_events_deleted_at ON events(deleted_at) WHERE deleted_at IS NULL;
   CREATE INDEX idx_events_lock_held_by ON events(lock_held_by);
   ```

2. **Query Optimization**:
   - Use `SELECT FOR UPDATE NOWAIT` to fail fast on lock conflicts
   - Return only necessary fields in database queries
   - Use prepared statements to reduce parsing overhead

3. **Application-Level Caching** (future consideration):
   - Cache event ownership checks for duration of request
   - Use Redis for lock status if lock mechanism becomes bottleneck

4. **JSONB Handling**:
   - Parse plan_data only once per request
   - Use immutable update patterns to avoid deep cloning

### Response Time Targets

- **Target**: < 200ms for p95
- **Acceptable**: < 500ms for p99
- **Monitor**: Database query time, JSONB manipulation time, transaction duration

## 9. Implementation Steps

### Step 1: Create Event Plan Service

**File**: `src/lib/services/event-plan.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UUID, PlanDataDTO } from "../types";

interface DeleteTableResult {
  autosave_version: number;
  plan_data: PlanDataDTO;
  unseated_guest_ids: string[];
}

export async function deleteTable(
  supabase: SupabaseClient,
  eventId: UUID,
  tableId: string,
  userId: UUID,
  expectedVersion?: number
): Promise<DeleteTableResult> {
  // Implementation in next steps
}
```

### Step 2: Implement Service Logic

Within `deleteTable` function:

1. **Fetch event with lock**:

   ```typescript
   const { data: event, error } = await supabase
     .from("events")
     .select("*")
     .eq("id", eventId)
     .is("deleted_at", null)
     .single();

   if (error || !event) {
     throw new Error("EVENT_NOT_FOUND");
   }
   ```

2. **Verify authorization**:

   ```typescript
   const isOwner = event.owner_id === userId;
   const holdsLock = event.lock_held_by === userId && new Date(event.lock_expires_at!) > new Date();

   if (!isOwner && !holdsLock) {
     throw new Error("EVENT_NOT_FOUND"); // 404 to avoid info leak
   }
   ```

3. **Verify version** (if provided):

   ```typescript
   if (expectedVersion !== undefined && event.autosave_version !== expectedVersion) {
     throw new Error("VERSION_CONFLICT");
   }
   ```

4. **Validate table exists**:

   ```typescript
   const planData = event.plan_data as PlanDataDTO;
   const tableIndex = planData.tables.findIndex((t) => t.id === tableId);

   if (tableIndex === -1) {
     throw new Error("TABLE_NOT_FOUND");
   }
   ```

5. **Collect unseated guest IDs**:

   ```typescript
   const deletedTable = planData.tables[tableIndex];
   const unseatedGuestIds = deletedTable.seats.filter((s) => s.guest_id).map((s) => s.guest_id!);
   ```

6. **Remove table from array**:

   ```typescript
   const updatedTables = planData.tables.filter((t) => t.id !== tableId);
   ```

7. **Update plan_data and increment version**:

   ```typescript
   const updatedPlanData: PlanDataDTO = {
     ...planData,
     tables: updatedTables,
   };

   const { data: updatedEvent, error: updateError } = await supabase
     .from("events")
     .update({
       plan_data: updatedPlanData,
       autosave_version: event.autosave_version + 1,
       updated_at: new Date().toISOString(),
     })
     .eq("id", eventId)
     .select()
     .single();

   if (updateError) {
     throw new Error("UPDATE_FAILED");
   }
   ```

8. **Create audit log entry**:

   ```typescript
   await supabase.from("audit_log").insert({
     event_id: eventId,
     user_id: userId,
     action_type: "table_update", // or 'table_delete' if added to enum
     details: {
       table_id: tableId,
       table_label: deletedTable.label,
       unseated_count: unseatedGuestIds.length,
       capacity: deletedTable.capacity,
     },
   });
   ```

9. **Return result**:
   ```typescript
   return {
     autosave_version: updatedEvent.autosave_version,
     plan_data: updatedEvent.plan_data as PlanDataDTO,
     unseated_guest_ids: unseatedGuestIds,
   };
   ```

### Step 3: Create Zod Validation Schema

**File**: `src/lib/schemas/event-plan.schema.ts`

```typescript
import { z } from "zod";

export const deleteTableParamsSchema = z.object({
  event_id: z.string().uuid("Invalid event_id format"),
  table_id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Invalid table_id format"),
});

export const ifMatchHeaderSchema = z.string().regex(/^\d+$/).transform(Number).optional();
```

### Step 4: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/plan/tables/[table_id].ts`

```typescript
import type { APIRoute } from "astro";
import { deleteTableParamsSchema, ifMatchHeaderSchema } from "../../../../../lib/schemas/event-plan.schema";
import { deleteTable } from "../../../../../lib/services/event-plan.service";

export const prerender = false;

export const DELETE: APIRoute = async ({ params, request, locals }) => {
  try {
    // 1. Get Supabase client and authenticate
    const supabase = locals.supabase;
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
        }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Validate path parameters
    const paramsResult = deleteTableParamsSchema.safeParse(params);
    if (!paramsResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid request parameters",
            details: paramsResult.error.format(),
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { event_id, table_id } = paramsResult.data;

    // 3. Parse If-Match header (optional)
    const ifMatch = request.headers.get("If-Match");
    const versionResult = ifMatchHeaderSchema.safeParse(ifMatch);
    const expectedVersion = versionResult.success ? versionResult.data : undefined;

    // 4. Call service to delete table
    const result = await deleteTable(supabase, event_id, table_id, user.id, expectedVersion);

    // 5. Return 204 No Content with ETag
    return new Response(null, {
      status: 204,
      headers: {
        ETag: result.autosave_version.toString(),
      },
    });
  } catch (error: any) {
    // Handle specific error types
    if (error.message === "EVENT_NOT_FOUND") {
      return new Response(
        JSON.stringify({
          error: {
            code: "EVENT_NOT_FOUND",
            message: "Event not found or has been deleted",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.message === "TABLE_NOT_FOUND") {
      return new Response(
        JSON.stringify({
          error: {
            code: "TABLE_NOT_FOUND",
            message: "Table with specified ID does not exist in the event plan",
            details: { table_id: params.table_id },
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error.message === "VERSION_CONFLICT") {
      return new Response(
        JSON.stringify({
          error: {
            code: "VERSION_CONFLICT",
            message: "Event has been modified. Please refresh and try again.",
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // Generic error handler
    console.error("Error deleting table:", error);
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

### Step 5: Add Error Handling for Lock Conflicts

Extend service logic to handle lock conflicts:

```typescript
// In deleteTable service function, after ownership check:
if (event.lock_held_by && event.lock_held_by !== userId) {
  const lockExpired = new Date(event.lock_expires_at!) <= new Date();
  if (!lockExpired) {
    const error = new Error("LOCK_CONFLICT") as any;
    error.details = {
      held_by: event.lock_held_by,
      expires_at: event.lock_expires_at,
    };
    throw error;
  }
}
```

Add corresponding error handler in route:

```typescript
if (error.message === "LOCK_CONFLICT") {
  return new Response(
    JSON.stringify({
      error: {
        code: "LOCK_CONFLICT",
        message: "Event is locked by another user",
        details: error.details,
      },
    }),
    { status: 409, headers: { "Content-Type": "application/json" } }
  );
}
```

### Step 6: Implement Transaction Safety

Wrap database operations in a transaction (if Supabase client supports it, or use RPC):

**Option A**: Use Supabase RPC with transaction

```sql
-- Create a PostgreSQL function
CREATE OR REPLACE FUNCTION delete_table_from_event(
  p_event_id uuid,
  p_table_id text,
  p_user_id uuid,
  p_expected_version int
) RETURNS jsonb AS $$
DECLARE
  v_event record;
  v_plan_data jsonb;
  v_updated_tables jsonb;
  v_new_version int;
BEGIN
  -- Lock row
  SELECT * INTO v_event
  FROM events
  WHERE id = p_event_id
    AND deleted_at IS NULL
  FOR UPDATE NOWAIT;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EVENT_NOT_FOUND';
  END IF;

  -- Check authorization
  IF v_event.owner_id != p_user_id AND
     (v_event.lock_held_by IS NULL OR v_event.lock_held_by != p_user_id OR v_event.lock_expires_at < NOW()) THEN
    RAISE EXCEPTION 'EVENT_NOT_FOUND';
  END IF;

  -- Check version
  IF p_expected_version IS NOT NULL AND v_event.autosave_version != p_expected_version THEN
    RAISE EXCEPTION 'VERSION_CONFLICT';
  END IF;

  -- Remove table from plan_data
  v_plan_data := v_event.plan_data;
  v_updated_tables := (
    SELECT jsonb_agg(table_elem)
    FROM jsonb_array_elements(v_plan_data->'tables') AS table_elem
    WHERE table_elem->>'id' != p_table_id
  );

  -- Check if table existed
  IF jsonb_array_length(v_updated_tables) = jsonb_array_length(v_plan_data->'tables') THEN
    RAISE EXCEPTION 'TABLE_NOT_FOUND';
  END IF;

  v_plan_data := jsonb_set(v_plan_data, '{tables}', v_updated_tables);
  v_new_version := v_event.autosave_version + 1;

  -- Update event
  UPDATE events
  SET plan_data = v_plan_data,
      autosave_version = v_new_version,
      updated_at = NOW()
  WHERE id = p_event_id;

  -- Insert audit log
  INSERT INTO audit_log (event_id, user_id, action_type, details)
  VALUES (p_event_id, p_user_id, 'table_update', jsonb_build_object('table_id', p_table_id));

  -- Return result
  RETURN jsonb_build_object(
    'autosave_version', v_new_version,
    'plan_data', v_plan_data
  );
END;
$$ LANGUAGE plpgsql;
```

Call from service:

```typescript
const { data, error } = await supabase.rpc("delete_table_from_event", {
  p_event_id: eventId,
  p_table_id: tableId,
  p_user_id: userId,
  p_expected_version: expectedVersion,
});
```

**Option B**: Handle in application with manual transaction management (if supported by client)

### Step 7: Add Integration Tests

**File**: `tests/api/delete-table.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
// ... test setup

describe("DELETE /api/events/{event_id}/plan/tables/{table_id}", () => {
  it("should delete table successfully", async () => {
    // Arrange: create event with table
    // Act: send DELETE request
    // Assert: expect 204, verify table removed from plan_data
  });

  it("should unseate guests when table is deleted", async () => {
    // Arrange: create event with table and seated guests
    // Act: delete table
    // Assert: verify guests remain in guest list but unseated
  });

  it("should return 404 for non-existent event", async () => {
    // Act & Assert
  });

  it("should return 404 for non-existent table", async () => {
    // Act & Assert
  });

  it("should return 409 on version conflict", async () => {
    // Arrange: create event, get version, modify event elsewhere
    // Act: attempt delete with old version
    // Assert: expect 409
  });

  it("should return 409 when event is locked by another user", async () => {
    // Arrange: create event, lock it as different user
    // Act: attempt delete
    // Assert: expect 409 LOCK_CONFLICT
  });

  it("should return 401 without authentication", async () => {
    // Act: send request without token
    // Assert: expect 401
  });
});
```

### Step 8: Update API Documentation

Update `api-plan.md` with:

- Detailed error responses
- If-Match header requirement
- ETag response header
- Lock interaction behavior
- Examples of unseating behavior

### Step 9: Add Monitoring and Logging

- Add structured logging for all table deletions
- Track metrics:
  - Deletion latency (p50, p95, p99)
  - Deletion count per user/hour
  - Unseated guest count distribution
  - Version conflict rate
  - Lock conflict rate

### Step 10: Deployment Checklist

- [ ] Create database migration for any new indexes
- [ ] Deploy RPC function (if using Option A from Step 6)
- [ ] Update audit_log enum if adding 'table_delete' action type
- [ ] Deploy service and route code
- [ ] Run integration tests in staging
- [ ] Monitor error rates and latency
- [ ] Update API documentation
- [ ] Notify frontend team of endpoint availability

---

## Appendix: Alternative Implementations

### Option: Soft Delete for Tables

Instead of hard deleting tables, add a `deleted_at` field to table objects:

```typescript
interface TableDTO {
  id: string;
  // ... other fields
  deleted_at?: string | null; // ISO8601 timestamp
}
```

**Pros**:

- Easier to implement undo
- Preserves history
- Can restore accidentally deleted tables

**Cons**:

- Increases plan_data size
- Requires filtering deleted tables in UI
- More complex validation logic

**Recommendation**: Start with hard delete for MVP; add soft delete if undo/restore becomes critical user feedback.

### Option: Background Job for Audit Logging

For high-throughput scenarios, offload audit logging to a background queue:

```typescript
// In service, publish to queue instead of direct insert
await publishToQueue('audit-log', {
  event_id: eventId,
  user_id: userId,
  action_type: 'table_update',
  details: { ... }
});
```

**Pros**:

- Reduces request latency
- Decouples audit from core operation
- Can batch inserts

**Cons**:

- Added complexity (requires queue infrastructure)
- Eventual consistency for audit trail
- Harder to debug failures

**Recommendation**: Use synchronous audit logging for MVP; migrate to async if audit inserts become bottleneck.

---

**End of Implementation Plan**
