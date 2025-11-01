# API Endpoint Implementation Plan: DELETE /api/events/{event_id}/plan/guests/{guest_id}

## 1. Endpoint Overview

This endpoint removes a guest from an event's seating plan and unassigns them from any seat they currently occupy. The operation modifies the `plan_data` JSONB structure within the `events` table by:

- Removing the guest record from the `guests` array
- Clearing any seat assignments referencing the guest across all tables
- Incrementing the `autosave_version` counter for optimistic concurrency control
- Creating an audit trail entry

The endpoint requires the authenticated user to be the event owner or hold an active edit lock. Success returns HTTP 204 No Content with an empty response body.

## 2. Request Details

- **HTTP Method**: DELETE
- **URL Structure**: `/api/events/{event_id}/plan/guests/{guest_id}`
- **Authentication**: Required (Supabase session)
- **Content-Type**: Not applicable (no request body)

### Path Parameters

| Parameter  | Type   | Required | Description                                     | Validation                      |
| ---------- | ------ | -------- | ----------------------------------------------- | ------------------------------- |
| `event_id` | UUID   | Yes      | Unique identifier of the event                  | Must be valid UUID v4 format    |
| `guest_id` | string | Yes      | Unique identifier of the guest within plan_data | Non-empty string, max 150 chars |

### Request Body

None (path-driven operation)

### Headers

- `Authorization`: Bearer token from Supabase session (automatically handled by middleware)

## 3. Used Types

### Command Models

```typescript
// From src/types.ts
type DeleteGuestCommand = Record<string, never>; // Path-driven marker
```

### DTOs

```typescript
// From src/types.ts
interface GuestDTO {
  id: string;
  name: string;
  note?: string;
  tag?: string;
  rsvp?: string;
}

interface TableDTO {
  id: string;
  shape: Enums<"table_shape_enum">;
  capacity: number;
  label?: string;
  start_index: number;
  head_seat: number;
  seats: SeatAssignmentDTO[];
}

interface SeatAssignmentDTO {
  seat_no: number;
  guest_id?: string;
}

interface PlanDataDTO {
  tables: TableDTO[];
  guests: GuestDTO[];
  settings: PlanSettingsDTO;
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
type AuditLogEntry = Tables<"audit_log">;
```

## 4. Response Details

### Success Response (204 No Content)

- **Status Code**: 204
- **Body**: Empty (no content)
- **Headers**: None specific

### Error Responses

| Status Code | Error Code        | Description                                   | Example Response                                                                                                                                                                   |
| ----------- | ----------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401         | `UNAUTHORIZED`    | No valid authentication session               | `{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }`                                                                                                    |
| 403         | `FORBIDDEN`       | User is not event owner and doesn't hold lock | `{ "error": { "code": "FORBIDDEN", "message": "You do not have permission to modify this event" } }`                                                                               |
| 404         | `EVENT_NOT_FOUND` | Event does not exist or is soft-deleted       | `{ "error": { "code": "EVENT_NOT_FOUND", "message": "Event not found" } }`                                                                                                         |
| 404         | `GUEST_NOT_FOUND` | Guest ID doesn't exist in plan_data           | `{ "error": { "code": "GUEST_NOT_FOUND", "message": "Guest not found in seating plan" } }`                                                                                         |
| 409         | `EDIT_LOCK_HELD`  | Another user holds the edit lock              | `{ "error": { "code": "EDIT_LOCK_HELD", "message": "Event is currently locked by another user", "details": { "locked_by": "user-uuid", "expires_at": "2025-11-01T12:00:00Z" } } }` |
| 422         | `INVALID_UUID`    | event_id is not a valid UUID format           | `{ "error": { "code": "INVALID_UUID", "message": "Invalid event ID format" } }`                                                                                                    |
| 500         | `INTERNAL_ERROR`  | Database or server errors                     | `{ "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }`                                                                                             |

## 5. Data Flow

### High-Level Flow

1. **Request Reception**: Astro API endpoint receives DELETE request
2. **Authentication**: Middleware validates Supabase session
3. **Path Parameter Extraction**: Extract `event_id` and `guest_id` from URL
4. **Input Validation**: Validate UUID format and parameter presence
5. **Authorization Check**: Verify user is event owner or holds active lock
6. **Event Retrieval**: Fetch event from database with RLS check
7. **Guest Existence Check**: Verify guest exists in plan_data.guests
8. **Plan Data Mutation**:
   - Parse plan_data JSONB
   - Remove guest from guests array
   - Remove guest_id from all seat assignments in tables
