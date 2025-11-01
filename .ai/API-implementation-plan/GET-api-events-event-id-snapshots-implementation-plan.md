# API Endpoint Implementation Plan: GET /api/events/{event_id}/snapshots

## 1. Endpoint Overview

This endpoint retrieves a paginated list of snapshots for a specific event. Snapshots represent version history of the seating plan, capturing the complete state of `plan_data` at specific points in time. Both automatic (autosave-triggered) and manual (user-created) snapshots are stored in the `snapshots` table.

The endpoint supports cursor-based pagination for efficient retrieval of large snapshot histories and allows filtering to show only manual snapshots when desired. This enables users to browse their event's version history, compare changes over time, and select snapshots for restoration.

**Key Capabilities:**

- List all snapshots for an event with pagination
- Filter to show only manual snapshots
- Support efficient cursor-based pagination
- Enforce ownership verification to prevent unauthorized access

## 2. Request Details

### HTTP Method

`GET`

### URL Structure

```
/api/events/{event_id}/snapshots
```

### Path Parameters

| Parameter  | Type | Required | Description                                                |
| ---------- | ---- | -------- | ---------------------------------------------------------- |
| `event_id` | UUID | Yes      | Unique identifier of the event whose snapshots to retrieve |

### Query Parameters

| Parameter     | Type    | Required | Default | Description                                     |
| ------------- | ------- | -------- | ------- | ----------------------------------------------- |
| `limit`       | integer | No       | 20      | Number of items per page (1-100)                |
| `cursor`      | string  | No       | -       | Opaque pagination cursor from previous response |
| `manual_only` | boolean | No       | false   | Filter to show only manual snapshots            |

### Request Headers

```
Authorization: Bearer <jwt_token>
```

### Request Body

None (GET request)

### Example Request

```http
GET /api/events/550e8400-e29b-41d4-a716-446655440000/snapshots?limit=10&manual_only=true HTTP/1.1
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 3. Used Types

### DTOs (Data Transfer Objects)

```typescript
// From src/types.ts

// Response item structure
type SnapshotDTO = Pick<
  DBSnapshotRow,
  "id" | "event_id" | "created_at" | "created_by" | "is_manual" | "label" | "previous_snapshot_id"
>;

// Paginated response wrapper
interface PaginatedDTO<SnapshotDTO> {
  items: SnapshotDTO[];
  next_cursor?: CursorToken | null;
}

// Error response
interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// Utility types
type UUID = string;
type CursorToken = string;
type ISO8601Timestamp = string;
```

### Zod Validation Schemas

```typescript
// Input validation schema (to be created in endpoint)
const listSnapshotsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  manual_only: z.coerce.boolean().default(false),
});

const eventIdParamSchema = z.object({
  event_id: z.string().uuid(),
});
```

### Database Types

```typescript
// From src/db/database.types.ts
type DBSnapshotRow = Tables<"snapshots">;
// Contains: id, event_id, created_by, label, is_manual, plan_data,
//           diff_summary, previous_snapshot_id, created_at
```

## 4. Response Details

### Success Response (200 OK)

```typescript
{
  "items": [
    {
      "id": "uuid",
      "event_id": "uuid",
      "label": "Before guest list import",
      "is_manual": true,
      "created_at": "2025-10-29T14:23:45.123Z",
      "created_by": "uuid",
      "previous_snapshot_id": "uuid"
    },
    // ... more items
  ],
  "next_cursor": "opaque_cursor_string" // null if last page
}
```

### Error Responses

#### 400 Bad Request - Invalid Input

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid request parameters",
    "details": {
      "event_id": "Must be a valid UUID",
      "limit": "Must be between 1 and 100"
    }
  }
}
```

#### 401 Unauthorized - Missing or Invalid Token

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

#### 403 Forbidden - User Doesn't Own Event

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to access this resource"
  }
}
```

#### 404 Not Found - Event Doesn't Exist

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found"
  }
}
```

#### 500 Internal Server Error

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

## 5. Data Flow

### Request Processing Flow

