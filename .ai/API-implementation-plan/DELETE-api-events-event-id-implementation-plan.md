# API Endpoint Implementation Plan: DELETE /api/events/{event_id}

## 1. Endpoint Overview

This endpoint performs a soft delete operation on a wedding seating event by setting the `deleted_at` timestamp in the database. The operation is idempotent and irreversible through the API (recovery requires database intervention). Soft-deleted events are excluded from all query results and cannot be accessed or modified through standard API endpoints.

**Primary Use Cases:**

- Allow users to delete unwanted or test events
- Free up event count against potential user quotas
- Preserve data for audit trails and potential recovery by administrators
- Maintain referential integrity for cascading deletes (snapshots, share links, etc.)

**Key Characteristics:**

- Destructive operation (soft delete via timestamp)
- Owner-only access enforced via Supabase Row Level Security (RLS)
- Returns 204 No Content on success (no response body)
- Idempotent (deleting already-deleted event returns 404)
- Cascading soft deletes handled automatically by database triggers (if implemented)

## 2. Request Details

### HTTP Method

`DELETE`

### URL Structure

```
/api/events/{event_id}
```

### Path Parameters

| Parameter  | Type | Required | Constraints          | Description                          |
| ---------- | ---- | -------- | -------------------- | ------------------------------------ |
| `event_id` | UUID | Yes      | Valid UUID v4 format | Unique identifier of event to delete |

### Query Parameters

None

### Headers

| Header          | Required | Description                                              |
| --------------- | -------- | -------------------------------------------------------- |
| `Authorization` | Yes      | Bearer token with Supabase JWT. Format: `Bearer <token>` |

### Request Body

None (DELETE request)

### Example Request

```http
DELETE /api/events/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 3. Used Types

### Request Validation

**GetEventParamsSchema** (reused from GET endpoint):

```typescript
const GetEventParamsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
});
```

### Response Types

**Success Response:**

- Status: 204 No Content
- Body: Empty (no content)

**Error Response:**

- Type: `ApiErrorDTO`
- Status: 400 | 401 | 404 | 500

```typescript
interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

## 4. Response Details

### Success Response

**Status Code:** 204 No Content

**Headers:**

```
Content-Length: 0
```

**Body:** Empty (no content per HTTP specification)

### Error Responses

#### 400 Bad Request - Invalid event_id format

```json
{
  "error": {
    "code": "INVALID_EVENT_ID",
    "message": "Invalid event ID format",
    "details": {
      "event_id": "not-a-uuid",
      "validation_errors": ["event_id must be a valid UUID"]
    }
  }
}
```

#### 401 Unauthorized - Missing or invalid JWT

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required",
    "details": {}
  }
}
```

#### 404 Not Found - Event doesn't exist or access denied

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found or access denied",
    "details": {
      "event_id": "550e8400-e29b-41d4-a716-446655440000"
    }
  }
}
```

#### 500 Internal Server Error - Database or server error

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred",
    "details": {}
  }
}
```

## 5. Data Flow

### Request Processing Flow

```
1. Client Request
   ↓
2. Astro Middleware (src/middleware/index.ts)
   - Attach Supabase client to context.locals
   ↓
3. API Route Handler (src/pages/api/events/[event_id].ts)
   - Extract event_id from path params
   ↓
4. Authentication Check
   - Extract JWT from Authorization header
   - Call supabase.auth.getUser() to verify token & get user_id
   - Return 401 if invalid/missing
   ↓
5. Input Validation
   - Validate event_id with Zod (UUID format)
   - Return 400 if validation fails
   ↓
6. Service Layer Call (src/lib/services/events.service.ts)
   - EventsService.softDeleteEvent(supabase, event_id, user_id)
   ↓
7. Database Query
   - UPDATE events SET deleted_at = NOW()
     WHERE id = event_id AND owner_id = user_id AND deleted_at IS NULL
   - RLS policy automatically filters by owner_id
   ↓
