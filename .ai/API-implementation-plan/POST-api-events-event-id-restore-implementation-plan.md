# API Endpoint Implementation Plan: POST /api/events/{event_id}/restore

## 1. Endpoint Overview

This endpoint restores a previously soft-deleted event by clearing its `deleted_at` timestamp. The endpoint enforces ownership validation to ensure only the event owner can restore their events. It returns a 409 Conflict status if the event is not currently in a deleted state, preventing invalid state transitions.

**Key behaviors:**

- Clears the `deleted_at` field to restore a soft-deleted event
- Validates event ownership (only owner can restore)
- Returns 409 if event is not deleted (deleted_at IS NULL)
- Updates the `updated_at` timestamp
- Creates an audit log entry for the restoration action
- Returns the full restored event data

## 2. Request Details

- **HTTP Method**: POST
- **URL Structure**: `/api/events/{event_id}/restore`
- **Authentication**: Required (Supabase Auth via middleware)
- **Content-Type**: application/json

### Parameters

**Path Parameters:**

- `event_id` (required, UUID) - The unique identifier of the event to restore

**Request Body:**

- Empty object `{}` or no body
- Type: `RestoreEventCommand` (defined as `Record<string, never>`)

### Example Request

```http
POST /api/events/550e8400-e29b-41d4-a716-446655440000/restore
Authorization: Bearer <supabase_jwt_token>
Content-Type: application/json

{}
```

## 3. Used Types

### Command Models

```typescript
// From types.ts
export type RestoreEventCommand = Record<string, never>; // Empty body marker
```

### Response DTOs

```typescript
// From types.ts
export interface EventDTO {
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

export interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Internal Types

```typescript
// From database.types.ts
type DBEventRow = Tables<"events">;
```

## 4. Response Details

### Success Response (200 OK)

**Status Code**: 200 OK

**Response Body**: Full `EventDTO` with `deleted_at` set to `null`

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "owner_id": "user-uuid-123",
  "name": "Summer Wedding 2025",
  "event_date": "2025-07-15",
  "grid": {
    "rows": 10,
    "cols": 10
  },
  "plan_data": {
    "tables": [],
    "guests": [],
    "settings": { "color_palette": "default" }
  },
  "autosave_version": 5,
  "lock": {
    "held_by": null,
    "expires_at": null
  },
  "created_at": "2025-01-15T10:00:00.000Z",
  "updated_at": "2025-11-01T14:30:00.000Z",
  "deleted_at": null
}
```

### Error Responses

**401 Unauthorized**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

**400 Bad Request** (Invalid UUID)

```json
{
  "error": {
    "code": "INVALID_EVENT_ID",
    "message": "Invalid event ID format",
    "details": { "event_id": "not-a-uuid" }
  }
}
```

**400 Bad Request** (Non-empty body)

```json
{
  "error": {
    "code": "INVALID_REQUEST_BODY",
    "message": "Request body must be empty"
  }
}
```

**403 Forbidden**

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You don't have permission to restore this event"
  }
}
```

**404 Not Found**

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found"
  }
}
```

**409 Conflict**

```json
{
  "error": {
    "code": "EVENT_NOT_DELETED",
    "message": "Event is not deleted and cannot be restored"
  }
}
```

**500 Internal Server Error**

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Failed to restore event"
  }
}
```

## 5. Data Flow

### High-Level Flow

1. **Request Received** → API endpoint handler in `/src/pages/api/events/[event_id]/restore.ts`
2. **Authentication Check** → Middleware validates Supabase JWT token
3. **Extract User Context** → Get authenticated user ID from `context.locals.supabase`
4. **Path Parameter Validation** → Validate `event_id` is valid UUID
5. **Request Body Validation** → Validate body is empty using Zod schema
6. **Service Call** → `eventService.restoreEvent(eventId, userId)`
7. **Service Logic**:
   - Query event by ID with ownership check
   - Verify event exists (404 if not)
   - Verify user owns event (403 if not)
   - Verify event is deleted (409 if not)
   - Update `deleted_at` to NULL and `updated_at` to NOW()
   - Insert audit log entry
   - Return updated event row
8. **Transform Response** → Convert DB row to `EventDTO`
9. **Return Response** → Send 200 with EventDTO

### Database Interactions

**Query 1**: Fetch event with ownership check

```sql
SELECT * FROM events
WHERE id = $1 AND owner_id = $2
LIMIT 1;
```

**Query 2**: Update event restoration

```sql
UPDATE events
SET deleted_at = NULL,
    updated_at = NOW()
