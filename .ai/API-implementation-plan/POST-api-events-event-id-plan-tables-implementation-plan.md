# API Endpoint Implementation Plan: POST /api/events/{event_id}/plan/tables

## 1. Endpoint Overview

This endpoint creates a new table within an event's seating plan. It serves as a convenience shortcut for adding a single table instead of using the bulk operations endpoint (`POST /api/events/{event_id}/plan/ops`). The endpoint validates the table configuration, generates a unique table ID, initializes an empty seats array, updates the event's `plan_data` JSONB structure, increments the autosave version, and returns the newly created table object.

**Key Characteristics:**

- Authenticated endpoint requiring Supabase JWT
- Requires event ownership or active lock
- Atomic operation with automatic version increment
- Creates audit log entry for traceability
- Returns 201 Created on success

## 2. Request Details

### HTTP Method

POST

### URL Structure

```
/api/events/{event_id}/plan/tables
```

### Path Parameters

- **event_id** (required): UUID of the event
  - Format: Valid UUID v4
  - Validation: Must exist in `events` table, must not be soft-deleted

### Headers

- **Authorization** (required): `Bearer <supabase_jwt>`
- **Content-Type** (required): `application/json`
- **Idempotency-Key** (optional): UUID for idempotent creation

### Request Body

Structure matches `CreateTableCommand` from types.ts:

```json
{
  "shape": "round",
  "capacity": 10,
  "label": "Table 1",
  "start_index": 1,
  "head_seat": 1
}
```

**Field Specifications:**

| Field       | Type    | Required | Constraints                            |
| ----------- | ------- | -------- | -------------------------------------- |
| shape       | enum    | Yes      | One of: 'round', 'rectangular', 'long' |
| capacity    | integer | Yes      | > 0, recommended max 50                |
| label       | string  | No       | Max 100 characters, display name       |
| start_index | integer | Yes      | >= 1, seat numbering start             |
| head_seat   | integer | Yes      | >= 1 and <= capacity                   |

### Validation Rules

**Path Validation:**

- `event_id` must be valid UUID format
- Event must exist in database
- Event must not be soft-deleted (`deleted_at IS NULL`)

**Body Validation (Zod schema):**

```typescript
const createTableSchema = z
  .object({
    shape: z.enum(["round", "rectangular", "long"]),
    capacity: z.number().int().positive().max(50),
    label: z.string().max(100).optional(),
    start_index: z.number().int().min(1),
    head_seat: z.number().int().min(1),
  })
  .refine((data) => data.head_seat <= data.capacity, {
    message: "head_seat must not exceed capacity",
    path: ["head_seat"],
  });
```

**Authorization Validation:**

- User must be event owner (`owner_id = user.id`), OR
- User must hold valid lock (`lock_held_by = user.id AND lock_expires_at > NOW()`)

**Business Rules:**

- Generated table ID must be unique within `plan_data.tables` array
- Table ID generation: Use nanoid or UUID (consistent with existing guest/table IDs)

## 3. Used Types

### DTOs (from types.ts)

**Request:**

- `CreateTableCommand` - Omit<TableDTO, "id" | "seats">

**Response:**

- `TableDTO` - Full table object including generated id and initialized seats array
- `ApiErrorDTO` - Error response structure

**Internal:**

- `EventDTO` - For event retrieval and validation
- `PlanDataDTO` - Container structure for plan_data JSONB
- `SeatAssignmentDTO` - Individual seat structure (empty array initially)
- `UUID` - Type alias for string

### Command Model

```typescript
interface CreateTableCommand {
  shape: Enums<"table_shape_enum">;
  capacity: number;
  label?: string;
  start_index: number;
  head_seat: number;
}
```

### Response Model

```typescript
interface TableDTO {
  id: string;
  shape: Enums<"table_shape_enum">;
  capacity: number;
  label?: string;
  start_index: number;
  head_seat: number;
  seats: SeatAssignmentDTO[];
}
```