8. Authorization Check (implicit via RLS)
   - If event exists but user doesn't own it: RLS prevents update (0 rows affected)
   - If event doesn't exist: 0 rows affected
   - If event already deleted: WHERE clause filters it out (0 rows affected)
   - All cases return same result (no rows affected)
   ↓
9. Audit Logging (optional for MVP)
   - Insert into audit_log table with action_type = 'event_deleted'
   - Store user_id, event_id, timestamp
   ↓
10. Response
    - Return 204 No Content if event was deleted (1 row affected)
    - Return 404 with ApiErrorDTO if no rows affected
```

### Database Interaction

**Update Query:**

```sql
UPDATE events
SET
  deleted_at = NOW(),
  updated_at = NOW()
WHERE id = $1
  AND owner_id = $2  -- Enforced by RLS
  AND deleted_at IS NULL  -- Prevent re-deleting
RETURNING id;
```

**Supabase Client Call:**

```typescript
const { data, error } = await supabase
  .from("events")
  .update({
    deleted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  })
  .eq("id", eventId)
  .is("deleted_at", null)
  .select("id")
  .single();
```

**Note:** The `.single()` call will throw an error if no rows are returned, which we handle as a 404.

### Cascading Effects

The soft delete operation has implications for related data:

1. **Snapshots** (`snapshots` table)
   - Foreign key: `event_id` references `events(id)` ON DELETE CASCADE
   - Snapshots are automatically deleted when parent event is hard-deleted
   - For soft deletes: snapshots remain but are inaccessible (queries filter by events.deleted_at)

2. **Share Links** (`share_links` table)
   - Foreign key: `event_id` references `events(id)` ON DELETE CASCADE
   - Share links become invalid when event is soft-deleted
   - Consider triggering share link revocation (set revoked_at) via database trigger

3. **Access Logs** (`access_logs` table)
   - Foreign key: `event_id` references `events(id)` ON DELETE CASCADE
   - Logs are preserved for audit purposes

4. **Audit Log** (`audit_log` table)
   - Foreign key: `event_id` references `events(id)` ON DELETE CASCADE
   - Audit trail is preserved

5. **Import Consent** (`import_consent` table)
   - Foreign key: `event_id` references `events(id)` ON DELETE CASCADE
   - Consent records are preserved for GDPR compliance

6. **Guest Imports** (`guest_imports` table)
   - Foreign key: `event_id` references `events(id)` ON DELETE CASCADE
   - Import history is preserved

7. **Data Requests** (`data_requests` table)
   - Optional foreign key: `event_id` references `events(id)` ON DELETE CASCADE
   - Related data requests are preserved

8. **Analytics Events** (`analytics_events` table)
   - Optional foreign key: `event_id` references `events(id)` ON DELETE SET NULL
   - Analytics data is preserved with event_id set to null

## 6. Security Considerations

### Authentication & Authorization

1. **JWT Validation**
   - Supabase SDK automatically validates JWT signature, expiration, and issuer
   - Extract user_id from verified JWT claims
   - Reject requests with missing or invalid tokens (401)

2. **Row Level Security (RLS)**
   - Database policy ensures users can only delete events where `owner_id = auth.uid()`
   - RLS provides defense-in-depth even if application logic has bugs
   - No need for additional authorization checks in application code

3. **Ownership Verification**
   - User can only delete their own events
   - Attempting to delete another user's event returns 404 (not 403) to avoid information disclosure
   - Already soft-deleted events also return 404

### Input Validation

1. **Path Parameter Sanitization**
   - Validate event_id as UUID before database query
   - Prevents SQL injection or path traversal attempts
   - Zod schema ensures type safety

### Data Protection

1. **Soft Delete Strategy**
   - Events are not permanently deleted; `deleted_at` timestamp is set
   - Allows for administrative recovery if user deletes by mistake
   - Preserves referential integrity for audit logs and analytics

2. **Audit Trail**
   - Consider logging deletion events to `audit_log` table
   - Capture: user_id, event_id, timestamp, IP address
   - Useful for compliance and dispute resolution

3. **Irreversibility via API**
   - No public API endpoint for undeleting events
   - Recovery requires database intervention by administrators
   - Prevents accidental restoration by users

### Rate Limiting (Future Enhancement)

- Consider implementing per-user rate limits (e.g., 10 deletions per minute)
- Prevents abuse and ensures fair resource usage
- Can be implemented via middleware or edge functions

### HTTPS Enforcement

- All API requests must use HTTPS in production
- Prevents JWT token interception
- Configured at hosting/reverse proxy level

### Information Disclosure Prevention

- Return 404 for both non-existent and unauthorized events
- Prevents attackers from enumerating valid event IDs
- Consistent error response regardless of failure reason

## 7. Error Handling

### Error Categories and Responses

| Error Category            | Status Code | Error Code       | Handling Strategy                                                 |
| ------------------------- | ----------- | ---------------- | ----------------------------------------------------------------- |
| **Validation Errors**     | 400         | INVALID_EVENT_ID | Validate input with Zod; return detailed validation errors        |
| **Authentication Errors** | 401         | UNAUTHORIZED     | Check JWT with supabase.auth.getUser(); return generic message    |
| **Authorization Errors**  | 404         | EVENT_NOT_FOUND  | RLS filters unauthorized events; indistinguishable from not found |
| **Not Found Errors**      | 404         | EVENT_NOT_FOUND  | Return same error for non-existent and unauthorized events        |
| **Already Deleted**       | 404         | EVENT_NOT_FOUND  | WHERE clause filters already-deleted events                       |
| **Database Errors**       | 500         | INTERNAL_ERROR   | Log error details; return generic message to client               |

### Detailed Error Scenarios

#### 1. Invalid Event ID Format

**Trigger:** event_id is not a valid UUID  
**Detection:** Zod validation fails  
**Response:**

```json
{
  "error": {
    "code": "INVALID_EVENT_ID",
    "message": "Invalid event ID format",
    "details": {
      "event_id": "abc123",
      "validation_errors": ["event_id must be a valid UUID"]
    }
  }
}
```

**Status:** 400

#### 2. Missing JWT Token

**Trigger:** Authorization header not provided  
**Detection:** supabase.auth.getUser() returns error  
**Response:**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required",
    "details": {}
  }
}
```

