# API Endpoint Implementation Plan: POST /api/events/{event_id}/lock/release

## 1. Endpoint Overview

This endpoint releases an editor lock on a specific event plan if the authenticated user currently holds that lock. The soft single-editor locking mechanism prevents concurrent edits by multiple users. When a user finishes editing, they should release the lock to allow others to acquire it.

**Purpose**: Release an active editor lock on an event plan  
**Authentication**: Required (Supabase Auth)  
**Authorization**: User must either own the event or currently hold the lock  
**Idempotency**: Idempotent - multiple release calls have the same effect as one

## 2. Request Details

- **HTTP Method**: POST
- **URL Structure**: `/api/events/{event_id}/lock/release`
- **Content-Type**: application/json

### Path Parameters

| Parameter | Type | Required | Description                    | Validation           |
| --------- | ---- | -------- | ------------------------------ | -------------------- |
| event_id  | UUID | Yes      | Unique identifier of the event | Valid UUID v4 format |

### Request Body

Empty request body. The endpoint uses `ReleaseLockCommand` type which is defined as `Record<string, never>`.

```typescript
// Expected request body
{
}
```

### Headers

| Header        | Required | Description                        |
| ------------- | -------- | ---------------------------------- |
| Authorization | Yes      | Supabase auth token (Bearer token) |
| Content-Type  | Yes      | application/json                   |

## 3. Used Types

### Command Models

```typescript
// From types.ts
export type ReleaseLockCommand = Record<string, never>; // Path-driven marker
```

### Response DTOs

```typescript
// Success response (not defined in types.ts, inline)
interface LockReleaseSuccessDTO {
  released: true;
}

// Error response
export interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Supporting Types

```typescript
export type UUID = string;
export interface LockStatusDTO {
  held_by: UUID | null;
  expires_at: ISO8601Timestamp | null;
}
```

### Database Types

```typescript
// Relevant fields from events table
interface EventLockFields {
  id: UUID;
  owner_id: UUID;
  lock_held_by: UUID | null;
  lock_expires_at: timestamptz | null;
  deleted_at: timestamptz | null;
}
```

## 4. Response Details

### Success Response (200 OK)

```json
{
  "released": true
}
```

**Status Code**: 200 OK  
**Content-Type**: application/json

### Error Responses

#### 400 Bad Request - Invalid event_id format

```json
{
  "error": {
    "code": "INVALID_EVENT_ID",
    "message": "Event ID must be a valid UUID",
    "details": {
      "provided": "invalid-id-123"
    }
  }
}
```

#### 401 Unauthorized - Missing or invalid authentication

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

#### 404 Not Found - Event doesn't exist or is deleted

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found or has been deleted"
  }
}
```

#### 409 Conflict - Lock not held by caller

```json
{
  "error": {
    "code": "NOT_LOCK_OWNER",
    "message": "You do not currently hold the lock for this event",
    "details": {
      "held_by": "user-uuid-or-null",
      "expires_at": "2025-11-01T12:34:56.789Z"
    }
  }
}
```

#### 500 Internal Server Error - Database or unexpected errors

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred while releasing the lock"
  }
}
```

## 5. Data Flow

### High-Level Flow

1. **Request Reception**: Astro API endpoint receives POST request
2. **Authentication**: Middleware validates Supabase auth token and extracts user_id
3. **Input Validation**: Validate event_id UUID format using Zod
4. **Service Delegation**: Call LockService.releaseLock(event_id, user_id)
5. **Database Operations**:
   - Query event to verify existence and lock status
   - Verify caller holds the lock
   - Update event to clear lock fields (lock_held_by = null, lock_expires_at = null)
   - Insert audit log entry
6. **Response**: Return success response or appropriate error

### Detailed Service Flow

```
┌─────────────────┐
│  API Endpoint   │
│  (Astro Route)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Middleware     │
│  Auth Check     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Zod Validation │
│  event_id UUID  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  LockService    │
│  .releaseLock() │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Database Transaction               │
│  1. SELECT event (for update)       │
│  2. Verify lock_held_by = user_id   │
│  3. UPDATE event SET lock fields    │
│  4. INSERT audit_log entry          │
└─────────────────────────────────────┘
```

### Database Interactions

#### 1. Fetch Event with Lock Status

```sql
SELECT id, owner_id, lock_held_by, lock_expires_at, deleted_at
FROM events
WHERE id = $1
FOR UPDATE;
```

Purpose: Retrieve event and acquire row lock for transaction safety

#### 2. Validate Lock Ownership

Business logic check:

- If event.deleted_at IS NOT NULL → 404 NOT FOUND
- If event.lock_held_by IS NULL → 409 NOT_LOCK_OWNER (no lock held)
- If event.lock_held_by != user_id → 409 NOT_LOCK_OWNER (held by someone else)
- If event.lock_expires_at < NOW() → Lock already expired (treat as no lock)

#### 3. Release Lock

```sql
UPDATE events
SET
  lock_held_by = NULL,
  lock_expires_at = NULL,
  updated_at = NOW()