```
1. Client Request
   ↓
2. Astro Middleware (authentication check)
   ↓
3. API Route Handler (/src/pages/api/events/[event_id]/snapshots.ts)
   ↓
4. Input Validation (Zod schemas)
   ↓
5. Authorization Check (verify event ownership)
   ↓
6. Snapshot Service (/src/lib/services/snapshot.service.ts)
   ↓
7. Supabase Query (with filters and pagination)
   ↓
8. Transform DB Rows to DTOs
   ↓
9. Return Paginated Response
```

### Database Query Flow

```sql
-- Conceptual query structure (via Supabase client)
SELECT
  id,
  event_id,
  created_by,
  label,
  is_manual,
  created_at,
  previous_snapshot_id
FROM snapshots
WHERE event_id = $event_id
  AND (is_manual = true OR $manual_only = false)  -- conditional filter
  AND created_at < $cursor_timestamp              -- cursor pagination
ORDER BY created_at DESC
LIMIT $limit + 1;  -- fetch one extra to determine if more pages exist
```

### Cursor Pagination Logic

1. Decode cursor to extract `created_at` timestamp and `id`
2. Query snapshots created before cursor timestamp
3. If `created_at` matches cursor, use `id` as tiebreaker
4. Fetch `limit + 1` records
5. If result count > limit, create next_cursor from last item
6. Return only `limit` items in response

### Service Layer Responsibilities

The `SnapshotService` will encapsulate:

- Query construction with filters
- Cursor encoding/decoding (signed tokens to prevent tampering)
- Pagination logic
- DTO transformation
- Error handling for database operations

## 6. Security Considerations

### Authentication

- **Requirement**: Valid JWT token in Authorization header
- **Implementation**: Astro middleware validates token via Supabase auth
- **Failure**: Return 401 Unauthorized if token missing/invalid

### Authorization

- **Requirement**: User must own the event or have appropriate share link access
- **Implementation**:

  ```typescript
  // Verify ownership
  const { data: event } = await supabase.from("events").select("owner_id, deleted_at").eq("id", event_id).single();

  if (!event || event.deleted_at !== null) {
    return 404; // EVENT_NOT_FOUND
  }

  if (event.owner_id !== user.id) {
    return 403; // FORBIDDEN
  }
  ```

- **Failure**: Return 403 Forbidden if user doesn't own event

### Input Validation

- **Path Parameters**: Validate `event_id` as UUID format
- **Query Parameters**:
  - `limit`: Integer between 1-100 (prevent DoS via large page sizes)
  - `cursor`: Validate signature to prevent tampering
  - `manual_only`: Boolean coercion (accept "true", "1", "false", "0")
- **Implementation**: Use Zod schemas with strict validation
- **Failure**: Return 400 Bad Request with detailed validation errors

### Cursor Token Security

- **Threat**: Malicious users could forge cursors to skip pagination or access unauthorized data
- **Mitigation**:
  - Sign cursor tokens with HMAC using secret key
  - Include event_id in cursor payload and verify on decode
  - Validate cursor signature before parsing
  - Invalidate cursors older than 1 hour
- **Implementation**:

  ```typescript
  // Encode cursor
  const payload = { event_id, created_at, id };
  const cursor = signToken(payload, secret);

  // Decode cursor
  const payload = verifyToken(cursor, secret);
  if (payload.event_id !== event_id) {
    throw new Error("Invalid cursor");
  }
  ```

### Rate Limiting

- **Consideration**: Prevent abuse via excessive requests
- **Implementation**: Apply rate limiting middleware (e.g., 100 requests/minute per user)
- **Future Enhancement**: Use admin_flags.rate_limit_exports_daily for per-user limits

### Data Exposure

- **Sensitive Fields**: Avoid exposing internal implementation details
- **Excluded Fields**: Don't return `plan_data`, `diff_summary` in list view (heavy fields)
- **Error Messages**: Use generic messages; avoid revealing database schema or query details

### SQL Injection Prevention

- **Implementation**: Use Supabase parameterized queries exclusively
- **Never**: Concatenate user input into SQL strings

## 7. Error Handling

### Validation Errors (400 Bad Request)

