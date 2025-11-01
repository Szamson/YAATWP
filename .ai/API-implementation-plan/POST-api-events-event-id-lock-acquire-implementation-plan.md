# API Endpoint Implementation Plan: POST /api/events/{event_id}/lock/acquire

## 1. Endpoint Overview

This endpoint enables authenticated users to acquire an exclusive edit lock on a specific event (seating plan). The locking mechanism implements soft single-editor locking to prevent concurrent modifications while allowing the UI to display who currently holds the lock. The lock is time-bound and automatically expires, preventing indefinite locks from abandoned sessions.

**Primary Use Cases:**

- User opens an event for editing and needs to prevent concurrent modifications
- Client wants to refresh/extend an existing lock before it expires
- UI needs to display lock status to inform other users when editing is unavailable

**Key Behaviors:**

- Lock can only be acquired by the event owner
- Expired locks are automatically cleared before attempting acquisition
- User can re-acquire their own lock (extends expiration)
- Returns conflict status if lock is held by another user
- Configurable lock duration with reasonable bounds

## 2. Request Details

- **HTTP Method**: POST
- **URL Structure**: `/api/events/{event_id}/lock/acquire`
- **Content-Type**: `application/json`

### Path Parameters:

- **Required**:
  - `event_id` (UUID): Unique identifier of the event to lock

### Request Body:

```typescript
{
  minutes?: number  // Optional lock duration in minutes (default: 15, max: 120)
}
```

### Headers:

- `Authorization`: Bearer token from Supabase Auth (required)
- `Content-Type`: application/json

### Example Request:

```http
POST /api/events/550e8400-e29b-41d4-a716-446655440000/lock/acquire
Authorization: Bearer <supabase_jwt_token>
Content-Type: application/json

{
  "minutes": 30
}
```

## 3. Used Types

### Command Models:

```typescript
// From types.ts
interface AcquireLockCommand {
  minutes?: number;
}
```

### Response DTOs:

```typescript
// Success response (custom, not in types.ts)
interface LockAcquiredDTO {
  acquired: true;
  expires_at: ISO8601Timestamp;
}

// Conflict response (custom, not in types.ts)
interface LockConflictDTO {
  acquired: false;
  held_by: UUID;
  expires_at: ISO8601Timestamp;
}

// From types.ts (for internal use)
interface LockStatusDTO {
  held_by: UUID | null;
  expires_at: ISO8601Timestamp | null;
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

## 4. Response Details

### Success Response (200 OK):

Lock successfully acquired or extended.

```json
{
  "acquired": true,
  "expires_at": "2025-11-01T14:30:00.000Z"
}
```

### Conflict Response (409 Conflict):

Lock is currently held by another user and has not expired.

```json
{
  "acquired": false,
  "held_by": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "expires_at": "2025-11-01T14:25:00.000Z"
}
```

### Error Responses:

**400 Bad Request** - Invalid input:

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Lock duration must be between 1 and 120 minutes",
    "details": { "field": "minutes", "value": 200 }
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

**403 Forbidden** - User lacks permission:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Only the event owner can acquire locks"
  }
}
```

**404 Not Found** - Event doesn't exist:

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found or has been deleted"
  }
}
```

**500 Internal Server Error** - Server-side failure:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Failed to acquire lock due to server error"
  }
}
```

## 5. Data Flow

```
1. Client Request
   ↓
2. Astro API Route Handler (/src/pages/api/events/[event_id]/lock/acquire.ts)
   ↓
3. Extract Supabase client from context.locals
   ↓
4. Authenticate user from session
   ↓
5. Validate request (path params + body)
   ↓
6. Call LockingService.acquireLock()
   ├─→ 6a. Begin transaction
   ├─→ 6b. SELECT event FOR UPDATE (acquire row lock)
   ├─→ 6c. Verify event exists and not soft-deleted
   ├─→ 6d. Verify user is owner
   ├─→ 6e. Check current lock status
   ├─→ 6f. Clear expired locks
   ├─→ 6g. If lock available or held by same user:
   │       - UPDATE events SET lock_held_by, lock_expires_at
   │       - INSERT audit_log entry
   │       - COMMIT transaction
   │       - Return { acquired: true, expires_at }
   └─→ 6h. If lock held by other user:
           - ROLLBACK transaction
           - Return { acquired: false, held_by, expires_at }
   ↓
7. Format and return response (200 or 409)
```

### Database Interactions:

**Primary Table**: `events`

- Read: `id`, `owner_id`, `lock_held_by`, `lock_expires_at`, `deleted_at`
- Write: `lock_held_by`, `lock_expires_at`, `updated_at`