**Status:** 401

#### 3. Invalid/Expired JWT Token

**Trigger:** Token signature invalid or token expired  
**Detection:** supabase.auth.getUser() returns error  
**Response:** Same as #2  
**Status:** 401

#### 4. Event Not Found

**Trigger:** Event doesn't exist in database  
**Detection:** Supabase update returns 0 rows affected  
**Response:**

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found or access denied",
    "details": {
      "event_id": "550e8400-e29b-41d4-a716-446655440000"
    }
  }
}
```

**Status:** 404

#### 5. Unauthorized Access (User Doesn't Own Event)

**Trigger:** Event exists but owner_id != user_id  
**Detection:** RLS filters out row; update returns 0 rows affected  
**Response:** Same as #4 (intentionally indistinguishable)  
**Status:** 404

#### 6. Already Soft-Deleted Event

**Trigger:** Event has deleted_at timestamp (already deleted)  
**Detection:** WHERE clause filters by `deleted_at IS NULL`; update returns 0 rows affected  
**Response:** Same as #4  
**Status:** 404  
**Note:** This makes the operation idempotent

#### 7. Database Connection Error

**Trigger:** Supabase unavailable or network error  
**Detection:** Supabase client throws error  
**Logging:** Log full error with stack trace (server-side only)  
**Response:**

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred",
    "details": {}
  }
}
```

**Status:** 500

#### 8. Concurrent Modification

**Trigger:** Event deleted by another request between validation and update  
**Detection:** Update returns 0 rows affected  
**Response:** Same as #4  
**Status:** 404  
**Note:** No special handling needed; behaves as expected

### Error Logging Strategy

**What to Log:**