WHERE id = $1 AND owner_id = $2
RETURNING *;
```

**Query 3**: Insert audit log

```sql
INSERT INTO audit_log (event_id, user_id, action_type, details)
VALUES ($1, $2, 'event_restored', $3);
```

Note: Consider adding 'event_restored' to `action_type_enum` if not present.

### Service Method Signature

```typescript
// src/lib/services/event.service.ts
export async function restoreEvent(supabase: SupabaseClient, eventId: UUID, userId: UUID): Promise<EventDTO> {
  // Implementation details in step 8
}
```

## 6. Security Considerations

### Authentication

- **Mechanism**: Supabase JWT token validation via Astro middleware
- **Location**: `context.locals.supabase.auth.getUser()`
- **Failure Mode**: Return 401 if token is missing, invalid, or expired

### Authorization

- **Ownership Check**: Verify `owner_id` matches authenticated `user_id`
- **Query Pattern**: Use `WHERE id = $1 AND owner_id = $2` to enforce ownership
- **Failure Mode**: Return 403 if user doesn't own the event

### Input Validation

- **Path Parameter**: Validate `event_id` is valid UUID v4 format using Zod
- **Request Body**: Validate body is empty object using Zod schema
- **SQL Injection**: Use parameterized queries (Supabase client handles this)

### Row-Level Security (RLS)

- **Defense-in-Depth**: Supabase RLS policies should enforce ownership rules
- **Policy**: Events table should have policy allowing owners to update their own rows
- **Note**: Service-level checks are primary; RLS is secondary safety net

### Rate Limiting

- **Current**: Not implemented in MVP
- **Future**: Consider rate limiting restore operations to prevent abuse (e.g., max 10 restores per hour per user)

### Data Exposure

- **Response**: Return full EventDTO (owner is requesting their own data)
- **PII**: Event data contains guest names/notes; only exposed to owner

## 7. Error Handling

### Error Scenarios and Status Codes

| Scenario                               | Status Code | Error Code           | Handling Strategy                                |
| -------------------------------------- | ----------- | -------------------- | ------------------------------------------------ |
| No auth token                          | 401         | UNAUTHORIZED         | Return immediately from middleware               |
| Invalid auth token                     | 401         | UNAUTHORIZED         | Supabase client handles; return 401              |
| Invalid UUID format                    | 400         | INVALID_EVENT_ID     | Zod validation; return with details              |
| Non-empty request body                 | 400         | INVALID_REQUEST_BODY | Zod validation; return error                     |
| Event doesn't exist                    | 404         | EVENT_NOT_FOUND      | Query returns null; return 404                   |
| User doesn't own event                 | 403         | FORBIDDEN            | Query returns null (ownership check); return 403 |
| Event not deleted (deleted_at IS NULL) | 409         | EVENT_NOT_DELETED    | Check deleted_at in service; return 409          |
| Database connection error              | 500         | INTERNAL_ERROR       | Catch exception; log error; return 500           |
| Database constraint violation          | 500         | INTERNAL_ERROR       | Catch exception; log error; return 500           |

### Error Response Factory

Create a helper function for consistent error responses:

```typescript
// src/lib/errors.ts
export function createApiError(code: string, message: string, details?: Record<string, unknown>): ApiErrorDTO {
  return {
    error: {
      code,
      message,
      ...(details && { details }),
    },
  };
}
```

### Error Logging

- **Application Errors**: Log to console with context (user_id, event_id, error message)
- **Audit Trail**: Log successful restoration to `audit_log` table
- **Monitoring**: Consider integration with error tracking service (e.g., Sentry) in production

### Audit Log Entry

```typescript
// After successful restoration
await supabase.from("audit_log").insert({
  event_id: eventId,
  user_id: userId,
  action_type: "event_restored", // May need to add to enum
  details: {
    previous_deleted_at: eventBeforeUpdate.deleted_at,
    restored_at: new Date().toISOString(),
  },
});
```

## 8. Performance Considerations

### Database Query Optimization

- **Single Query**: Use `RETURNING *` in UPDATE to avoid separate SELECT
- **Index**: Ensure index on `events(id, owner_id)` for fast lookup
- **Index**: Ensure index on `events(deleted_at)` for soft-delete queries

### Response Size

- **EventDTO Size**: Includes full `plan_data` JSONB which can be large
- **Mitigation**: This is acceptable as restoration is infrequent operation
- **Alternative**: Could return `EventSummaryDTO` without plan_data, but spec implies full event

### Caching

- **Not Applicable**: Restoration is a write operation; no caching needed
- **Cache Invalidation**: If event list is cached, invalidate user's event list cache

### Connection Pooling

- **Supabase Client**: Handles connection pooling automatically
- **No Action Required**: Default configuration is sufficient

### Rate Limiting

- **Current**: Not implemented
- **Future**: Implement per-user rate limiting to prevent abuse
  - Example: Max 10 restore operations per hour per user
  - Use Redis or Supabase edge functions for distributed rate limiting

### Monitoring

- **Metrics**: Track restoration frequency, latency, error rates
- **Alerts**: Set up alerts for high error rates or unusual restoration patterns

## 9. Implementation Steps

### Step 1: Create Zod Validation Schemas

**File**: `src/pages/api/events/[event_id]/restore.ts`

```typescript
import { z } from "zod";