**Secondary Table**: `audit_log`

- Write: Insert log entry when lock acquired

**Transaction Isolation**: Use `SERIALIZABLE` or row-level locking (`SELECT ... FOR UPDATE`) to prevent race conditions.

## 6. Security Considerations

### Authentication & Authorization:

1. **Session Validation**:
   - Extract user from `context.locals.supabase.auth.getUser()`
   - Reject unauthenticated requests with 401
2. **Ownership Verification**:
   - Query event to verify `owner_id` matches authenticated user
   - Return 403 if user is not the owner
3. **Soft-Delete Check**:
   - Ensure `deleted_at IS NULL` before allowing lock acquisition
   - Return 404 if event is soft-deleted

### Input Validation:

1. **Path Parameter Validation**:

   ```typescript
   const eventIdSchema = z.string().uuid();
   ```

2. **Body Validation**:
   ```typescript
   const acquireLockSchema = z.object({
     minutes: z.number().int().min(1).max(120).optional().default(15),
   });
   ```

### Security Threats & Mitigations:

| Threat                                        | Mitigation                                                    |
| --------------------------------------------- | ------------------------------------------------------------- |
| **Race Condition** (concurrent lock attempts) | Use `SELECT ... FOR UPDATE` in transaction                    |
| **Lock Hijacking** (unauthorized acquisition) | Verify ownership before granting lock                         |
| **DoS via Long Locks**                        | Cap maximum duration at 120 minutes                           |
| **Parameter Tampering**                       | Strict Zod validation with bounds checking                    |
| **Session Hijacking**                         | Leverage Supabase JWT validation                              |
| **Lock Starvation**                           | Automatic expiration ensures locks don't persist indefinitely |

### Data Exposure:

- Lock holder's `user_id` is exposed in conflict responses (acceptable for collaborative context)
- No PII or sensitive plan data exposed in lock endpoints

## 7. Error Handling

### Validation Errors (400):

```typescript
// Invalid UUID format
if (!eventIdSchema.safeParse(event_id).success) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_EVENT_ID",
        message: "Invalid event ID format",
      },
    }),
    { status: 400 }
  );
}

// Invalid minutes value
if (minutes < 1 || minutes > 120) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_DURATION",
        message: "Lock duration must be between 1 and 120 minutes",
        details: { minutes },
      },
    }),
    { status: 400 }
  );
}
```

### Authentication Errors (401):

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

### Authorization Errors (403):

```typescript
if (event.owner_id !== user.id) {
  return new Response(
    JSON.stringify({
      error: {
        code: "FORBIDDEN",
        message: "Only the event owner can acquire locks",
      },
    }),
    { status: 403 }
  );
}
```

### Not Found Errors (404):

```typescript
if (!event || event.deleted_at !== null) {
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

### Conflict Errors (409):

```typescript
// Lock held by another user
return new Response(
  JSON.stringify({
    acquired: false,
    held_by: event.lock_held_by,
    expires_at: event.lock_expires_at,
  }),
  { status: 409 }
);
```

### Database Errors (500):

```typescript
try {
  // ... database operations
} catch (error) {
  console.error("Lock acquisition failed:", error);
  return new Response(
    JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: "Failed to acquire lock due to server error",
      },
    }),
    { status: 500 }
  );
}
```

### Error Logging:

- Log all 500 errors to console with stack traces
- Consider structured logging for production (e.g., Sentry integration)
- Audit log tracks successful acquisitions, not failures

## 8. Performance Considerations

### Potential Bottlenecks:

1. **Database Transaction Overhead**: Row-level locking may cause contention under high concurrency
2. **Timestamp Calculations**: Computing expiration timestamps in every request

### Optimization Strategies:

1. **Index Optimization**:

   ```sql
   -- Ensure indexes exist for fast lookups
   CREATE INDEX IF NOT EXISTS idx_events_lock_held_by ON events(lock_held_by);
   CREATE INDEX IF NOT EXISTS idx_events_lock_expires_at ON events(lock_expires_at);
   ```

2. **Minimize Transaction Duration**:
   - Keep transaction scope tight (only lock acquisition logic)
   - Avoid expensive operations within transaction

3. **Database-Level Timestamp Generation**:

   ```sql
   -- Let PostgreSQL calculate expiration timestamp
   UPDATE events
   SET lock_expires_at = NOW() + INTERVAL '15 minutes'
   WHERE id = $1;
   ```

4. **Connection Pooling**: Ensure Supabase client uses connection pooling for efficient resource usage

5. **Caching Considerations**:
   - Lock status is inherently volatile; avoid caching
   - Client should poll lock status periodically (e.g., every 30 seconds)

### Expected Load:

- Low-to-moderate frequency (users editing events)
- Typically < 10 concurrent lock operations per event
- No need for aggressive caching or rate limiting at MVP scale

## 9. Implementation Steps

### Step 1: Create Validation Schemas

**File**: `src/pages/api/events/[event_id]/lock/acquire.ts`

```typescript
import { z } from "zod";

