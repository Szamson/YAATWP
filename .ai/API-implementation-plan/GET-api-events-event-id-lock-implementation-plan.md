# API Endpoint Implementation Plan: GET /api/events/{event_id}/lock

## 1. Endpoint Overview

This endpoint returns the current lock status for a specific event. The locking mechanism provides soft single-editor locking to prevent concurrent edits by multiple users. When a lock is held, the response indicates who holds it and when it expires. If no lock is active (or if an existing lock has expired), the response indicates the event is unlocked.

This is a read-only operation that does not modify any state. It's primarily used by frontend clients to:

- Check if they can acquire a lock before editing
- Display lock status to users (who is editing, how long until lock expires)
- Poll for lock changes during collaborative sessions

## 2. Request Details

- **HTTP Method**: GET
- **URL Structure**: `/api/events/{event_id}/lock`
- **Parameters**:
  - **Required Path Parameters**:
    - `event_id`: UUID of the event (must be valid UUID v4 format)
  - **Optional Parameters**: None
  - **Query Parameters**: None
- **Headers**:
  - `Authorization`: Bearer token (Supabase JWT) - **required**
- **Request Body**: N/A (GET request)

## 3. Used Types

### Response DTOs

```typescript
// From src/types.ts
interface LockStatusDTO {
  held_by: UUID | null; // User ID of lock holder, null if unlocked
  expires_at: ISO8601Timestamp | null; // Lock expiration time, null if unlocked
}

// Alias for clarity within EventDTO context
type EventLockDTO = LockStatusDTO;

// Type aliases
type UUID = string; // UUID v4 expected
type ISO8601Timestamp = string; // e.g. '2025-11-01T12:34:56.789Z'
```

### Internal Types

```typescript
// Validation schema (Zod)
interface PathParams {
  event_id: string; // Validated as UUID
}
```

### Database Types

```typescript
// Relevant fields from events table
interface EventLockFields {
  lock_held_by: string | null; // uuid references auth.users(id)
  lock_expires_at: string | null; // timestamptz
}
```

## 4. Response Details

### Success Response (200 OK)

**When lock is held:**

```json
{
  "held_by": "550e8400-e29b-41d4-a716-446655440000",
  "expires_at": "2025-11-01T14:30:00.000Z"
}
```

**When lock is not held or expired:**

```json
{
  "held_by": null,
  "expires_at": null
}
```

### Error Responses

**400 Bad Request** - Invalid event_id format:

```json
{
  "error": {
    "code": "INVALID_EVENT_ID",
    "message": "Event ID must be a valid UUID",
    "details": {
      "event_id": "invalid-id-format"
    }
  }
}
```

**401 Unauthorized** - Missing or invalid authentication:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

**403 Forbidden** - User is not the event owner:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to access this event"
  }
}
```

**404 Not Found** - Event does not exist or is soft-deleted:

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found"
  }
}
```

**500 Internal Server Error** - Server-side error:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

## 5. Data Flow

```
1. Client Request
   ↓
2. Astro Route Handler (/src/pages/api/events/[event_id]/lock.ts)
   ├─ Extract event_id from path
   ├─ Extract JWT from Authorization header
   └─ Validate path parameters (Zod schema)
   ↓
3. Authentication & Authorization
   ├─ Get Supabase client from context.locals
   ├─ Verify JWT and extract user_id
   ├─ Check user is event owner
   └─ Check event exists and is not soft-deleted
   ↓
4. Service Layer (LockService or EventService)
   ├─ Query events table for lock fields
   ├─ Check if lock has expired (compare lock_expires_at with current time)
   └─ Clear expired lock if necessary (optional optimization)
   ↓
5. Response Transformation
   ├─ Map database fields to LockStatusDTO
   ├─ Return null values if lock is expired or not held
   └─ Return 200 with lock status
```

### Database Query

```sql
-- Fetch lock status
SELECT lock_held_by, lock_expires_at
FROM events
WHERE id = $1
  AND owner_id = $2
  AND deleted_at IS NULL;

-- Optional: Clear expired lock (if implemented)
UPDATE events
SET lock_held_by = NULL, lock_expires_at = NULL, updated_at = NOW()
WHERE id = $1
  AND lock_expires_at < NOW()
  AND lock_held_by IS NOT NULL
RETURNING lock_held_by, lock_expires_at;
```

## 6. Security Considerations

### Authentication

- **Required**: Valid Supabase JWT in Authorization header
- **Validation**: Use `context.locals.supabase` to verify token
- **User Extraction**: Extract `user_id` from verified JWT claims

### Authorization

- **Event Ownership**: Only the event owner can view lock status
- **Row-Level Check**: Query must filter by `owner_id = authenticated_user_id`
- **Soft Delete**: Exclude soft-deleted events (`deleted_at IS NULL`)

### Data Protection

- **PII Exposure**: Lock holder's `user_id` is returned - acceptable as only event owner sees this
- **No Sensitive Data**: Lock status does not expose guest PII or plan details

### Rate Limiting