9. **Database Update**:
   - Update events table with modified plan_data
   - Increment autosave_version
   - Update updated_at timestamp
10. **Audit Logging**: Insert audit_log entry with action_type='guest_delete'
11. **Response**: Return HTTP 204 No Content

### Detailed Service Layer Flow

```typescript
// Service: src/lib/services/guest-service.ts
async function deleteGuest(supabase: SupabaseClient, eventId: string, guestId: string, userId: string): Promise<void> {
  // 1. Fetch event with ownership/lock check
  const { data: event, error } = await supabase
    .from("events")
    .select("id, owner_id, lock_held_by, lock_expires_at, plan_data, autosave_version, deleted_at")
    .eq("id", eventId)
    .is("deleted_at", null)
    .single();

  if (error || !event) {
    throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");
  }

  // 2. Verify authorization
  const isOwner = event.owner_id === userId;
  const hasLock =
    event.lock_held_by === userId && event.lock_expires_at && new Date(event.lock_expires_at) > new Date();

  if (!isOwner && !hasLock) {
    if (event.lock_held_by && event.lock_expires_at && new Date(event.lock_expires_at) > new Date()) {
      throw new ConflictError("EDIT_LOCK_HELD", "Event is locked by another user", {
        locked_by: event.lock_held_by,
        expires_at: event.lock_expires_at,
      });
    }
    throw new ForbiddenError("FORBIDDEN", "You do not have permission to modify this event");
  }

  // 3. Parse and validate plan_data
  const planData = event.plan_data as PlanDataDTO;
  const guestIndex = planData.guests.findIndex((g) => g.id === guestId);

  if (guestIndex === -1) {
    throw new NotFoundError("GUEST_NOT_FOUND", "Guest not found in seating plan");
  }

  // 4. Capture guest name for audit trail
  const guestName = planData.guests[guestIndex].name;

  // 5. Remove guest from guests array
  planData.guests.splice(guestIndex, 1);

  // 6. Remove guest from all seat assignments
  planData.tables.forEach((table) => {
    table.seats = table.seats.map((seat) => {
      if (seat.guest_id === guestId) {
        return { seat_no: seat.seat_no }; // Remove guest_id
      }
      return seat;
    });
  });

  // 7. Update event in database
  const { error: updateError } = await supabase
    .from("events")
    .update({
      plan_data: planData,
      autosave_version: event.autosave_version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId);

  if (updateError) {
    throw new InternalError("DATABASE_UPDATE_FAILED", "Failed to update event");
  }

  // 8. Create audit log entry
  await supabase.from("audit_log").insert({
    event_id: eventId,
    user_id: userId,
    action_type: "guest_delete",
    details: { guest_id: guestId, guest_name: guestName },
    share_link_id: null,
  });
}
```

### Database Interactions

**Read Operations:**

1. `SELECT` from `events` table with RLS filtering by owner_id or lock_held_by
2. Implicit RLS check ensures user can only access their events

**Write Operations:**

1. `UPDATE` events table: plan_data, autosave_version, updated_at
2. `INSERT` into audit_log table

**Transaction Requirements:**

- Both update and audit log insert should succeed or rollback together
- Use Supabase transaction if available, or handle cleanup on failure

## 6. Security Considerations

### Authentication

- **Requirement**: Valid Supabase session token required
- **Implementation**: Middleware validates session via `context.locals.supabase.auth.getUser()`
- **Failure Handling**: Return 401 Unauthorized if session invalid or missing

### Authorization

- **Ownership Check**: User must be event.owner_id
- **Alternative**: User holds active lock (lock_held_by = user_id AND lock_expires_at > NOW())
- **RLS Policy**: Database-level row-level security enforces ownership on SELECT/UPDATE
- **Lock Validation**:
  - Check lock expiration timestamp
  - Return 409 Conflict if another user holds unexpired lock
  - Return 403 Forbidden if user is neither owner nor lock holder

### Input Validation

```typescript
// Zod schema for path parameters
import { z } from "zod";

const deleteGuestParamsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
  guest_id: z.string().min(1).max(150, { message: "Guest ID must be between 1 and 150 characters" }),
});
```

### Data Integrity