WHERE id = $1;
```

#### 4. Audit Log

```sql
INSERT INTO audit_log (event_id, user_id, action_type, details, created_at)
VALUES (
  $1,
  $2,
  'lock_released',
  jsonb_build_object('released_at', NOW()),
  NOW()
);
```

### Transaction Boundaries

All database operations should execute within a single transaction to ensure atomicity:

- Use Supabase transaction support or implement manual transaction control
- Rollback on any error during the process
- FOR UPDATE lock prevents race conditions

## 6. Security Considerations

### Authentication

- **Requirement**: Valid Supabase auth token in Authorization header
- **Implementation**: Use `context.locals.supabase` authenticated client
- **Validation**: Middleware should verify token and extract user_id before endpoint logic

### Authorization

- **Lock Ownership Check**: Verify `lock_held_by === user_id`
- **Event Access**: User should have access to the event (owner or lock holder)
- **Soft Delete Respect**: Reject requests for soft-deleted events

### Input Validation

```typescript
import { z } from "zod";

const ReleaseLockPathSchema = z.object({
  event_id: z.string().uuid({ message: "Event ID must be a valid UUID" }),
});
```

### Security Threats & Mitigations

| Threat                                                               | Mitigation                                                                    |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **IDOR Attack**: User tries to release lock on events they don't own | Verify lock_held_by matches authenticated user_id                             |
| **Race Conditions**: Concurrent release attempts                     | Use database transaction with FOR UPDATE lock                                 |
| **Lock Hijacking**: Attempt to release expired locks                 | Check lock expiration; expired locks are already released                     |
| **Timing Attacks**: Infer lock state from response times             | Return consistent response times; avoid detailed error messages in production |
| **Token Replay**: Reuse of old auth tokens                           | Supabase handles token expiration; verify token freshness                     |

### Data Privacy (GDPR/CCPA)

- **PII Exposure**: None - no guest data exposed in this endpoint
- **Audit Trail**: Lock release action logged with user_id and timestamp

## 7. Error Handling

### Error Scenarios & Responses

| Scenario                | Detection                     | Status Code | Error Code       | Response Details                       |
| ----------------------- | ----------------------------- | ----------- | ---------------- | -------------------------------------- |
| Invalid UUID format     | Zod validation fails          | 400         | INVALID_EVENT_ID | Include provided value in details      |
| Missing auth token      | Middleware check              | 401         | UNAUTHORIZED     | Generic message                        |
| Invalid/expired token   | Supabase auth validation      | 401         | UNAUTHORIZED     | Generic message                        |
| Event not found         | Database query returns null   | 404         | EVENT_NOT_FOUND  | Generic message                        |
| Event soft-deleted      | deleted_at IS NOT NULL        | 404         | EVENT_NOT_FOUND  | Same as not found                      |
| Lock not held           | lock_held_by IS NULL          | 409         | NOT_LOCK_OWNER   | Include current lock status            |
| Lock held by other user | lock_held_by != user_id       | 409         | NOT_LOCK_OWNER   | Include lock holder info               |
| Lock expired            | lock_expires_at < NOW()       | 409         | NOT_LOCK_OWNER   | Treat as no lock held                  |
| Database error          | Exception during query/update | 500         | INTERNAL_ERROR   | Log full error; return generic message |
| Transaction rollback    | Any step fails                | 500         | INTERNAL_ERROR   | Log error; return generic message      |

### Error Response Format

All errors follow the `ApiErrorDTO` structure:

```typescript
interface ApiErrorDTO {
  error: {
    code: string; // Machine-readable error code
    message: string; // Human-readable message
    details?: Record<string, unknown>; // Optional context
  };
}
```

### Logging Strategy

**Development**:

- Log full error stack traces
- Include detailed validation failures
- Log database query errors with parameters

**Production**:

- Log errors to centralized logging service
- Include request ID for traceability
- Sanitize PII from logs
- Return generic error messages to clients

```typescript
// Example error logging
console.error("[LockService.releaseLock] Error:", {
  event_id,
  user_id,
  error: error.message,
  stack: error.stack,
  timestamp: new Date().toISOString(),
});
```

## 8. Performance Considerations

### Database Optimization

- **Index Usage**:
  - `events.id` (primary key) - automatic index
  - `events.lock_held_by` - consider index for lock queries
- **Query Performance**: Single SELECT with FOR UPDATE is fast
- **Transaction Duration**: Keep transaction short; no external API calls inside transaction

### Caching Strategy

- **Not Applicable**: Lock state must always be fresh from database
- **No CDN Caching**: This is a mutating operation (POST)

### Potential Bottlenecks

1. **Database Connection Pool**: Under high load, connection pool exhaustion
   - **Mitigation**: Configure appropriate pool size; use connection pooling
2. **Row-Level Locking**: FOR UPDATE may cause waiting if concurrent access
   - **Mitigation**: Keep transaction duration minimal; lock timeout configuration
3. **Audit Log Inserts**: High volume could slow down response
   - **Mitigation**: Consider async audit logging or batch inserts (post-MVP)

### Scalability Considerations

- **Horizontal Scaling**: Stateless endpoint scales well behind load balancer
- **Database Scaling**: Supabase handles PostgreSQL scaling; read replicas for analytics
- **Lock Expiry Cleanup**: Implement background job to clean expired locks (optional)

### Response Time Targets

- **P50**: < 50ms
- **P95**: < 150ms
- **P99**: < 300ms

## 9. Implementation Steps

### Step 1: Create Lock Service

**File**: `src/lib/services/lock.service.ts`

**Responsibilities**:

- Validate lock ownership
- Release lock (clear lock_held_by and lock_expires_at)
- Handle lock expiration logic
- Audit logging

**Interface**:

```typescript
export class LockService {
  constructor(private supabase: SupabaseClient);