| Scenario                | Error Code       | Message                    | Details                                  |
| ----------------------- | ---------------- | -------------------------- | ---------------------------------------- |
| Invalid event_id format | `INVALID_INPUT`  | Invalid request parameters | `{ event_id: "Must be a valid UUID" }`   |
| Invalid limit value     | `INVALID_INPUT`  | Invalid request parameters | `{ limit: "Must be between 1 and 100" }` |
| Malformed cursor        | `INVALID_CURSOR` | Invalid pagination cursor  | -                                        |

**Implementation**:

```typescript
try {
  const params = listSnapshotsQuerySchema.parse(query);
} catch (error) {
  if (error instanceof z.ZodError) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Invalid request parameters",
          details: error.flatten().fieldErrors,
        },
      }),
      { status: 400 }
    );
  }
}
```

### Authentication Errors (401 Unauthorized)

| Scenario      | Error Code     | Message                 |
| ------------- | -------------- | ----------------------- |
| Missing token | `UNAUTHORIZED` | Authentication required |
| Invalid token | `UNAUTHORIZED` | Authentication required |
| Expired token | `UNAUTHORIZED` | Authentication required |

**Implementation**: Handled by Astro middleware

### Authorization Errors (403 Forbidden)

| Scenario               | Error Code  | Message                                            |
| ---------------------- | ----------- | -------------------------------------------------- |
| User doesn't own event | `FORBIDDEN` | You do not have permission to access this resource |

**Implementation**:

```typescript
const { data: event } = await supabase.from("events").select("owner_id").eq("id", event_id).single();

if (event.owner_id !== user.id) {
  return new Response(
    JSON.stringify({
      error: {
        code: "FORBIDDEN",
        message: "You do not have permission to access this resource",
      },
    }),
    { status: 403 }
  );
}
```

### Not Found Errors (404 Not Found)

| Scenario            | Error Code        | Message         |
| ------------------- | ----------------- | --------------- |
| Event doesn't exist | `EVENT_NOT_FOUND` | Event not found |
| Event soft-deleted  | `EVENT_NOT_FOUND` | Event not found |

**Implementation**:

```typescript
const { data: event, error } = await supabase.from("events").select("owner_id, deleted_at").eq("id", event_id).single();

if (error || !event || event.deleted_at !== null) {
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

### Database Errors (500 Internal Server Error)

| Scenario                    | Error Code       | Message                      | Logging                    |
| --------------------------- | ---------------- | ---------------------------- | -------------------------- |
| Database connection failure | `INTERNAL_ERROR` | An unexpected error occurred | Log full error server-side |
| Query timeout               | `INTERNAL_ERROR` | An unexpected error occurred | Log full error server-side |
| Unexpected database error   | `INTERNAL_ERROR` | An unexpected error occurred | Log full error server-side |

**Implementation**:

```typescript
try {
  const snapshots = await snapshotService.listSnapshots(event_id, params);
  return new Response(JSON.stringify(snapshots), { status: 200 });
} catch (error) {
  console.error("Error listing snapshots:", error);
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

- **Client Errors (4xx)**: Log at INFO level with sanitized request context
- **Server Errors (5xx)**: Log at ERROR level with full stack trace
- **Use Structured Logging**: Include event_id, user_id, timestamp
- **Avoid PII in Logs**: Don't log sensitive user data

## 8. Performance Considerations

### Query Optimization

- **Index Requirements**:
  - Primary index on `snapshots(event_id, created_at DESC, id)` for efficient cursor pagination
  - Partial index on `snapshots(event_id, created_at DESC) WHERE is_manual = true` for manual_only filter
- **Query Pattern**: Use covering indexes to avoid table lookups
- **Avoid**: N+1 queries, full table scans

### Cursor-Based Pagination Benefits

- **Memory Efficiency**: Constant memory usage regardless of page depth
- **Consistency**: Stable results even with concurrent inserts
- **Performance**: O(1) page retrieval vs O(n) with offset-based pagination

### Response Size Management

- **Excluded Heavy Fields**: Don't include `plan_data` (JSONB), `diff_summary` in list view
- **Default Limit**: Set reasonable default (20) to prevent large payloads
- **Max Limit Cap**: Enforce 100-item maximum per page

### Caching Opportunities

- **Event Ownership Check**: Cache event ownership in request context (shared with other endpoints)
- **Snapshot Count**: Cache total snapshot count per event (if exposed in UI)
- **Consideration**: Balance cache freshness with database load

### Database Connection Pooling

- **Supabase Client**: Reuse connection pool across requests
- **Middleware**: Initialize Supabase client once in middleware, pass via context

### Monitoring Metrics

- **Track**:
  - Response time (p50, p95, p99)
  - Database query duration
  - Pagination depth (cursor age)
  - Error rate by type
- **Alerts**: Set thresholds for response time > 500ms, error rate > 1%

## 9. Implementation Steps

### Step 1: Create Snapshot Service

**File**: `src/lib/services/snapshot.service.ts`

**Tasks**:

- Create `SnapshotService` class or module with `listSnapshots` function
- Implement cursor encoding/decoding utilities with HMAC signing
- Implement pagination logic with `limit + 1` pattern
- Implement DTO transformation from DB rows to `SnapshotDTO`
- Add comprehensive error handling and logging

**Example Structure**:

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { SnapshotDTO, PaginatedDTO, UUID, CursorToken } from "../types";

interface ListSnapshotsParams {
  limit: number;
  cursor?: CursorToken;
  manualOnly: boolean;
}

export async function listSnapshots(
  supabase: SupabaseClient,
  eventId: UUID,
  params: ListSnapshotsParams
): Promise<PaginatedDTO<SnapshotDTO>> {
  // Implementation here
}
```

### Step 2: Implement Cursor Utilities

**File**: `src/lib/utils/cursor.ts` (or within snapshot service)

**Tasks**:

- Create `encodeCursor(payload)` function with HMAC-SHA256 signing
- Create `decodeCursor(cursor)` function with signature verification
- Use `import.meta.env.CURSOR_SECRET` for signing key
- Handle malformed cursors gracefully

**Example**:

```typescript
import { createHmac } from "crypto";

interface CursorPayload {
  event_id: string;
  created_at: string;
  id: string;
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  const data = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  return Buffer.from(`${data}.${signature}`).toString("base64url");
}

export function decodeCursor(cursor: string, secret: string): CursorPayload {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const [data, signature] = decoded.split(".");
  const expectedSignature = createHmac("sha256", secret).update(data).digest("hex");

  if (signature !== expectedSignature) {
    throw new Error("Invalid cursor signature");
  }

  return JSON.parse(data);
}
```

### Step 3: Create Validation Schemas

**File**: Inline in API route (or `src/lib/schemas/snapshot.schema.ts` if shared)

**Tasks**:

- Define `listSnapshotsQuerySchema` with Zod
- Define `eventIdParamSchema` with Zod
- Add appropriate constraints (min, max, coercion)

**Example**:

```typescript
import { z } from "zod";

export const listSnapshotsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
  manual_only: z.coerce.boolean().default(false),
});