- **Consideration**: Implement basic rate limiting to prevent polling abuse
- **Recommendation**: Allow reasonable polling interval (e.g., max 60 requests/minute per user per event)
- **Implementation**: Can be added via middleware or service-level throttling

### Lock Expiry Handling

- **Expired Locks**: Treat expired locks as released (return null values)
- **Cleanup Strategy**: Either:
  - Clear on read (update database when expired lock detected)
  - Return null without cleanup (rely on acquire endpoint to clear)
- **Recommendation**: Return null without cleanup to keep GET idempotent

### Input Validation

- **Path Validation**: Ensure `event_id` matches UUID v4 format
- **SQL Injection**: Use parameterized queries (Supabase client handles this)
- **Type Safety**: TypeScript + Zod provide compile-time and runtime type safety

## 7. Error Handling

### Validation Errors (400)

- **Invalid UUID**: `event_id` is not a valid UUID format
- **Malformed Request**: Any unexpected path structure

**Handling**:

```typescript
try {
  const params = pathParamsSchema.parse({ event_id });
} catch (error) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_EVENT_ID",
        message: "Event ID must be a valid UUID",
        details: { event_id },
      },
    }),
    { status: 400 }
  );
}
```

### Authentication Errors (401)

- Missing Authorization header
- Invalid or expired JWT token
- Malformed Bearer token