## 4. Response Details

### Success Response (201 Created)

```json
{
  "id": "tbl_abc123xyz",
  "shape": "round",
  "capacity": 10,
  "label": "Table 1",
  "start_index": 1,
  "head_seat": 1,
  "seats": []
}
```

**Headers:**

- `Content-Type: application/json`
- `Location: /api/events/{event_id}/plan/tables/{table_id}` (optional, for consistency)

### Error Responses

#### 400 Bad Request - Invalid Input

```json
{
  "error": {
    "code": "INVALID_TABLE_DATA",
    "message": "Invalid table configuration",
    "details": {
      "field": "head_seat",
      "issue": "head_seat must not exceed capacity"
    }
  }
}
```

**Triggers:**

- Invalid UUID format for event_id
- Missing required fields
- Invalid enum value for shape
- Capacity <= 0 or > 50
- start_index < 1
- head_seat < 1 or > capacity
- Label exceeds 100 characters

#### 401 Unauthorized

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

**Triggers:**

- Missing Authorization header
- Invalid or expired JWT token

#### 403 Forbidden

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to modify this event",
    "details": {
      "reason": "not_owner_or_lock_holder"
    }
  }
}
```

**Triggers:**

- User is not event owner
- Event is locked by another user
- Lock has expired

#### 404 Not Found

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found or has been deleted"
  }
}
```

**Triggers:**

- Event ID doesn't exist
- Event is soft-deleted (deleted_at IS NOT NULL)

#### 409 Conflict

```json
{
  "error": {
    "code": "LOCK_HELD_BY_ANOTHER_USER",
    "message": "Event is currently locked by another user",
    "details": {
      "held_by": "user_uuid",
      "expires_at": "2025-11-01T14:30:00.000Z"
    }
  }
}
```

**Triggers:**

- Strict lock enforcement when another user holds lock

#### 500 Internal Server Error

```json
{
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

**Triggers:**

- Database connection failures
- JSONB parsing errors
- Unexpected exceptions

## 5. Data Flow

### High-Level Flow

1. **Authentication**: Extract and verify Supabase JWT from Authorization header
2. **Path Validation**: Validate event_id UUID format
3. **Input Validation**: Validate request body against Zod schema
4. **Event Retrieval**: Fetch event from database using Supabase client
5. **Authorization Check**: Verify user is owner or lock holder
6. **Business Logic** (in service):
   - Generate unique table ID
   - Initialize empty seats array
   - Create table object
   - Deep clone current plan_data
   - Append new table to tables array
   - Increment autosave_version
7. **Database Update**: Atomic update of events row
8. **Audit Logging**: Insert audit_log entry
9. **Response**: Return 201 with created table

### Detailed Sequence

```
Client Request
    ↓
[Astro API Route: POST /api/events/{event_id}/plan/tables.ts]
    ↓
Middleware: Extract user from context.locals.supabase
    ↓
Validate Path Parameters (event_id format)
    ↓
Validate Request Body (Zod schema)
    ↓
[Service: planService.addTable()]
    ├─→ Query events table (SELECT)
    │   └─→ Check: exists, not deleted, user authorization
    │
    ├─→ Generate table ID (nanoid/UUID)
    │
    ├─→ Construct TableDTO object
    │   ├─→ id: generated
    │   ├─→ shape, capacity, label, start_index, head_seat: from request
    │   └─→ seats: [] (empty array)
    │
    ├─→ Clone & Update plan_data
    │   ├─→ Parse current plan_data JSONB
    │   ├─→ Validate structure (has tables array)
    │   ├─→ Append new table
    │   └─→ Increment autosave_version
    │
    ├─→ Update events row (UPDATE in transaction)
    │   └─→ SET plan_data = new_plan_data, autosave_version = autosave_version + 1, updated_at = NOW()
    │
    └─→ Insert audit_log entry
        └─→ action_type: 'table_create', details: { table_id, shape, capacity }
    ↓