// UUID validation schema
const eventIdSchema = z.string().uuid({ message: "Invalid event ID format" });

// Empty body validation schema
const restoreEventBodySchema = z.object({}).strict();
```

### Step 2: Create Event Service Method

**File**: `src/lib/services/event.service.ts` (create if doesn't exist)

```typescript
import type { SupabaseClient } from "@/db/supabase.client";
import type { EventDTO, UUID } from "@/types";

export async function restoreEvent(supabase: SupabaseClient, eventId: UUID, userId: UUID): Promise<EventDTO> {
  // 1. Fetch event with ownership check
  const { data: event, error: fetchError } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .eq("owner_id", userId)
    .single();

  // 2. Handle not found or forbidden
  if (fetchError || !event) {
    if (fetchError?.code === "PGRST116") {
      // Check if event exists but belongs to different user
      const { data: existsCheck } = await supabase.from("events").select("id").eq("id", eventId).single();

      if (existsCheck) {
        throw new Error("FORBIDDEN");
      }
      throw new Error("EVENT_NOT_FOUND");
    }
    throw new Error("EVENT_NOT_FOUND");
  }

  // 3. Check if event is deleted
  if (!event.deleted_at) {
    throw new Error("EVENT_NOT_DELETED");
  }

  // 4. Restore event (set deleted_at to null)
  const { data: restoredEvent, error: updateError } = await supabase
    .from("events")
    .update({
      deleted_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId)
    .eq("owner_id", userId)
    .select("*")
    .single();

  if (updateError || !restoredEvent) {
    throw new Error("INTERNAL_ERROR");
  }

  // 5. Create audit log entry
  await supabase.from("audit_log").insert({
    event_id: eventId,
    user_id: userId,
    action_type: "event_restored", // Ensure this is in action_type_enum
    details: {
      previous_deleted_at: event.deleted_at,
      restored_at: new Date().toISOString(),
    },
  });

  // 6. Transform to EventDTO
  return mapEventRowToDTO(restoredEvent);
}

// Helper function to transform DB row to DTO
function mapEventRowToDTO(row: any): EventDTO {
  return {
    id: row.id,
    owner_id: row.owner_id,
    name: row.name,
    event_date: row.event_date,
    grid: { rows: row.grid_rows, cols: row.grid_cols },
    plan_data: row.plan_data,
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

### Step 3: Create API Error Helper

**File**: `src/lib/errors.ts` (create if doesn't exist)

```typescript
import type { ApiErrorDTO } from "@/types";

export function createApiError(code: string, message: string, details?: Record<string, unknown>): ApiErrorDTO {
  return {
    error: {
      code,
      message,
      ...(details && { details }),
    },
  };
}

export const errorMessages = {
  UNAUTHORIZED: "Authentication required",
  FORBIDDEN: "You don't have permission to restore this event",
  EVENT_NOT_FOUND: "Event not found",
  EVENT_NOT_DELETED: "Event is not deleted and cannot be restored",
  INVALID_EVENT_ID: "Invalid event ID format",
  INVALID_REQUEST_BODY: "Request body must be empty",
  INTERNAL_ERROR: "Failed to restore event",
};
```

### Step 4: Create API Endpoint Handler

**File**: `src/pages/api/events/[event_id]/restore.ts`

```typescript
import type { APIRoute } from "astro";
import { z } from "zod";
import { restoreEvent } from "@/lib/services/event.service";
import { createApiError, errorMessages } from "@/lib/errors";

export const prerender = false;

// Validation schemas
const eventIdSchema = z.string().uuid({ message: "Invalid event ID format" });
const restoreEventBodySchema = z.object({}).strict();

export const POST: APIRoute = async (context) => {
  try {
    // 1. Check authentication
    const supabase = context.locals.supabase;
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(JSON.stringify(createApiError("UNAUTHORIZED", errorMessages.UNAUTHORIZED)), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Validate event_id from path
    const eventId = context.params.event_id;
    const eventIdValidation = eventIdSchema.safeParse(eventId);

    if (!eventIdValidation.success) {
      return new Response(
        JSON.stringify(createApiError("INVALID_EVENT_ID", errorMessages.INVALID_EVENT_ID, { event_id: eventId })),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Validate request body (should be empty)
    const body = await context.request.json().catch(() => ({}));
    const bodyValidation = restoreEventBodySchema.safeParse(body);

    if (!bodyValidation.success) {
      return new Response(JSON.stringify(createApiError("INVALID_REQUEST_BODY", errorMessages.INVALID_REQUEST_BODY)), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Call service to restore event
    const restoredEvent = await restoreEvent(supabase, eventIdValidation.data, user.id);

    // 5. Return success response
    return new Response(JSON.stringify(restoredEvent), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Handle known errors
    if (error instanceof Error) {
      const errorMessage = error.message;

      if (errorMessage === "EVENT_NOT_FOUND") {
        return new Response(JSON.stringify(createApiError("EVENT_NOT_FOUND", errorMessages.EVENT_NOT_FOUND)), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (errorMessage === "FORBIDDEN") {
        return new Response(JSON.stringify(createApiError("FORBIDDEN", errorMessages.FORBIDDEN)), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (errorMessage === "EVENT_NOT_DELETED") {
        return new Response(JSON.stringify(createApiError("EVENT_NOT_DELETED", errorMessages.EVENT_NOT_DELETED)), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Handle unexpected errors
    console.error("Error restoring event:", error);
    return new Response(JSON.stringify(createApiError("INTERNAL_ERROR", errorMessages.INTERNAL_ERROR)), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
```

### Step 5: Update Database Enum (If Needed)

**File**: `supabase/migrations/[timestamp]_add_event_restored_action.sql`

If `event_restored` is not in the `action_type_enum`, create a migration:

```sql
-- Add event_restored to action_type_enum if not present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'event_restored'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'action_type_enum')
  ) THEN
    ALTER TYPE action_type_enum ADD VALUE 'event_restored';
  END IF;
END
$$;
```

### Step 6: Update Database Types

**File**: `src/db/database.types.ts`

Regenerate types from Supabase after migration:

```bash
npx supabase gen types typescript --project-id <project-id> > src/db/database.types.ts
```

### Step 7: Add Database Indexes (If Not Present)

**File**: `supabase/migrations/[timestamp]_add_events_indexes.sql`

```sql
-- Index for event lookup with ownership check
CREATE INDEX IF NOT EXISTS idx_events_id_owner
ON events(id, owner_id)
WHERE deleted_at IS NULL;

-- Index for soft-deleted events queries
CREATE INDEX IF NOT EXISTS idx_events_deleted_at
ON events(deleted_at)
WHERE deleted_at IS NOT NULL;
```

### Step 8: Configure RLS Policies

**File**: `supabase/migrations/[timestamp]_events_rls_policies.sql`

Ensure RLS policy allows owners to update their events:

```sql
-- Enable RLS on events table
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Policy: Users can update their own events
CREATE POLICY IF NOT EXISTS events_update_own
ON events FOR UPDATE
TO authenticated
USING (owner_id = auth.uid())
WITH CHECK (owner_id = auth.uid());
```

### Step 9: Test Implementation

Create integration tests:

**File**: `tests/api/events/restore.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
// Import test helpers and mock Supabase client

describe("POST /api/events/{event_id}/restore", () => {
  it("should restore a soft-deleted event", async () => {
    // Test successful restoration
  });

  it("should return 401 if not authenticated", async () => {
    // Test authentication requirement
  });

  it("should return 400 for invalid event_id UUID", async () => {
    // Test UUID validation
  });

  it("should return 404 if event does not exist", async () => {
    // Test not found case
  });

  it("should return 403 if user does not own event", async () => {
    // Test authorization
  });

  it("should return 409 if event is not deleted", async () => {
    // Test conflict when event.deleted_at IS NULL
  });

  it("should return 400 if request body is not empty", async () => {
    // Test body validation
  });

  it("should create audit log entry on success", async () => {
    // Verify audit trail
  });
});
```

### Step 10: Update API Documentation

Add endpoint documentation to API reference:

- Document the endpoint in OpenAPI/Swagger spec
- Add usage examples
- Document all error codes and scenarios
- Include authentication requirements

### Step 11: Deploy and Monitor

- Deploy changes to staging environment
- Run integration tests
- Monitor error rates and latency
- Deploy to production with monitoring
- Set up alerts for high error rates or unusual patterns