const eventIdSchema = z.string().uuid();
const acquireLockBodySchema = z.object({
  minutes: z.number().int().min(1).max(120).optional().default(15),
});
```

### Step 2: Create LockingService

**File**: `src/lib/services/locking.service.ts`

```typescript
import type { SupabaseClient } from "@/db/supabase.client";

export interface LockAcquisitionResult {
  acquired: boolean;
  held_by: string | null;
  expires_at: string | null;
}

export class LockingService {
  /**
   * Attempts to acquire an exclusive lock on an event
   * Automatically clears expired locks before attempting acquisition
   */
  static async acquireLock(
    supabase: SupabaseClient,
    eventId: string,
    userId: string,
    minutes: number
  ): Promise<LockAcquisitionResult> {
    // Implementation details in next steps
  }

  /**
   * Checks if a timestamp represents an expired lock
   */
  static isLockExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return true;
    return new Date(expiresAt) < new Date();
  }
}
```

**Implementation Details**:

1. Begin transaction using Supabase client
2. Query event with `SELECT ... FOR UPDATE` to acquire row lock:
   ```sql
   SELECT id, owner_id, lock_held_by, lock_expires_at, deleted_at
   FROM events
   WHERE id = $1
   FOR UPDATE;
   ```
3. Validate event exists and `deleted_at IS NULL`
4. Verify `owner_id === userId`
5. Check lock status:
   - If `lock_held_by IS NULL` or lock expired → proceed to acquire
   - If `lock_held_by === userId` → extend lock (re-acquire)
   - If `lock_held_by !== userId` and not expired → return conflict
6. Update event:
   ```sql
   UPDATE events
   SET
     lock_held_by = $1,
     lock_expires_at = NOW() + ($2 || ' minutes')::INTERVAL,
     updated_at = NOW()
   WHERE id = $3;
   ```
7. Insert audit log:
   ```sql
   INSERT INTO audit_log (event_id, user_id, action_type, details)
   VALUES ($1, $2, 'lock_acquired', $3);
   ```
8. Commit transaction
9. Return `{ acquired: true, held_by: userId, expires_at }`

### Step 3: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/lock/acquire.ts`

```typescript
import type { APIRoute } from "astro";
import { z } from "zod";
import { LockingService } from "@/lib/services/locking.service";

export const prerender = false;

const eventIdSchema = z.string().uuid();
const acquireLockBodySchema = z.object({
  minutes: z.number().int().min(1).max(120).optional().default(15),
});

export const POST: APIRoute = async (context) => {
  // Step 3a: Extract dependencies
  const supabase = context.locals.supabase;
  const { event_id } = context.params;

  // Step 3b: Authenticate user
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
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Step 3c: Validate event_id
  const eventIdValidation = eventIdSchema.safeParse(event_id);
  if (!eventIdValidation.success) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_EVENT_ID",
          message: "Invalid event ID format",
        },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Step 3d: Parse and validate request body
  let body;
  try {
    const rawBody = await context.request.json();
    body = acquireLockBodySchema.parse(rawBody);
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Invalid request body",
          details: error instanceof z.ZodError ? error.errors : undefined,
        },
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Step 3e: Acquire lock via service
  try {
    const result = await LockingService.acquireLock(supabase, eventIdValidation.data, user.id, body.minutes);

    if (result.acquired) {
      return new Response(
        JSON.stringify({
          acquired: true,
          expires_at: result.expires_at,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    } else {
      return new Response(
        JSON.stringify({
          acquired: false,
          held_by: result.held_by,
          expires_at: result.expires_at,
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  } catch (error: any) {
    // Step 3f: Handle service errors
    if (error.code === "EVENT_NOT_FOUND") {
      return new Response(
        JSON.stringify({
          error: {
            code: "EVENT_NOT_FOUND",
            message: "Event not found or has been deleted",
          },
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (error.code === "FORBIDDEN") {
      return new Response(
        JSON.stringify({
          error: {
            code: "FORBIDDEN",
            message: "Only the event owner can acquire locks",
          },
        }),
        {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    console.error("Lock acquisition error:", error);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to acquire lock due to server error",
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
};
```