Return 201 with TableDTO
```

### Database Interactions

**Read Operation:**

```sql
SELECT id, owner_id, plan_data, autosave_version, lock_held_by, lock_expires_at, deleted_at
FROM events
WHERE id = $1 AND deleted_at IS NULL
```

**Write Operation (Transactional):**

```sql
BEGIN;

UPDATE events
SET
  plan_data = $1,
  autosave_version = autosave_version + 1,
  updated_at = NOW()
WHERE id = $2 AND deleted_at IS NULL
RETURNING autosave_version;

INSERT INTO audit_log (event_id, user_id, action_type, details)
VALUES ($3, $4, 'table_create', $5);

COMMIT;
```

## 6. Security Considerations

### Authentication

- **Mechanism**: Supabase JWT Bearer token validation
- **Implementation**: Use `context.locals.supabase` (automatically initialized by middleware)
- **Failure Mode**: Return 401 if token missing, invalid, or expired

### Authorization

- **Owner Check**: Compare `events.owner_id` with authenticated `user.id`
- **Lock Check**: If not owner, verify `lock_held_by = user.id AND lock_expires_at > NOW()`
- **Failure Mode**: Return 403 if neither condition satisfied

### Input Sanitization

- **Label Field**: Sanitize to prevent XSS (encode HTML entities)
- **Enum Validation**: Strict validation against allowed shape values
- **Integer Bounds**: Enforce min/max constraints on capacity, start_index, head_seat

### JSONB Integrity

- **Deep Clone**: Always clone plan_data before modification to prevent reference bugs
- **Schema Validation**: Validate plan_data structure before and after modification
- **Atomic Update**: Use database transaction to ensure consistency

### Rate Limiting

- **Consideration**: Prevent resource exhaustion via unlimited table creation
- **Implementation**: Could use admin_flags.rate_limit or application-level throttling
- **Scope**: Per-user, per-event, or global limits

### Idempotency

- **Header**: `Idempotency-Key` for duplicate request protection
- **Storage**: Cache table creation by idempotency key for 24 hours
- **Behavior**: Return existing table if duplicate key detected

### Soft Delete Protection

- **Check**: Verify `deleted_at IS NULL` in all event queries
- **Rationale**: Prevent modification of archived/deleted events

### Lock Enforcement

- **Strict Mode**: Return 409 if lock held by another user (prevents concurrent edits)
- **Soft Mode**: Log warning but allow owner to override (implement based on requirements)
- **Expiry Check**: Automatically release expired locks

## 7. Error Handling

### Validation Errors (400)

**Schema Validation Failures:**

```typescript
try {
  const validated = createTableSchema.parse(requestBody);
} catch (error) {
  if (error instanceof z.ZodError) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_TABLE_DATA",
          message: "Invalid table configuration",
          details: error.errors,
        },
      }),
      { status: 400 }
    );
  }
}
```

**Common Validation Errors:**

- Invalid shape enum value
- Capacity out of bounds
- head_seat exceeds capacity
- Label too long
- Invalid start_index

### Authentication Errors (401)

**Missing Token:**

```typescript
const user = context.locals.user;
if (!user) {
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

### Authorization Errors (403)

**Owner/Lock Check:**

```typescript
const isOwner = event.owner_id === user.id;
const hasLock = event.lock_held_by === user.id && new Date(event.lock_expires_at) > new Date();

if (!isOwner && !hasLock) {
  return new Response(
    JSON.stringify({
      error: {
        code: "FORBIDDEN",
        message: "You do not have permission to modify this event",
        details: { reason: "not_owner_or_lock_holder" },
      },
    }),
    { status: 403 }
  );
}
```

### Not Found Errors (404)

**Event Not Found:**

```typescript
if (!event || event.deleted_at) {
  return new Response(
    JSON.stringify({
      error: {
        code: "EVENT_NOT_FOUND",
        message: "Event not found or has been deleted",
      },
    }),
    { status: 404 }
  );
}
```

### Conflict Errors (409)

**Lock Conflict (Strict Mode):**

```typescript
if (event.lock_held_by && event.lock_held_by !== user.id) {
  return new Response(
    JSON.stringify({
      error: {
        code: "LOCK_HELD_BY_ANOTHER_USER",
        message: "Event is currently locked by another user",
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

### Database Errors (500)

**Transaction Failures:**

```typescript
try {
  // database operations
} catch (error) {
  console.error("Database error:", error);
  return new Response(
    JSON.stringify({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    }),
    { status: 500 }
  );
}
```

**Error Logging:**

- Log all 500 errors with stack trace
- Include request context (user_id, event_id, timestamp)
- Sanitize sensitive data before logging

## 8. Performance Considerations

### Database Optimization

- **Index Usage**: Ensure `events.id` and `events.owner_id` are indexed (likely primary/foreign keys)
- **JSONB Operations**: Use JSONB operators efficiently; avoid full document parsing when possible
- **Connection Pooling**: Leverage Supabase connection pooling

### JSONB Size Management

- **Growth Monitoring**: Track plan_data size as tables are added
- **Size Limits**: Consider warning threshold (e.g., 1MB plan_data)
- **Optimization**: Lazy load plan_data for list endpoints (exclude from SELECT)

### Caching Strategies

- **Event Metadata**: Cache event ownership/lock status briefly (5-10 seconds)
- **Validation Results**: Cache schema validation results per request
- **Idempotency**: Cache successful table creations by idempotency key

### Concurrency Management

- **Optimistic Locking**: Use autosave_version for conflict detection
- **Retry Logic**: Client should retry on version conflicts
- **Lock Acquisition**: Recommend acquiring lock before bulk table operations

### Response Optimization

- **Minimal Payload**: Return only created table, not full plan_data
- **Compression**: Enable gzip for JSON responses
- **Field Selection**: Support partial response if needed (future enhancement)

## 9. Implementation Steps

### Step 1: Create Service Layer

**File**: `src/lib/services/planService.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { CreateTableCommand, TableDTO, PlanDataDTO } from "../../types";
import { nanoid } from "nanoid";

export async function addTableToEvent(
  supabase: SupabaseClient,
  eventId: string,
  userId: string,
  tableData: CreateTableCommand
): Promise<TableDTO> {
  // 1. Fetch event with authorization check
  const { data: event, error: fetchError } = await supabase
    .from("events")
    .select("id, owner_id, plan_data, autosave_version, lock_held_by, lock_expires_at, deleted_at")
    .eq("id", eventId)
    .is("deleted_at", null)
    .single();

  if (fetchError || !event) {
    throw new Error("EVENT_NOT_FOUND");
  }

  // 2. Authorization check
  const isOwner = event.owner_id === userId;
  const hasLock = event.lock_held_by === userId && new Date(event.lock_expires_at!) > new Date();

  if (!isOwner && !hasLock) {
    throw new Error("FORBIDDEN");
  }

  // 3. Generate table ID
  const tableId = `tbl_${nanoid(12)}`;

  // 4. Construct table object
  const newTable: TableDTO = {
    id: tableId,
    shape: tableData.shape,
    capacity: tableData.capacity,
    label: tableData.label,
    start_index: tableData.start_index,
    head_seat: tableData.head_seat,
    seats: [],
  };

  // 5. Update plan_data
  const planData = event.plan_data as PlanDataDTO;
  const updatedPlanData: PlanDataDTO = {
    ...planData,
    tables: [...(planData.tables || []), newTable],
  };

  // 6. Update event in database (transaction via RPC or manual)
  const { data: updated, error: updateError } = await supabase
    .from("events")
    .update({
      plan_data: updatedPlanData,
      autosave_version: event.autosave_version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId)
    .select("autosave_version")
    .single();

  if (updateError) {
    throw new Error("UPDATE_FAILED");
  }

  // 7. Insert audit log
  await supabase.from("audit_log").insert({
    event_id: eventId,
    user_id: userId,
    action_type: "table_create",
    details: {
      table_id: tableId,
      shape: tableData.shape,
      capacity: tableData.capacity,
      label: tableData.label,
    },
  });

  return newTable;
}
```

### Step 2: Create Zod Validation Schema

**File**: `src/lib/validation/planSchemas.ts`

```typescript
import { z } from "zod";

export const createTableSchema = z
  .object({
    shape: z.enum(["round", "rectangular", "long"], {
      errorMap: () => ({ message: "Shape must be 'round', 'rectangular', or 'long'" }),
    }),
    capacity: z
      .number()
      .int({ message: "Capacity must be an integer" })
      .positive({ message: "Capacity must be greater than 0" })
      .max(50, { message: "Capacity cannot exceed 50" }),
    label: z.string().max(100, { message: "Label cannot exceed 100 characters" }).optional(),
    start_index: z
      .number()
      .int({ message: "Start index must be an integer" })
      .min(1, { message: "Start index must be at least 1" }),
    head_seat: z
      .number()
      .int({ message: "Head seat must be an integer" })
      .min(1, { message: "Head seat must be at least 1" }),
  })
  .refine((data) => data.head_seat <= data.capacity, {
    message: "Head seat cannot exceed table capacity",
    path: ["head_seat"],
  });

export const eventIdParamSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
});
```

### Step 3: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/plan/tables.ts`