- All 500 errors with full error details and stack traces
- 401 errors (authentication failures) - potential security incidents
- 400 errors (validation failures) - may indicate client bugs or attacks
- Successful deletions (for audit purposes) - log to audit_log table
- Event_id, user_id, timestamp for all deletion attempts

**What NOT to Log:**

- Valid 404 responses (normal operation)
- Sensitive data (JWT tokens, PII from plan_data)

**Logging Levels:**

- ERROR: 500 errors, database failures
- WARN: 401 errors, repeated validation failures from same client
- INFO: Successful deletions (event_id, user_id, timestamp)
- DEBUG: Full request/response details (development only)

**Implementation:**

```typescript
// Use Astro's logger or console in MVP
console.error("[DELETE /api/events/:id]", {
  event_id: eventId,
  user_id: userId,
  error: error.message,
  stack: error.stack,
});

// Successful deletion
console.info("[DELETE /api/events/:id] Event soft-deleted", {
  event_id: eventId,
  user_id: userId,
  timestamp: new Date().toISOString(),
});
```

**Audit Log Entry (Optional for MVP):**

```typescript
// Insert into audit_log table
await supabase.from("audit_log").insert({
  event_id: eventId,
  user_id: userId,
  action_type: "event_deleted",
  details: {
    deleted_at: new Date().toISOString(),
  },
  created_at: new Date().toISOString(),
});
```

## 8. Performance Considerations

### Potential Bottlenecks

1. **Update Query Performance**
   - Simple UPDATE with primary key and indexed owner_id
   - **Mitigation:** Queries are inherently fast (<10ms)
   - **Monitoring:** Track query execution time

2. **RLS Policy Evaluation**
   - PostgreSQL evaluates RLS policy for every query
   - **Mitigation:** RLS is highly optimized; negligible overhead for simple equality checks
   - **Monitoring:** Track query execution time

3. **Cascading Effects**
   - Database triggers may revoke share links or perform other cleanup
   - **Mitigation:** Implement efficient triggers; test with high volume of related data
   - **Future:** Consider async cleanup via background jobs for large events

4. **Audit Logging Overhead**
   - Inserting into audit_log adds latency
   - **Mitigation:** Make audit log insert optional or async (background job)
   - **Future:** Batch audit log inserts

### Optimization Strategies

1. **Database Indexing**
   - Ensure index on `events(id)` (primary key, automatic)
   - Ensure index on `events(owner_id)` for RLS performance
   - Ensure index on `events(deleted_at)` for filtering soft-deleted events

2. **Response Time**
   - No response body for 204 reduces network transfer time
   - Keep response as lightweight as possible

3. **Idempotency**
   - Operation is naturally idempotent (deleting already-deleted event returns 404)
   - No additional idempotency key handling needed

4. **Database Connection Pooling**
   - Supabase handles connection pooling automatically
   - No application-level configuration needed

### Expected Performance Metrics

- **Response Time (p95):** < 100ms
- **Database Query Time:** < 20ms
- **Payload Size:** 0 bytes (204 No Content)
- **Throughput:** 500+ requests/second per instance (limited by database, not application)

## 9. Implementation Steps

### Step 1: Reuse Validation Schema

**File:** `src/lib/validation/events.validation.ts`

The `GetEventParamsSchema` already exists from the GET endpoint implementation. No new validation schema is needed.

```typescript
// Already exists
export const GetEventParamsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
});
```

### Step 2: Add Service Method

**File:** `src/lib/services/events.service.ts`

Add a new method to the existing `EventsService` class:

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/database.types";
import type { UUID } from "../../types";

export class EventsService {
  // ... existing methods (getEventById, etc.) ...