### Step 4: Implement LockingService.acquireLock() Method

**Detailed Implementation**:

```typescript
static async acquireLock(
  supabase: SupabaseClient,
  eventId: string,
  userId: string,
  minutes: number
): Promise<LockAcquisitionResult> {
  // Use Supabase RPC or direct SQL for transaction
  const { data: event, error: fetchError } = await supabase
    .from('events')
    .select('id, owner_id, lock_held_by, lock_expires_at, deleted_at')
    .eq('id', eventId)
    .single();

  // Handle not found
  if (fetchError || !event) {
    throw { code: 'EVENT_NOT_FOUND', message: 'Event not found' };
  }

  // Handle soft-deleted
  if (event.deleted_at !== null) {
    throw { code: 'EVENT_NOT_FOUND', message: 'Event has been deleted' };
  }

  // Verify ownership
  if (event.owner_id !== userId) {
    throw { code: 'FORBIDDEN', message: 'Only the owner can acquire locks' };
  }

  // Check if lock is available
  const lockExpired = this.isLockExpired(event.lock_expires_at);
  const lockAvailable = !event.lock_held_by || lockExpired;
  const userHoldsLock = event.lock_held_by === userId;

  if (!lockAvailable && !userHoldsLock) {
    // Lock held by another user
    return {
      acquired: false,
      held_by: event.lock_held_by,
      expires_at: event.lock_expires_at
    };
  }

  // Acquire/extend lock
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();

  const { error: updateError } = await supabase
    .from('events')
    .update({
      lock_held_by: userId,
      lock_expires_at: expiresAt,
      updated_at: new Date().toISOString()
    })
    .eq('id', eventId);

  if (updateError) {
    throw updateError;
  }

  // Log to audit
  await supabase
    .from('audit_log')
    .insert({
      event_id: eventId,
      user_id: userId,
      action_type: 'lock_acquired',
      details: { minutes, extended: userHoldsLock }
    });

  return {
    acquired: true,
    held_by: userId,
    expires_at: expiresAt
  };
}
```

### Step 5: Add Database Indexes (if not present)

**Migration File**: `supabase/migrations/YYYYMMDDHHMMSS_add_lock_indexes.sql`

```sql
-- Optimize lock status queries
CREATE INDEX IF NOT EXISTS idx_events_lock_held_by
ON events(lock_held_by)
WHERE lock_held_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_lock_expires_at
ON events(lock_expires_at)
WHERE lock_expires_at IS NOT NULL;
```

### Step 6: Testing Checklist

**Unit Tests** (if test framework configured):

- [ ] Validate UUID parsing for event_id
- [ ] Validate minutes bounds (1-120)
- [ ] Test lock expiration logic
- [ ] Test ownership verification

**Integration Tests**:

- [ ] Successful lock acquisition (200)
- [ ] Lock extension by same user (200)
- [ ] Lock conflict with another user (409)
- [ ] Invalid event_id returns 400
- [ ] Invalid minutes value returns 400
- [ ] Unauthenticated request returns 401
- [ ] Non-owner request returns 403
- [ ] Soft-deleted event returns 404
- [ ] Missing event returns 404

**Manual Testing**:

1. Use Postman/Thunder Client to send POST requests
2. Verify database state after each operation
3. Test concurrent requests from multiple users
4. Verify audit_log entries are created
5. Test lock expiration scenarios

### Step 7: Documentation Updates

**Update Files**:

1. `.ai/copilot-instructions.md` - Add locking service to project structure if needed
2. `README.md` - Document lock duration defaults and maximums
3. API documentation (if separate) - Include endpoint specification

### Step 8: Deployment Considerations

1. **Environment Variables**: None required (uses existing Supabase config)
2. **Database Migrations**: Apply lock index migrations before deployment
3. **Monitoring**: Add error tracking for lock acquisition failures
4. **Client Integration**: Update frontend to:
   - Call this endpoint when opening event editor
   - Poll lock status periodically
   - Display lock conflict UI when 409 received
   - Auto-extend lock before expiration (e.g., at 80% of duration)

---

## Implementation Checklist

- [ ] Create validation schemas (Step 1)
- [ ] Create `src/lib/services/locking.service.ts` (Step 2)
- [ ] Create API route handler (Step 3)
- [ ] Implement `LockingService.acquireLock()` (Step 4)
- [ ] Add database indexes (Step 5)
- [ ] Write and run tests (Step 6)
- [ ] Update documentation (Step 7)
- [ ] Deploy and monitor (Step 8)