**Handling**:

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
    { status: 401 }
  );
}
```

### Authorization Errors (403)

- User is not the event owner
- User attempting to access another user's event

**Handling**:

```typescript
// Handled by query filter - if no rows returned, could be 403 or 404
// Distinguish by checking if event exists first
```

### Not Found Errors (404)

- Event does not exist
- Event is soft-deleted
- Event exists but user is not owner (distinguish from 403)

**Handling**:

```typescript
if (!lockData) {
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
```

### Server Errors (500)

- Database connection failures
- Unexpected exceptions
- Supabase service errors

**Handling**:

```typescript
try {
  // ... service logic
} catch (error) {
  console.error("Error fetching lock status:", error);
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

### Error Logging Strategy

- **Client Errors (4xx)**: Log at INFO level with request context
- **Server Errors (5xx)**: Log at ERROR level with full stack trace
- **Structured Logging**: Include `event_id`, `user_id`, `endpoint`, `status_code`
- **No Audit Entry**: Simple read operations don't require audit log entries

## 8. Performance Considerations

### Database Query Optimization

- **Index Usage**: Query uses primary key (`id`) and foreign key (`owner_id`) - both indexed
- **Row Fetch**: Single row lookup by primary key - O(1) performance
- **Column Selection**: Only fetch required fields (`lock_held_by`, `lock_expires_at`)

### Caching Strategy

- **Not Recommended**: Lock status changes frequently during active editing
- **Short TTL**: If caching needed, use very short TTL (5-10 seconds max)
- **Cache Invalidation**: Must invalidate on lock acquire/release

### Response Size

- **Minimal**: Response is just two fields (UUID and timestamp)
- **Typical Size**: ~100-150 bytes (well within acceptable range)

### Polling Considerations

- **Frontend Pattern**: Clients may poll this endpoint during editing
- **Recommended Interval**: 10-30 seconds polling interval
- **Alternative**: Consider WebSocket/SSE for real-time lock updates (future enhancement)

### Database Connection

- **Connection Pooling**: Ensure Supabase client uses connection pooling
- **Query Timeout**: Set reasonable timeout (e.g., 5 seconds)

### Bottlenecks

- **None Expected**: Simple single-row query with indexed columns
- **Scalability**: Can handle thousands of concurrent requests
- **Monitoring**: Track query execution time and connection pool usage

## 9. Implementation Steps

### Step 1: Create Validation Schema

**File**: `src/pages/api/events/[event_id]/lock.ts`

```typescript
import { z } from "zod";

const pathParamsSchema = z.object({
  event_id: z.string().uuid("Event ID must be a valid UUID"),
});
```

**Validation**:

- UUID format validation
- Type coercion if necessary

### Step 2: Create or Extend Lock Service

**File**: `src/lib/services/lockService.ts` (or extend `src/lib/services/eventService.ts`)

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { LockStatusDTO, UUID } from "../types";

export class LockService {
  constructor(private supabase: SupabaseClient) {}

  async getLockStatus(eventId: UUID, userId: UUID): Promise<LockStatusDTO | null> {
    // Query event with ownership check
    const { data, error } = await this.supabase
      .from("events")
      .select("lock_held_by, lock_expires_at")
      .eq("id", eventId)
      .eq("owner_id", userId)
      .is("deleted_at", null)
      .single();

    if (error || !data) {
      return null; // Event not found or user not owner
    }

    // Check if lock is expired
    const now = new Date();
    const expiresAt = data.lock_expires_at ? new Date(data.lock_expires_at) : null;
    const isExpired = expiresAt && expiresAt < now;

    // Return null values if expired or not held
    if (!data.lock_held_by || isExpired) {
      return {
        held_by: null,
        expires_at: null,
      };
    }

    return {
      held_by: data.lock_held_by,
      expires_at: data.lock_expires_at,
    };
  }
}
```

**Logic**:

- Single query with ownership filter
- Expired lock detection
- Return DTO transformation

### Step 3: Implement Astro API Route

**File**: `src/pages/api/events/[event_id]/lock.ts`

```typescript
import type { APIRoute } from "astro";
import { z } from "zod";
import { LockService } from "../../../lib/services/lockService";
import type { LockStatusDTO, ApiErrorDTO } from "../../../types";

export const prerender = false;

const pathParamsSchema = z.object({
  event_id: z.string().uuid("Event ID must be a valid UUID"),
});

export const GET: APIRoute = async (context) => {
  try {
    // Step 1: Validate path parameters
    const parseResult = pathParamsSchema.safeParse({
      event_id: context.params.event_id,
    });

    if (!parseResult.success) {
      const error: ApiErrorDTO = {
        error: {
          code: "INVALID_EVENT_ID",
          message: "Event ID must be a valid UUID",
          details: { event_id: context.params.event_id },
        },
      };
      return new Response(JSON.stringify(error), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { event_id } = parseResult.data;

    // Step 2: Authenticate user
    const supabase = context.locals.supabase;
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      const error: ApiErrorDTO = {
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required",
        },
      };
      return new Response(JSON.stringify(error), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Step 3: Get lock status via service
    const lockService = new LockService(supabase);
    const lockStatus = await lockService.getLockStatus(event_id, user.id);

    if (lockStatus === null) {
      const error: ApiErrorDTO = {
        error: {
          code: "EVENT_NOT_FOUND",
          message: "Event not found",
        },
      };
      return new Response(JSON.stringify(error), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Step 4: Return lock status
    const response: LockStatusDTO = lockStatus;
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Step 5: Handle unexpected errors
    console.error("Error fetching lock status:", {
      event_id: context.params.event_id,
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    });

    const apiError: ApiErrorDTO = {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred",
      },
    };
    return new Response(JSON.stringify(apiError), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
```

**Key Points**:

- Use `context.locals.supabase` (not direct import)
- Early returns for error conditions
- Structured error responses
- Consistent header setting

### Step 4: Add TypeScript Types

**File**: `src/types.ts` (already exists, verify types are present)

Ensure these types exist (already defined in provided types.ts):

- `LockStatusDTO`
- `EventLockDTO`
- `ApiErrorDTO`
- `UUID`
- `ISO8601Timestamp`

### Step 5: Create Unit Tests (Optional but Recommended)

**File**: `src/lib/services/lockService.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { LockService } from "./lockService";

describe("LockService.getLockStatus", () => {
  it("should return lock status when lock is held", async () => {
    // Mock Supabase client
    const mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              is: vi.fn(() => ({
                single: vi.fn(() => ({
                  data: {
                    lock_held_by: "user-id-123",
                    lock_expires_at: "2025-11-01T14:30:00.000Z",
                  },
                  error: null,
                })),
              })),
            })),
          })),
        })),
      })),
    } as any;

    const lockService = new LockService(mockSupabase);
    const result = await lockService.getLockStatus("event-id", "user-id");

    expect(result).toEqual({
      held_by: "user-id-123",
      expires_at: "2025-11-01T14:30:00.000Z",
    });
  });

  it("should return null values when lock is expired", async () => {
    // Test expired lock scenario
    // ...
  });

  it("should return null when event not found", async () => {
    // Test not found scenario
    // ...
  });
});
```

### Step 6: Add Integration Test

**File**: `tests/api/events/lock.test.ts`

Test scenarios:

- Successfully fetch lock status (locked)
- Successfully fetch lock status (unlocked)
- Expired lock returns null values
- Invalid event_id format returns 400
- Unauthenticated request returns 401
- Non-owner request returns 404
- Non-existent event returns 404

### Step 7: Update API Documentation

**File**: `.ai/api-plan.md` (already documented, ensure consistency)

Verify endpoint documentation matches implementation.

### Step 8: Implement Rate Limiting (Optional Enhancement)

**File**: `src/middleware/rateLimiter.ts`

Consider adding rate limiting middleware for polling protection:

- Track requests per user per event
- Limit to reasonable threshold (e.g., 60/minute)
- Return 429 Too Many Requests if exceeded

### Step 9: Add Monitoring and Logging

- Log successful requests at INFO level
- Log errors at ERROR level with context
- Track response times in application metrics
- Monitor for unusual polling patterns

### Step 10: Frontend Integration Checklist

**Frontend Requirements**:

- Poll this endpoint during editing sessions
- Display lock status to user
- Show who is editing and time remaining
- Disable editing UI when lock held by another user
- Implement exponential backoff for polling

---

## Summary

This endpoint is a straightforward read-only operation with minimal complexity. The implementation focuses on:

- Proper authentication and authorization
- Efficient single-query database access
- Clear error handling with appropriate status codes
- Security through ownership validation
- Performance optimization for polling scenarios

The main considerations are ensuring proper expired lock handling and preparing for potential high-frequency polling by frontend clients.