```typescript
import type { APIRoute } from "astro";
import { createTableSchema, eventIdParamSchema } from "../../../../../lib/validation/planSchemas";
import { addTableToEvent } from "../../../../../lib/services/planService";
import type { ApiErrorDTO, CreateTableCommand, TableDTO } from "../../../../../types";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    // 1. Extract Supabase client and user from context
    const supabase = context.locals.supabase;
    const user = context.locals.user;

    if (!user) {
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required",
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Validate path parameters
    const pathValidation = eventIdParamSchema.safeParse(context.params);
    if (!pathValidation.success) {
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "INVALID_EVENT_ID",
          message: "Invalid event ID format",
          details: pathValidation.error.errors,
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { event_id } = pathValidation.data;

    // 3. Parse and validate request body
    let requestBody: unknown;
    try {
      requestBody = await context.request.json();
    } catch (parseError) {
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "INVALID_JSON",
          message: "Request body must be valid JSON",
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const bodyValidation = createTableSchema.safeParse(requestBody);
    if (!bodyValidation.success) {
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "INVALID_TABLE_DATA",
          message: "Invalid table configuration",
          details: bodyValidation.error.errors,
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const tableData: CreateTableCommand = bodyValidation.data;

    // 4. Call service to add table
    const newTable: TableDTO = await addTableToEvent(supabase, event_id, user.id, tableData);

    // 5. Return 201 Created with table object
    return new Response(JSON.stringify(newTable), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        Location: `/api/events/${event_id}/plan/tables/${newTable.id}`,
      },
    });
  } catch (error) {
    // Error handling
    if (error instanceof Error) {
      switch (error.message) {
        case "EVENT_NOT_FOUND": {
          const errorResponse: ApiErrorDTO = {
            error: {
              code: "EVENT_NOT_FOUND",
              message: "Event not found or has been deleted",
            },
          };
          return new Response(JSON.stringify(errorResponse), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        case "FORBIDDEN": {
          const errorResponse: ApiErrorDTO = {
            error: {
              code: "FORBIDDEN",
              message: "You do not have permission to modify this event",
              details: { reason: "not_owner_or_lock_holder" },
            },
          };
          return new Response(JSON.stringify(errorResponse), {
            status: 403,
            headers: { "Content-Type": "application/json" },
          });
        }
        default: {
          console.error("Unexpected error in POST /api/events/[event_id]/plan/tables:", error);
          const errorResponse: ApiErrorDTO = {
            error: {
              code: "INTERNAL_SERVER_ERROR",
              message: "An unexpected error occurred",
            },
          };
          return new Response(JSON.stringify(errorResponse), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      }
    }

    // Fallback for unknown error types
    console.error("Unknown error in POST /api/events/[event_id]/plan/tables:", error);
    const errorResponse: ApiErrorDTO = {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred",
      },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
```