export const eventIdParamSchema = z.object({
  event_id: z.string().uuid(),
});
```

### Step 4: Verify/Update Middleware

**File**: `src/middleware/index.ts`

**Tasks**:

- Ensure middleware extracts and validates JWT token
- Attach authenticated user to `context.locals.user`
- Attach Supabase client to `context.locals.supabase`
- Return 401 for unauthenticated requests to `/api/*` routes

**Example Check**:

```typescript
export async function onRequest(context, next) {
  const token = context.request.headers.get("Authorization")?.replace("Bearer ", "");

  if (!token && context.url.pathname.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }), {
      status: 401,
    });
  }

  // Validate token and attach user to context.locals
  // ...

  return next();
}
```

### Step 5: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/snapshots.ts`

**Tasks**:

- Export `prerender = false` for server-side rendering
- Implement `GET` handler function
- Extract and validate path parameters (`event_id`)
- Extract and validate query parameters (`limit`, `cursor`, `manual_only`)
- Verify event ownership
- Call `snapshotService.listSnapshots()`
- Return paginated response with proper status codes
- Handle all error scenarios with appropriate responses

**Example Structure**:

```typescript
import type { APIRoute } from "astro";
import { listSnapshots } from "../../../../lib/services/snapshot.service";
import { listSnapshotsQuerySchema, eventIdParamSchema } from "../../../../lib/schemas/snapshot.schema";

export const prerender = false;

export const GET: APIRoute = async ({ params, url, locals }) => {
  try {
    // 1. Validate path params
    const { event_id } = eventIdParamSchema.parse(params);

    // 2. Validate query params
    const query = Object.fromEntries(url.searchParams);
    const { limit, cursor, manual_only } = listSnapshotsQuerySchema.parse(query);

    // 3. Get authenticated user
    const { user, supabase } = locals;
    if (!user) {
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Authentication required" } }), {
        status: 401,
      });
    }

    // 4. Verify event ownership
    const { data: event, error: eventError } = await supabase
      .from("events")
      .select("owner_id, deleted_at")
      .eq("id", event_id)
      .single();

    if (eventError || !event || event.deleted_at !== null) {
      return new Response(JSON.stringify({ error: { code: "EVENT_NOT_FOUND", message: "Event not found" } }), {
        status: 404,
      });
    }

    if (event.owner_id !== user.id) {
      return new Response(
        JSON.stringify({ error: { code: "FORBIDDEN", message: "You do not have permission to access this resource" } }),
        { status: 403 }
      );
    }

    // 5. List snapshots
    const snapshots = await listSnapshots(supabase, event_id, { limit, cursor, manualOnly: manual_only });

    // 6. Return response
    return new Response(JSON.stringify(snapshots), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Handle validation errors
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid request parameters",
            details: error.flatten().fieldErrors,
          },
        }),
        { status: 400 }
      );
    }

    // Handle cursor errors
    if (error.message?.includes("cursor")) {
      return new Response(JSON.stringify({ error: { code: "INVALID_CURSOR", message: "Invalid pagination cursor" } }), {
        status: 400,
      });
    }

    // Handle unexpected errors
    console.error("Error listing snapshots:", error);
    return new Response(
      JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } }),
      { status: 500 }
    );
  }
};
```

### Step 6: Implement Snapshot Service Logic

**File**: `src/lib/services/snapshot.service.ts`

**Tasks**:

- Decode cursor if provided
- Construct Supabase query with filters:
  - `eq('event_id', eventId)`
  - `eq('is_manual', true)` if `manualOnly === true`
  - `lt('created_at', cursorTimestamp)` if cursor provided
  - `order('created_at', { ascending: false })`
  - `limit(limit + 1)`
- Execute query
- Transform results to DTOs (omit `plan_data`, `diff_summary`)
- Determine if more pages exist (result.length > limit)
- Encode next cursor if needed
- Return `PaginatedDTO<SnapshotDTO>`

**Example Implementation**:

```typescript
export async function listSnapshots(
  supabase: SupabaseClient,
  eventId: UUID,
  params: ListSnapshotsParams
): Promise<PaginatedDTO<SnapshotDTO>> {
  const { limit, cursor, manualOnly } = params;

  let query = supabase
    .from("snapshots")
    .select("id, event_id, created_by, label, is_manual, created_at, previous_snapshot_id")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false })
    .limit(limit + 1);

  // Apply manual_only filter
  if (manualOnly) {
    query = query.eq("is_manual", true);
  }

  // Apply cursor pagination
  if (cursor) {
    const cursorPayload = decodeCursor(cursor, import.meta.env.CURSOR_SECRET);

    // Verify cursor belongs to this event
    if (cursorPayload.event_id !== eventId) {
      throw new Error("Invalid cursor for this event");
    }

    query = query.lt("created_at", cursorPayload.created_at);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  // Determine if more pages exist
  const hasMore = data.length > limit;
  const items = hasMore ? data.slice(0, limit) : data;

  // Encode next cursor if more pages exist
  let next_cursor: CursorToken | null = null;
  if (hasMore) {
    const lastItem = items[items.length - 1];
    next_cursor = encodeCursor(
      {
        event_id: eventId,
        created_at: lastItem.created_at,
        id: lastItem.id,
      },
      import.meta.env.CURSOR_SECRET
    );
  }

  return {
    items,
    next_cursor,
  };
}
```

### Step 7: Add Environment Variables

**File**: `.env` (and update `src/env.d.ts` if needed)

**Tasks**:

- Add `CURSOR_SECRET` environment variable for cursor signing
- Generate secure random secret (min 32 characters)
- Document in `.env.example`

**Example**:

```env
CURSOR_SECRET=your-secure-random-secret-min-32-chars
```

### Step 8: Create Database Indexes

**File**: New migration in `supabase/migrations/`

**Tasks**:

- Create composite index on `(event_id, created_at DESC, id)` for cursor pagination
- Create partial index on `(event_id, created_at DESC) WHERE is_manual = true` for manual_only filter
- Test query performance with EXPLAIN ANALYZE

**Example Migration**:

```sql
-- Migration: Add indexes for snapshot list queries
-- Created: 2025-11-01

CREATE INDEX IF NOT EXISTS idx_snapshots_event_pagination
  ON snapshots (event_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS idx_snapshots_manual_pagination
  ON snapshots (event_id, created_at DESC)
  WHERE is_manual = true;
```

### Step 9: Write Unit Tests

**File**: `src/lib/services/snapshot.service.test.ts`

**Tasks**:

- Test cursor encoding/decoding
- Test pagination logic (first page, middle page, last page)
- Test manual_only filter
- Test invalid cursor handling
- Mock Supabase client responses

**Example Tests**:

```typescript
describe("listSnapshots", () => {
  it("should return first page with next_cursor", async () => {
    // Arrange: Mock 21 snapshots
    // Act: Call listSnapshots with limit=20
    // Assert: Returns 20 items + next_cursor
  });

  it("should return last page without next_cursor", async () => {
    // Arrange: Mock 15 snapshots
    // Act: Call listSnapshots with limit=20
    // Assert: Returns 15 items + next_cursor=null
  });

  it("should filter manual snapshots only", async () => {
    // Arrange: Mock mixed manual/auto snapshots
    // Act: Call listSnapshots with manualOnly=true
    // Assert: Returns only manual snapshots
  });

  it("should reject invalid cursor signature", async () => {
    // Arrange: Forge cursor with wrong signature
    // Act: Call listSnapshots with forged cursor
    // Assert: Throws error
  });
});
```

### Step 10: Write Integration Tests

**File**: `tests/api/snapshots.test.ts`

**Tasks**:

- Test full request/response cycle
- Test authentication (401 scenarios)
- Test authorization (403 scenarios)
- Test not found (404 scenarios)
- Test validation errors (400 scenarios)
- Test pagination flow (multiple pages)
- Use test database with seeded data

### Step 11: Update API Documentation

**Files**: API documentation (Swagger/OpenAPI if applicable)

**Tasks**:

- Document endpoint specification
- Add request/response examples
- Document query parameters
- Document error responses
- Add pagination cursor usage guide

### Step 12: Code Review Checklist

- [ ] Input validation covers all edge cases
- [ ] Authorization check prevents unauthorized access
- [ ] Cursor signature prevents tampering
- [ ] Database queries use proper indexes
- [ ] Error handling covers all scenarios
- [ ] Error messages don't leak sensitive information
- [ ] Response excludes heavy fields (plan_data)
- [ ] Pagination logic handles edge cases (empty list, single item)
- [ ] Code follows project style guide
- [ ] Tests achieve >90% coverage
- [ ] No hardcoded secrets or credentials
- [ ] Logging doesn't include PII
- [ ] Performance meets SLA targets (<500ms p95)

### Step 13: Deployment Preparation

- [ ] Environment variables configured in production
- [ ] Database migrations applied
- [ ] Indexes created and verified
- [ ] Rate limiting configured
- [ ] Monitoring/alerting set up
- [ ] Load testing completed
- [ ] Rollback plan documented