  async releaseLock(eventId: UUID, userId: UUID): Promise<void>;
}
```

**Implementation Details**:

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UUID } from "../types";

export class LockService {
  constructor(private supabase: SupabaseClient) {}

  async releaseLock(eventId: UUID, userId: UUID): Promise<void> {
    // 1. Start transaction (if Supabase supports it, or use multiple queries)

    // 2. Fetch event with FOR UPDATE lock
    const { data: event, error: fetchError } = await this.supabase
      .from("events")
      .select("id, owner_id, lock_held_by, lock_expires_at, deleted_at")
      .eq("id", eventId)
      .single();

    // 3. Handle fetch errors
    if (fetchError || !event) {
      throw new Error("EVENT_NOT_FOUND");
    }

    // 4. Check soft delete
    if (event.deleted_at) {
      throw new Error("EVENT_NOT_FOUND");
    }

    // 5. Validate lock ownership
    if (!event.lock_held_by) {
      throw new Error("NOT_LOCK_OWNER"); // No lock held
    }

    if (event.lock_held_by !== userId) {
      throw new Error("NOT_LOCK_OWNER"); // Held by someone else
    }

    // 6. Check expiration (optional - expired locks are effectively released)
    if (event.lock_expires_at && new Date(event.lock_expires_at) < new Date()) {
      // Lock already expired, but we can still release it
    }

    // 7. Release lock
    const { error: updateError } = await this.supabase
      .from("events")
      .update({
        lock_held_by: null,
        lock_expires_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId);

    if (updateError) {
      throw new Error("INTERNAL_ERROR");
    }

    // 8. Audit log
    const { error: auditError } = await this.supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "lock_released",
      details: { released_at: new Date().toISOString() },
      created_at: new Date().toISOString(),
    });

    if (auditError) {
      console.error("[LockService] Audit log error:", auditError);
      // Don't throw - audit failure shouldn't block release
    }
  }
}
```

### Step 2: Create Zod Validation Schema

**File**: `src/lib/validation/lock.schemas.ts` (or inline in route)

```typescript
import { z } from "zod";

export const ReleaseLockPathSchema = z.object({
  event_id: z.string().uuid({ message: "Event ID must be a valid UUID" }),
});

export const ReleaseLockBodySchema = z.object({}); // Empty object
```

### Step 3: Create API Endpoint

**File**: `src/pages/api/events/[event_id]/lock/release.ts`

**Structure**:

```typescript
import type { APIRoute } from "astro";
import { ReleaseLockPathSchema, ReleaseLockBodySchema } from "../../../../lib/validation/lock.schemas";
import { LockService } from "../../../../lib/services/lock.service";
import type { ApiErrorDTO } from "../../../../types";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    // 1. Get authenticated Supabase client
    const supabase = context.locals.supabase;

    // 2. Check authentication
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

    // 3. Validate path parameters
    const pathValidation = ReleaseLockPathSchema.safeParse({
      event_id: context.params.event_id,
    });

    if (!pathValidation.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_EVENT_ID",
            message: "Event ID must be a valid UUID",
            details: { provided: context.params.event_id },
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { event_id } = pathValidation.data;

    // 4. Call service
    const lockService = new LockService(supabase);
    await lockService.releaseLock(event_id, user.id);

    // 5. Return success response
    return new Response(JSON.stringify({ released: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // 6. Error handling
    if (error instanceof Error) {
      // Map service errors to HTTP responses
      switch (error.message) {
        case "EVENT_NOT_FOUND":
          return new Response(
            JSON.stringify({
              error: {
                code: "EVENT_NOT_FOUND",
                message: "Event not found or has been deleted",
              },
            } as ApiErrorDTO),
            { status: 404, headers: { "Content-Type": "application/json" } }
          );

        case "NOT_LOCK_OWNER":
          return new Response(
            JSON.stringify({
              error: {
                code: "NOT_LOCK_OWNER",
                message: "You do not currently hold the lock for this event",
              },
            } as ApiErrorDTO),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );

        default:
          console.error("[ReleaseLock] Unexpected error:", error);
          return new Response(
            JSON.stringify({
              error: {
                code: "INTERNAL_ERROR",
                message: "An unexpected error occurred while releasing the lock",
              },
            } as ApiErrorDTO),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
      }
    }

    // Fallback for non-Error objects
    console.error("[ReleaseLock] Unknown error:", error);
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

### Step 4: Update Middleware (if needed)

**File**: `src/middleware/index.ts`

Ensure middleware:

- Initializes Supabase client with request cookies
- Attaches authenticated client to `context.locals.supabase`
- Handles auth token validation

(Middleware may already be set up; verify it supports authenticated routes)

### Step 5: Add Unit Tests

**File**: `src/lib/services/__tests__/lock.service.test.ts`

**Test Cases**:

1. Successfully release lock when user holds it
2. Throw EVENT_NOT_FOUND when event doesn't exist
3. Throw EVENT_NOT_FOUND when event is soft-deleted
4. Throw NOT_LOCK_OWNER when no lock is held
5. Throw NOT_LOCK_OWNER when lock held by another user
6. Handle expired locks correctly
7. Audit log created on successful release
8. Gracefully handle audit log insertion failure

### Step 6: Add Integration Tests

**File**: `src/pages/api/events/[event_id]/lock/__tests__/release.test.ts`

**Test Scenarios**:

1. POST with valid auth and lock ownership → 200 with `{ released: true }`
2. POST without auth → 401 UNAUTHORIZED
3. POST with invalid event_id format → 400 INVALID_EVENT_ID
4. POST for non-existent event → 404 EVENT_NOT_FOUND
5. POST when not holding lock → 409 NOT_LOCK_OWNER
6. POST when lock held by another user → 409 NOT_LOCK_OWNER
7. POST with expired lock → 409 NOT_LOCK_OWNER (or success, depending on business rules)

### Step 7: Update API Documentation

**File**: `.ai/api-plan.md` (or equivalent)

Add detailed documentation for:

- Request/response examples
- Error codes and meanings
- Usage notes (e.g., idempotency, lock expiration behavior)

### Step 8: Manual Testing Checklist

- [ ] Test with valid lock release (happy path)
- [ ] Test with no authentication
- [ ] Test with invalid UUID format
- [ ] Test with non-existent event
- [ ] Test with soft-deleted event
- [ ] Test without holding lock
- [ ] Test with lock held by another user
- [ ] Test with expired lock
- [ ] Verify audit log entries created
- [ ] Test concurrent release attempts (race condition)
- [ ] Verify response times meet performance targets

### Step 9: Code Review Checklist

- [ ] Input validation comprehensive (Zod schemas)
- [ ] Error handling covers all scenarios
- [ ] Security considerations addressed (auth, authorization, IDOR)
- [ ] Service layer properly separated from route handler
- [ ] Transaction handling correct (if applicable)
- [ ] Audit logging implemented
- [ ] Type safety maintained throughout
- [ ] Error responses follow ApiErrorDTO structure
- [ ] Status codes correct (200, 400, 401, 404, 409, 500)
- [ ] Code follows project coding guidelines
- [ ] No PII leaked in error messages
- [ ] Logging appropriate (not too verbose, not too sparse)

### Step 10: Deployment Preparation

- [ ] Environment variables configured (if any new ones needed)
- [ ] Database migrations applied (if schema changes required)
- [ ] Monitoring/alerting configured for error rates
- [ ] Performance metrics baseline established
- [ ] Documentation updated in README or wiki
- [ ] Changelog entry added
- [ ] Feature flag enabled (if using feature flags)

---

## Summary

This endpoint is straightforward but critical for the collaborative editing experience. The implementation prioritizes:

1. **Security**: Strict authentication and authorization checks
2. **Data Integrity**: Transaction safety to prevent race conditions
3. **Observability**: Comprehensive audit logging
4. **Error Clarity**: Detailed, machine-readable error codes
5. **Performance**: Minimal database queries with proper indexing

The lock release mechanism complements the lock acquisition endpoint and ensures users can gracefully exit editing sessions, allowing others to take over.