### Step 4: Ensure Middleware Configuration

**File**: `src/middleware/index.ts`

Verify that Supabase middleware is properly configured to:

- Initialize Supabase client in `context.locals.supabase`
- Extract authenticated user into `context.locals.user`
- Handle token validation and refresh

### Step 5: Create Unit Tests

**File**: `src/lib/services/planService.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { addTableToEvent } from "./planService";

describe("addTableToEvent", () => {
  it("should create table successfully for event owner", async () => {
    // Mock Supabase client
    // Mock event data
    // Call service
    // Assert table created
    // Assert audit log inserted
  });

  it("should throw FORBIDDEN for non-owner without lock", async () => {
    // Mock unauthorized user
    // Assert throws FORBIDDEN
  });

  it("should throw EVENT_NOT_FOUND for deleted event", async () => {
    // Mock soft-deleted event
    // Assert throws EVENT_NOT_FOUND
  });

  // Additional test cases...
});
```

### Step 6: Create Integration Tests

**File**: `tests/api/events/plan/tables.test.ts`

```typescript
import { describe, it, expect, beforeAll } from "vitest";

describe("POST /api/events/{event_id}/plan/tables", () => {
  let authToken: string;
  let eventId: string;

  beforeAll(async () => {
    // Set up test user and event
  });

  it("should return 201 with created table", async () => {
    const response = await fetch(`/api/events/${eventId}/plan/tables`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        shape: "round",
        capacity: 10,
        label: "Test Table",
        start_index: 1,
        head_seat: 1,
      }),
    });

    expect(response.status).toBe(201);
    const table = await response.json();
    expect(table).toHaveProperty("id");
    expect(table.shape).toBe("round");
    expect(table.seats).toEqual([]);
  });

  it("should return 400 for invalid capacity", async () => {
    // Test validation errors
  });

  it("should return 401 without authentication", async () => {
    // Test unauthorized access
  });

  // Additional test cases...
});
```