- **Soft Delete Check**: Verify `deleted_at IS NULL` to prevent modifications to deleted events
- **JSONB Validation**: Ensure plan_data structure is valid before/after mutation
- **Concurrent Modification**: autosave_version acts as optimistic lock (though not explicitly checked in DELETE, it's incremented for client awareness)

### GDPR/CCPA Compliance

- **Audit Trail**: All deletions logged with timestamp, user, and guest details
- **PII Handling**: Guest name stored in audit log is acceptable for compliance (retention policy should be defined)
- **Data Minimization**: Only necessary fields logged

### Rate Limiting

- Consider implementing endpoint-specific rate limits (e.g., max 100 guest deletions per minute)
- Use admin_flags.rate_limit_exports_daily as reference pattern

## 7. Error Handling

### Error Classification

| Error Type           | HTTP Status | Error Code        | Handling Strategy                |
| -------------------- | ----------- | ----------------- | -------------------------------- |
| Missing/Invalid Auth | 401         | `UNAUTHORIZED`    | Early return from middleware     |
| Invalid UUID Format  | 422         | `INVALID_UUID`    | Zod validation failure           |
| Event Not Found      | 404         | `EVENT_NOT_FOUND` | After DB query returns null      |
| Guest Not Found      | 404         | `GUEST_NOT_FOUND` | After searching plan_data.guests |
| Not Event Owner      | 403         | `FORBIDDEN`       | After ownership check fails      |
| Lock Held by Other   | 409         | `EDIT_LOCK_HELD`  | After lock validation fails      |
| Database Errors      | 500         | `INTERNAL_ERROR`  | Catch-all for unexpected errors  |
| JSONB Parse Errors   | 500         | `INTERNAL_ERROR`  | If plan_data is corrupted        |

### Error Response Structure

All errors follow ApiErrorDTO format:

```typescript
{
  error: {
    code: string,      // Machine-readable constant
    message: string,   // Human-readable description
    details?: object   // Optional context (e.g., lock info)
  }
}
```

### Error Handling Implementation

```typescript
// src/lib/errors.ts - Custom error classes
export class NotFoundError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: object
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

// API endpoint error handler
try {
  await deleteGuest(supabase, eventId, guestId, userId);
  return new Response(null, { status: 204 });
} catch (error) {
  if (error instanceof NotFoundError) {
    return new Response(
      JSON.stringify({
        error: { code: error.code, message: error.message },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
  if (error instanceof ForbiddenError) {
    return new Response(
      JSON.stringify({
        error: { code: error.code, message: error.message },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }
  if (error instanceof ConflictError) {
    return new Response(
      JSON.stringify({
        error: { code: error.code, message: error.message, details: error.details },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } }
    );
  }
  // Generic internal error
  console.error("Unexpected error in deleteGuest:", error);
  return new Response(
    JSON.stringify({
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
    }),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}
```

### Logging Strategy

- **Error Logs**: Log all 500 errors with stack traces for debugging
- **Audit Logs**: Successful deletions logged to audit_log table
- **Security Logs**: Log 401/403 errors for security monitoring (consider separate table or service)

## 8. Performance Considerations

### Database Performance

- **Index Usage**:
  - Primary key index on events.id (automatic)
  - Index on events.owner_id for RLS filtering (should exist)
  - JSONB indexes not critical for single-event operations
- **Query Efficiency**: Single SELECT + single UPDATE with minimal data transfer
- **RLS Overhead**: Minimal, uses indexed columns

### JSONB Manipulation

- **In-Memory Processing**: Plan data deserialized, modified, and reserialized in application layer
- **Size Considerations**: For events with 1000+ guests, JSONB manipulation may take 10-100ms
- **Optimization**: Consider JSONB operators for in-database manipulation if performance becomes issue

### Concurrency

- **Lock Mechanism**: Soft single-editor lock prevents concurrent edits
- **Optimistic Concurrency**: autosave_version incremented but not validated in DELETE (consider adding If-Match header support)
- **Race Conditions**: PostgreSQL row-level locking prevents corruption during UPDATE

### Network Efficiency

- **Minimal Payload**: No response body (204)
- **Single Round-Trip**: One DB read + one DB write + one audit insert
- **Connection Pooling**: Supabase client handles connection pooling

### Potential Bottlenecks

1. **Large Guest Lists**: Events with >500 guests may have slower JSONB parsing
   - **Mitigation**: Profile and optimize JSONB structure, consider pagination in list endpoints
2. **Audit Log Growth**: High-frequency deletions could bloat audit_log
   - **Mitigation**: Implement log rotation/archival policy
3. **Lock Contention**: Multiple users attempting simultaneous edits
   - **Mitigation**: Lock mechanism already handles this; consider WebSocket notifications

### Caching Strategy

- **Not Applicable**: DELETE operations should not be cached
- **Cache Invalidation**: If event data cached elsewhere (e.g., share link views), invalidate on successful deletion

## 9. Implementation Steps

### Step 1: Create Custom Error Classes

**File**: `src/lib/errors.ts`

```typescript
export class NotFoundError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: object
  ) {
    super(message);
    this.name = "ConflictError";
  }
}

export class InternalError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "InternalError";
  }
}
```

### Step 2: Create Guest Service

**File**: `src/lib/services/guest-service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { PlanDataDTO } from "../types";
import { NotFoundError, ForbiddenError, ConflictError, InternalError } from "../errors";

export async function deleteGuest(
  supabase: SupabaseClient,
  eventId: string,
  guestId: string,
  userId: string
): Promise<void> {
  // 1. Fetch event with necessary fields
  const { data: event, error: fetchError } = await supabase
    .from("events")
    .select("id, owner_id, lock_held_by, lock_expires_at, plan_data, autosave_version, deleted_at")
    .eq("id", eventId)
    .is("deleted_at", null)
    .single();

  if (fetchError || !event) {
    throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");
  }

  // 2. Authorization check
  const isOwner = event.owner_id === userId;
  const now = new Date();
  const lockExpiry = event.lock_expires_at ? new Date(event.lock_expires_at) : null;
  const hasActiveLock = event.lock_held_by === userId && lockExpiry && lockExpiry > now;

  if (!isOwner && !hasActiveLock) {
    // Check if someone else holds the lock
    if (event.lock_held_by && lockExpiry && lockExpiry > now) {
      throw new ConflictError("EDIT_LOCK_HELD", "Event is currently locked by another user", {
        locked_by: event.lock_held_by,
        expires_at: event.lock_expires_at,
      });
    }
    throw new ForbiddenError("FORBIDDEN", "You do not have permission to modify this event");
  }

  // 3. Parse plan_data and validate guest exists
  const planData = event.plan_data as PlanDataDTO;
  const guestIndex = planData.guests.findIndex((g) => g.id === guestId);

  if (guestIndex === -1) {
    throw new NotFoundError("GUEST_NOT_FOUND", "Guest not found in seating plan");
  }

  // 4. Capture guest name for audit
  const guestName = planData.guests[guestIndex].name;

  // 5. Remove guest from guests array
  planData.guests.splice(guestIndex, 1);

  // 6. Remove guest_id from all seat assignments
  planData.tables.forEach((table) => {
    table.seats = table.seats.map((seat) => {
      if (seat.guest_id === guestId) {
        // Remove guest_id, keep seat_no
        return { seat_no: seat.seat_no };
      }
      return seat;
    });
  });

  // 7. Update event
  const { error: updateError } = await supabase
    .from("events")
    .update({
      plan_data: planData,
      autosave_version: event.autosave_version + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId);

  if (updateError) {
    console.error("Failed to update event:", updateError);
    throw new InternalError("DATABASE_UPDATE_FAILED", "Failed to update event");
  }

  // 8. Create audit log entry
  const { error: auditError } = await supabase.from("audit_log").insert({
    event_id: eventId,
    user_id: userId,
    action_type: "guest_delete",
    details: { guest_id: guestId, guest_name: guestName },
    share_link_id: null,
  });

  if (auditError) {
    // Log but don't fail the operation
    console.error("Failed to create audit log entry:", auditError);
  }
}
```

### Step 3: Create Zod Validation Schema

**File**: `src/lib/validation/guest-validation.ts`

```typescript
import { z } from "zod";

export const deleteGuestParamsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
  guest_id: z.string().min(1).max(150, { message: "Guest ID must be between 1 and 150 characters" }),
});
```

### Step 4: Create API Endpoint

**File**: `src/pages/api/events/[event_id]/plan/guests/[guest_id].ts`

```typescript
import type { APIRoute } from "astro";
import { deleteGuest } from "../../../../../../lib/services/guest-service";
import { deleteGuestParamsSchema } from "../../../../../../lib/validation/guest-validation";
import { NotFoundError, ForbiddenError, ConflictError } from "../../../../../../lib/errors";
import { z } from "zod";

export const prerender = false;

export const DELETE: APIRoute = async (context) => {
  const { event_id, guest_id } = context.params;

  // 1. Validate path parameters
  try {
    deleteGuestParamsSchema.parse({ event_id, guest_id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_UUID",
            message: error.errors[0]?.message || "Invalid request parameters",
          },
        }),
        { status: 422, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // 2. Get authenticated user
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
      }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  // 3. Delete guest
  try {
    await deleteGuest(supabase, event_id!, guest_id!, user.id);
    return new Response(null, { status: 204 });
  } catch (error) {
    // Handle specific error types
    if (error instanceof NotFoundError) {
      return new Response(
        JSON.stringify({
          error: { code: error.code, message: error.message },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error instanceof ForbiddenError) {
      return new Response(
        JSON.stringify({
          error: { code: error.code, message: error.message },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error instanceof ConflictError) {
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // Generic error handling
    console.error("Unexpected error in DELETE guest:", error);
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

### Step 5: Update TypeScript Path Aliases (if needed)

**File**: `tsconfig.json`
Ensure path aliases are configured for clean imports:

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"],
      "@/lib/*": ["src/lib/*"],
      "@/components/*": ["src/components/*"]
    }
  }
}
```

### Step 6: Add Unit Tests

**File**: `tests/services/guest-service.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { deleteGuest } from "../../src/lib/services/guest-service";
import { NotFoundError, ForbiddenError, ConflictError } from "../../src/lib/errors";

describe("deleteGuest", () => {
  it("should delete guest and remove seat assignments", async () => {
    // Mock Supabase client and test implementation
  });

  it("should throw NotFoundError when event does not exist", async () => {
    // Test implementation
  });

  it("should throw ForbiddenError when user is not owner", async () => {
    // Test implementation
  });

  it("should throw ConflictError when lock held by another user", async () => {
    // Test implementation
  });

  it("should throw NotFoundError when guest does not exist", async () => {
    // Test implementation
  });
});
```

### Step 7: Add Integration Tests

**File**: `tests/api/delete-guest.test.ts`

```typescript
import { describe, it, expect } from "vitest";

describe("DELETE /api/events/{event_id}/plan/guests/{guest_id}", () => {
  it("should return 204 when guest deleted successfully", async () => {
    // Test implementation with real API call
  });

  it("should return 401 when not authenticated", async () => {
    // Test implementation
  });

  it("should return 404 when event not found", async () => {
    // Test implementation
  });

  it("should return 404 when guest not found", async () => {
    // Test implementation
  });

  it("should return 403 when user is not owner", async () => {
    // Test implementation
  });

  it("should return 409 when lock held by another user", async () => {
    // Test implementation
  });
});
```

### Step 8: Update API Documentation

**File**: `.ai/api-plan.md` or relevant API documentation

- Add detailed endpoint documentation
- Include request/response examples
- Document error codes and scenarios

### Step 9: Verify RLS Policies

**Database**: Supabase

- Ensure RLS policy on `events` table allows owners to UPDATE
- Ensure RLS policy allows lock holders to UPDATE
- Verify audit_log INSERT policy allows authenticated users

### Step 10: Manual Testing Checklist

- [ ] Test successful guest deletion as event owner
- [ ] Test successful guest deletion as lock holder
- [ ] Test deletion removes seat assignments from all tables
- [ ] Test 401 response when not authenticated
- [ ] Test 403 response when not owner and no lock
- [ ] Test 404 response when event doesn't exist
- [ ] Test 404 response when guest doesn't exist
- [ ] Test 409 response when another user holds lock
- [ ] Test 422 response with invalid UUID format
- [ ] Test autosave_version increments correctly
- [ ] Test audit log entry created with correct details
- [ ] Test soft-deleted events cannot be modified

### Step 11: Performance Testing

- [ ] Test with event containing 100 guests
- [ ] Test with event containing 1000 guests
- [ ] Measure average response time (target: <200ms for typical events)
- [ ] Test concurrent deletion attempts with locking

### Step 12: Security Testing

- [ ] Verify RLS policies prevent unauthorized access
- [ ] Test CSRF protection (if applicable)
- [ ] Verify audit trail captures all deletions
- [ ] Test rate limiting (if implemented)

---

## Additional Notes

### Dependencies

- `zod`: For input validation
- `@supabase/supabase-js`: Database client
- Astro middleware for session management

### Future Enhancements

1. **Undo/Redo Support**: Consider storing deleted guest in snapshot for potential restoration
2. **Batch Deletion**: Endpoint for deleting multiple guests in single transaction
3. **Soft Delete for Guests**: Instead of immediate removal, mark guests as deleted with timestamp
4. **WebSocket Notifications**: Notify other users when guest deleted
5. **If-Match Header**: Support optimistic concurrency control with autosave_version
6. **Cascade Rules**: Define behavior when guest is part of import or has related data

### Migration Considerations

If database schema changes are needed:

- Add migration to create/update RLS policies
- Add migration to ensure audit_log action_type enum includes 'guest_delete'
- Consider adding index on plan_data JSONB for performance (GIN index)

### Monitoring and Observability

- Log deletion frequency for analytics
- Monitor error rates by error code
- Track average response time
- Alert on unusual deletion patterns (potential data loss scenarios)