  /**
   * Soft delete an event by setting deleted_at timestamp
   * @param supabase - Supabase client with user JWT
   * @param eventId - Event UUID to delete
   * @param userId - Authenticated user UUID (for logging/audit)
   * @returns true if event was deleted, false if not found/unauthorized/already deleted
   * @throws Error if database operation fails
   */
  static async softDeleteEvent(supabase: SupabaseClient<Database>, eventId: UUID, userId: UUID): Promise<boolean> {
    const now = new Date().toISOString();

    // Update event with deleted_at timestamp
    // RLS policy ensures only owner can delete
    // WHERE clause ensures we don't re-delete already-deleted events
    const { data, error } = await supabase
      .from("events")
      .update({
        deleted_at: now,
        updated_at: now,
      })
      .eq("id", eventId)
      .is("deleted_at", null) // Only update if not already deleted
      .select("id")
      .single();

    if (error) {
      // PostgresError with code 'PGRST116' means no rows returned (not found/unauthorized/already deleted)
      if (error.code === "PGRST116") {
        return false;
      }
      // Other errors are unexpected
      throw error;
    }

    // Successfully deleted
    return true;
  }

  /**
   * Optional: Log deletion to audit_log table
   * @param supabase - Supabase client with user JWT
   * @param eventId - Event UUID
   * @param userId - User who deleted the event
   */
  static async logEventDeletion(supabase: SupabaseClient<Database>, eventId: UUID, userId: UUID): Promise<void> {
    const { error } = await supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "event_deleted",
      details: {
        deleted_at: new Date().toISOString(),
      },
    });

    if (error) {
      // Log error but don't throw (audit log failure shouldn't fail the operation)
      console.error("[EventsService.logEventDeletion] Audit log insert failed:", error);
    }
  }
}
```

### Step 3: Add DELETE Handler to API Route

**File:** `src/pages/api/events/[event_id].ts`

Add the DELETE handler to the existing file (which already has GET handler):

```typescript
import type { APIRoute } from "astro";
import { GetEventParamsSchema } from "../../../lib/validation/events.validation";
import { EventsService } from "../../../lib/services/events.service";
import type { ApiErrorDTO } from "../../../types";

export const prerender = false;

// ... existing GET handler ...