### Step 7: Update API Documentation

**File**: `.ai/api-plan.md`

Ensure the endpoint documentation matches implementation details, including:

- Request/response examples
- Error codes and descriptions
- Validation rules
- Authentication requirements

### Step 8: Add Error Monitoring

Configure error tracking (e.g., Sentry) to:

- Capture 500 errors with full context
- Track validation error patterns
- Monitor performance metrics
- Alert on error rate spikes

### Step 9: Performance Testing

- Load test endpoint with concurrent requests
- Verify JSONB update performance with large plan_data
- Test transaction rollback on failures
- Validate idempotency key handling

### Step 10: Security Audit

- Verify JWT validation
- Test authorization edge cases
- Validate input sanitization
- Check JSONB injection protection
- Test soft delete enforcement

---

## Summary Checklist

- [ ] Service layer created (`planService.ts`)
- [ ] Validation schemas defined (`planSchemas.ts`)
- [ ] API route handler implemented (`tables.ts`)
- [ ] Middleware configured for Supabase auth
- [ ] Unit tests written and passing
- [ ] Integration tests written and passing
- [ ] Error responses match specification
- [ ] Audit logging implemented
- [ ] Performance optimizations applied
- [ ] Security measures validated
- [ ] API documentation updated
- [ ] Error monitoring configured