export const DELETE: APIRoute = async (context) => {
  try {
    // Step 1: Authenticate user
    const {
      data: { user },
      error: authError,
    } = await context.locals.supabase.auth.getUser();

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
            details: {},
          },
        } as ApiErrorDTO),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 2: Validate path parameters
    const paramsResult = GetEventParamsSchema.safeParse({
      event_id: context.params.event_id,
    });

    if (!paramsResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_EVENT_ID",
            message: "Invalid event ID format",
            details: {
              event_id: context.params.event_id,
              validation_errors: paramsResult.error.errors.map((e) => e.message),
            },
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const eventId = paramsResult.data.event_id;

    // Step 3: Soft delete event via service
    const deleted = await EventsService.softDeleteEvent(context.locals.supabase, eventId, user.id);

    // Step 4: Handle not found (event doesn't exist, unauthorized, or already deleted)
    if (!deleted) {
      return new Response(
        JSON.stringify({
          error: {
            code: "EVENT_NOT_FOUND",
            message: "Event not found or access denied",
            details: {
              event_id: eventId,
            },
          },
        } as ApiErrorDTO),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 5: Optional - Log to audit trail
    // Fire and forget; don't wait for completion
    EventsService.logEventDeletion(context.locals.supabase, eventId, user.id).catch((err) => {
      console.error("[DELETE /api/events/:id] Audit log failed:", err);
    });

    // Step 6: Log successful deletion
    console.info("[DELETE /api/events/:id] Event soft-deleted", {
      event_id: eventId,
      user_id: user.id,
      timestamp: new Date().toISOString(),
    });

    // Step 7: Return 204 No Content
    return new Response(null, {
      status: 204,
    });
  } catch (error) {
    // Log error server-side
    console.error("[DELETE /api/events/:id] Unexpected error:", {
      event_id: context.params.event_id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Return generic error to client
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred",
          details: {},
        },
      } as ApiErrorDTO),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
```

### Step 4: Verify RLS Policy

**Migration File:** `supabase/migrations/YYYYMMDDHHMMSS_events_rls_policy.sql`

Ensure the UPDATE policy exists (should already be created for PATCH endpoint):

```sql
-- Policy: Users can only update/delete their own events
CREATE POLICY "Users can update own events"
  ON events
  FOR UPDATE
  TO authenticated
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());
```

If not already created, add this policy.

### Step 5: Optional - Database Trigger for Share Link Revocation

**Migration File:** `supabase/migrations/YYYYMMDDHHMMSS_revoke_share_links_on_event_delete.sql`

When an event is soft-deleted, automatically revoke all share links:

```sql
-- Function to revoke share links when event is soft-deleted
CREATE OR REPLACE FUNCTION revoke_share_links_on_event_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- If deleted_at is being set (soft delete), revoke all share links
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE share_links
    SET
      revoked_at = NEW.deleted_at,
      revoked_by = NEW.owner_id
    WHERE event_id = NEW.id
      AND revoked_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to execute function after event update
CREATE TRIGGER revoke_share_links_trigger
AFTER UPDATE ON events
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION revoke_share_links_on_event_delete();
```

This ensures share links become invalid when events are deleted.

### Step 6: Optional - Add Event Deletion Analytics

If using the `analytics_events` table, track deletion events:

```typescript
// In the DELETE handler, after successful deletion
await supabase.from("analytics_events").insert({
  event_type: "event_deleted",
  event_id: eventId,
  user_id: user.id,
  metadata: {
    deleted_at: new Date().toISOString(),
  },
});
```

### Step 7: Manual Testing Checklist

1. **Test Valid Deletion**
   - Create a test event
   - Delete it with valid event_id and JWT
   - Verify 204 No Content response
   - Verify event has deleted_at timestamp in database
   - Verify event no longer appears in GET /api/events list

2. **Test Invalid UUID**
   - Request DELETE with invalid event_id (e.g., "abc123")
   - Verify 400 response with INVALID_EVENT_ID error

3. **Test Missing JWT**
   - Request DELETE without Authorization header
   - Verify 401 response with UNAUTHORIZED error

4. **Test Invalid JWT**
   - Request DELETE with malformed or expired JWT
   - Verify 401 response

5. **Test Non-Existent Event**
   - Request DELETE with valid UUID that doesn't exist
   - Verify 404 response with EVENT_NOT_FOUND error

6. **Test Unauthorized Deletion**
   - Create event with User A
   - Attempt to delete with User B's JWT
   - Verify 404 response (same as non-existent)

7. **Test Idempotency (Already Deleted)**
   - Delete an event successfully (204)
   - Delete the same event again
   - Verify 404 response (event already deleted)

8. **Test Cascading Effects**
   - Create event with snapshots and share links
   - Delete the event
   - Verify share links are revoked (if trigger implemented)
   - Verify snapshots remain but are inaccessible

9. **Test Audit Logging**
   - Delete an event
   - Verify audit_log entry was created (if implemented)
   - Check event_id, user_id, action_type, timestamp

### Step 8: Integration Testing

Create integration test file:

**File:** `tests/api/events/delete-event.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/db/database.types";

describe("DELETE /api/events/{event_id}", () => {
  let supabase: SupabaseClient<Database>;
  let authToken: string;
  let userId: string;
  let testEventId: string;

  beforeAll(async () => {
    // Setup: Create authenticated client
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

    // Create test user and get auth token
    // ... authentication setup ...

    // Create test event
    const { data } = await supabase
      .from("events")
      .insert({
        owner_id: userId,
        name: "Test Event for Deletion",
        grid_rows: 10,
        grid_cols: 10,
        plan_data: { tables: [], guests: [], settings: { color_palette: "default" } },
      })
      .select()
      .single();

    testEventId = data.id;
  });

  afterAll(async () => {
    // Cleanup: Delete test data
  });

  it("should delete event and return 204", async () => {
    const response = await fetch(`/api/events/${testEventId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${authToken}`,
      },
    });

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("should return 404 when deleting already-deleted event", async () => {
    // Delete twice
    await fetch(`/api/events/${testEventId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const response = await fetch(`/api/events/${testEventId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe("EVENT_NOT_FOUND");
  });

  it("should return 400 for invalid event ID", async () => {
    const response = await fetch(`/api/events/invalid-uuid`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_EVENT_ID");
  });

  it("should return 401 without authentication", async () => {
    const response = await fetch(`/api/events/${testEventId}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("should return 404 when deleting another user's event", async () => {
    // Create event with User A, delete with User B
    // ... test implementation ...
  });
});
```

### Step 9: Documentation Updates

1. **Update API Documentation**
   - Add DELETE endpoint to API reference
   - Document request/response format
   - Include example curl commands
   - Document error codes

2. **Update Postman/Insomnia Collection**
   - Add DELETE /api/events/{event_id} request
   - Include authentication header
   - Add test cases for different scenarios

3. **Update Architecture Documentation**
   - Document soft delete strategy
   - Explain cascading effects on related tables
   - Document audit logging approach

4. **Update Error Handling Guide**
   - Document EVENT_NOT_FOUND error code
   - Explain why 404 is returned instead of 403

### Step 10: Deploy and Monitor

1. **Deploy to Staging**
   - Deploy code changes
   - Run database migrations (RLS policy, triggers)
   - Run smoke tests

2. **Staging Validation**
   - Execute manual testing checklist
   - Run integration tests
   - Verify audit logging works
   - Test share link revocation

3. **Production Deployment**
   - Deploy to production
   - Monitor error rates and response times
   - Set up alerts for elevated error rates (>5% 500 errors)

4. **Monitoring and Alerts**
   - Track deletion frequency (analytics)
   - Monitor database performance
   - Alert on unusual deletion patterns (potential abuse)
   - Track audit log insertions

---

## Implementation Checklist

- [ ] Reuse validation schema from GET endpoint (Step 1)
- [ ] Add softDeleteEvent method to EventsService (Step 2)
- [ ] Add DELETE handler to API route (Step 3)
- [ ] Verify/create RLS UPDATE policy (Step 4)
- [ ] Optional: Create database trigger for share link revocation (Step 5)
- [ ] Optional: Add analytics tracking for deletions (Step 6)
- [ ] Manual testing (Step 7)
- [ ] Write integration tests (Step 8)
- [ ] Update documentation (Step 9)
- [ ] Deploy and monitor (Step 10)

## Success Criteria

- [ ] All manual tests pass
- [ ] Integration tests achieve >90% code coverage
- [ ] No linting or type errors
- [ ] Response time <100ms (p95)
- [ ] Error rate <1% in production
- [ ] Documentation complete and accurate
- [ ] Audit logging works correctly
- [ ] Share links are revoked when events are deleted
- [ ] Operation is idempotent (deleting twice returns 404)
- [ ] No information disclosure (404 for unauthorized and non-existent events)

## Additional Considerations

### Future Enhancements

1. **Permanent Deletion (Hard Delete)**
   - Add admin endpoint for permanent deletion
   - Implement after 30-day soft delete grace period
   - Background job to clean up old soft-deleted events

2. **Undelete Functionality**
   - Add admin/user endpoint to restore soft-deleted events
   - Set deleted_at = NULL
   - Verify data integrity before restoration

3. **Bulk Deletion**
   - Allow users to delete multiple events at once
   - POST /api/events/bulk-delete with array of event IDs
   - Implement transaction to ensure atomicity

4. **Deletion Confirmation**
   - Require users to confirm deletion via email or UI
   - Generate confirmation token
   - Prevent accidental deletions

5. **Export Before Delete**
   - Automatically trigger data export before deletion
   - Send download link to user's email
   - Ensure GDPR compliance

### GDPR/CCPA Compliance

1. **Right to Erasure**
   - Soft delete satisfies initial deletion request
   - Hard delete (permanent) must occur within 30 days
   - Document retention policies

2. **Data Portability**
   - Offer data export before deletion
   - Include all event data, snapshots, audit logs
   - Provide in machine-readable format (JSON/CSV)

3. **Audit Trail**
   - Log all deletion requests
   - Maintain audit trail even after hard delete
   - Retain for compliance period (varies by jurisdiction)
