# API Endpoint Implementation Plan: GET /api/events/{event_id}/snapshots/{snapshot_id}

## 1. Endpoint Overview

This endpoint retrieves a specific snapshot by ID for a given event. Snapshots represent point-in-time versions of the event's seating plan and are stored with complete `plan_data` JSONB. The endpoint supports conditional inclusion of the `plan_data` field via query parameter to optimize performance when only metadata is needed.

**Purpose**: Provide read access to historical versions of event plans for review, comparison, or restoration workflows.

**Key Features**:

- Returns full snapshot metadata (id, timestamps, creator, label, etc.)
- Optionally includes complete `plan_data` with tables, guests, and settings
- Enforces ownership validation to prevent unauthorized access
- Supports version history navigation via `previous_snapshot_id` reference

## 2. Request Details

- **HTTP Method**: `GET`
- **URL Structure**: `/api/events/{event_id}/snapshots/{snapshot_id}`
- **Parameters**:
  - **Required (Path)**:
    - `event_id` (string, UUID) - The parent event identifier
    - `snapshot_id` (string, UUID) - The specific snapshot identifier
  - **Optional (Query)**:
    - `plan` (boolean, default: `true`) - Include `plan_data` in response
      - Accepted values: `true`, `false`, `1`, `0`, `"true"`, `"false"`
      - When `false`, returns `SnapshotDTO` without `plan_data`
      - When `true`, returns `SnapshotDetailDTO` with full `plan_data`
- **Request Body**: None
- **Headers**:
  - `Authorization: Bearer <supabase_jwt>` (required for authentication)

**Example Requests**:

```http
GET /api/events/123e4567-e89b-12d3-a456-426614174000/snapshots/987fcdeb-51a2-43f7-b123-9876543210ab
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

GET /api/events/123e4567-e89b-12d3-a456-426614174000/snapshots/987fcdeb-51a2-43f7-b123-9876543210ab?plan=false
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 3. Used Types

### Response DTOs

**SnapshotDTO** (from `src/types.ts`):

```typescript
type SnapshotDTO = Pick<
  DBSnapshotRow,
  "id" | "event_id" | "created_at" | "created_by" | "is_manual" | "label" | "previous_snapshot_id"
>;
```

**SnapshotDetailDTO** (from `src/types.ts`):

```typescript
interface SnapshotDetailDTO extends SnapshotDTO {
  plan_data: PlanDataDTO;
}
```

**PlanDataDTO** (nested structure):

```typescript
interface PlanDataDTO {
  tables: TableDTO[];
  guests: GuestDTO[];
  settings: PlanSettingsDTO;
}
```

### Validation Schemas

**Zod Schema for Request Validation**:

```typescript
const paramsSchema = z.object({
  event_id: z.string().uuid("Invalid event ID format"),
  snapshot_id: z.string().uuid("Invalid snapshot ID format"),
});

const querySchema = z.object({
  plan: z.coerce.boolean().optional().default(true),
});
```

## 4. Response Details

### Success Response (200 OK)

**When `plan=true` (default)**:

```json
{
  "id": "987fcdeb-51a2-43f7-b123-9876543210ab",
  "event_id": "123e4567-e89b-12d3-a456-426614174000",
  "created_at": "2025-10-29T14:30:00.000Z",
  "created_by": "user-uuid-here",
  "is_manual": true,
  "label": "Before moving family table",
  "previous_snapshot_id": "abc12345-...",
  "plan_data": {
    "tables": [
      {
        "id": "t1",
        "shape": "round",
        "capacity": 10,
        "label": "Table 1",
        "start_index": 1,
        "head_seat": 1,
        "seats": [
          { "seat_no": 1, "guest_id": "g1" },
          { "seat_no": 2, "guest_id": "g2" }
        ]
      }
    ],
    "guests": [
      {
        "id": "g1",
        "name": "Alice Smith",
        "note": "Vegan",
        "tag": "Family",
        "rsvp": "Yes"
      }
    ],
    "settings": {
      "color_palette": "default"
    }
  }
}
```

**When `plan=false`**:

```json
{
  "id": "987fcdeb-51a2-43f7-b123-9876543210ab",
  "event_id": "123e4567-e89b-12d3-a456-426614174000",
  "created_at": "2025-10-29T14:30:00.000Z",
  "created_by": "user-uuid-here",
  "is_manual": true,
  "label": "Before moving family table",
  "previous_snapshot_id": "abc12345-..."
}
```

### Error Responses

| Status | Error Code            | Condition                                | Response Body                                                                                     |
| ------ | --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 400    | `INVALID_EVENT_ID`    | Malformed event_id UUID                  | `{ "error": { "code": "INVALID_EVENT_ID", "message": "Invalid event ID format" } }`               |
| 400    | `INVALID_SNAPSHOT_ID` | Malformed snapshot_id UUID               | `{ "error": { "code": "INVALID_SNAPSHOT_ID", "message": "Invalid snapshot ID format" } }`         |
| 400    | `INVALID_QUERY_PARAM` | Invalid plan parameter value             | `{ "error": { "code": "INVALID_QUERY_PARAM", "message": "Invalid value for 'plan' parameter" } }` |
| 401    | `UNAUTHORIZED`        | Missing or invalid auth token            | `{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }`                   |
| 403    | `FORBIDDEN`           | User doesn't own event                   | `{ "error": { "code": "FORBIDDEN", "message": "Access denied to this snapshot" } }`               |
| 404    | `SNAPSHOT_NOT_FOUND`  | Snapshot doesn't exist or event mismatch | `{ "error": { "code": "SNAPSHOT_NOT_FOUND", "message": "Snapshot not found" } }`                  |
| 404    | `EVENT_NOT_FOUND`     | Event doesn't exist                      | `{ "error": { "code": "EVENT_NOT_FOUND", "message": "Event not found" } }`                        |
| 500    | `INTERNAL_ERROR`      | Database or server error                 | `{ "error": { "code": "INTERNAL_ERROR", "message": "Internal server error" } }`                   |

## 5. Data Flow

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ GET /api/events/{event_id}/snapshots/{snapshot_id}?plan=true
       │ Authorization: Bearer <token>
       ▼
┌─────────────────────────────────────────────────────────┐
│  Astro API Route (src/pages/api/events/[event_id]/     │
│                   snapshots/[snapshot_id].ts)           │
│  ─────────────────────────────────────────────────────  │
│  1. Extract path params (event_id, snapshot_id)         │
│  2. Extract query param (plan)                          │
│  3. Validate params with Zod schemas                    │
│  4. Get Supabase client from context.locals             │
│  5. Authenticate user from JWT                          │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  SnapshotService (src/lib/services/snapshot.service.ts) │
│  ─────────────────────────────────────────────────────  │
│  getSnapshotById(supabase, eventId, snapshotId,         │
│                  includePlan)                           │
│  ─────────────────────────────────────────────────────  │
│  1. Build query with conditional plan_data selection    │
│  2. Query snapshots table with filters:                 │
│     - WHERE id = snapshot_id                            │
│     - AND event_id = event_id                           │
│  3. RLS enforces ownership (user_id = owner_id)         │
│  4. Return single row or null                           │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  Supabase PostgreSQL with RLS                           │
│  ─────────────────────────────────────────────────────  │
│  1. Apply Row Level Security policies                   │
│  2. Verify user owns parent event                       │
│  3. Execute query with conditional projection           │
│  4. Return snapshot row or empty result                 │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────┐
│  Response Mapping                                       │
│  ─────────────────────────────────────────────────────  │
│  1. If no row found → 404 SNAPSHOT_NOT_FOUND            │
│  2. Map DB row to SnapshotDTO or SnapshotDetailDTO      │
│  3. Return JSON with 200 status                         │
└──────┬──────────────────────────────────────────────────┘
       │
       ▼
┌─────────────┐
│   Client    │
└─────────────┘
```

**Key Flow Notes**:

- **Ownership Verification**: Performed via Supabase RLS policies on the snapshots table that join to events table
- **Conditional Projection**: When `plan=false`, the query uses `.select('id, event_id, created_at, ...')` excluding `plan_data`
- **Cross-Event Protection**: Query filters by BOTH `snapshot_id` AND `event_id` to prevent accessing snapshots from wrong events
- **Performance Optimization**: Excluding `plan_data` can reduce payload size from potentially hundreds of KB to just a few KB

## 6. Security Considerations

### Authentication

- **Requirement**: Valid Supabase JWT token in Authorization header
- **Validation**: Performed by Supabase client automatically
- **Failure Response**: 401 UNAUTHORIZED if token missing, expired, or invalid

### Authorization

**Primary Check**: User must own the parent event

- **Enforcement**: Row Level Security (RLS) policies on `snapshots` table
- **Policy Logic**:
  ```sql
  -- Example RLS policy for snapshots SELECT
  CREATE POLICY "Users can view snapshots of their events"
  ON snapshots FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM events
      WHERE events.id = snapshots.event_id
      AND events.owner_id = auth.uid()
      AND events.deleted_at IS NULL
    )
  );
  ```

**Secondary Validation**: Snapshot belongs to specified event

- **Implementation**: Query filters by both `snapshot_id` AND `event_id`
- **Security Benefit**: Prevents accessing valid snapshot via wrong event_id path (IDOR protection)

### Data Sensitivity

**PII Exposure in plan_data**:

- Guest names, dietary notes, RSVP status, tags stored in `plan_data.guests[]`
- **Mitigation**: Already protected by ownership checks
- **Future Consideration**: If share links need snapshot access, implement PII filtering similar to `PublicPlanDataDTO`

### Input Validation

- **UUID Format**: Strict validation prevents injection attacks
- **Query Parameter Sanitization**: Coercion to boolean prevents unexpected values
- **No User Input in DB Queries**: All queries use parameterized placeholders

### Rate Limiting

- **Consideration**: Snapshots are read-heavy and potentially large payloads
- **Recommendation**: Apply per-user rate limit (e.g., 100 requests/minute) at API gateway or middleware level
- **Implementation**: Future enhancement using Supabase Edge Functions or Astro middleware

## 7. Error Handling

### Validation Errors (400 Bad Request)

**Invalid event_id UUID**:

```typescript
if (!paramsValidation.success) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_EVENT_ID",
        message: "Invalid event ID format",
        details: paramsValidation.error.flatten(),
      },
    }),
    { status: 400 }
  );
}
```

**Invalid snapshot_id UUID**:

```typescript
if (!paramsValidation.success) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_SNAPSHOT_ID",
        message: "Invalid snapshot ID format",
        details: paramsValidation.error.flatten(),
      },
    }),
    { status: 400 }
  );
}
```

**Invalid plan query parameter**:

```typescript
if (!queryValidation.success) {
  return new Response(
    JSON.stringify({
      error: {
        code: "INVALID_QUERY_PARAM",
        message: "Invalid value for 'plan' parameter",
        details: queryValidation.error.flatten(),
      },
    }),
    { status: 400 }
  );
}
```

### Authentication Errors (401 Unauthorized)

**Missing or invalid token**:

```typescript
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
    { status: 401 }
  );
}
```

### Authorization Errors (403 Forbidden)

**User doesn't own event** (caught by RLS, returns empty result):

- Treated as 404 for security (don't reveal existence)
- Alternatively, can explicitly check ownership and return 403

### Not Found Errors (404)

**Snapshot doesn't exist or belongs to different event**:

```typescript
const snapshot = await snapshotService.getSnapshotById(supabase, eventId, snapshotId, includePlan);

if (!snapshot) {
  return new Response(
    JSON.stringify({
      error: {
        code: "SNAPSHOT_NOT_FOUND",
        message: "Snapshot not found",
      },
    }),
    { status: 404 }
  );
}
```

**Event doesn't exist** (optional pre-check):

```typescript
// Optional: verify event exists before querying snapshot
const { data: event } = await supabase.from("events").select("id").eq("id", eventId).single();

if (!event) {
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

**Database errors**:

```typescript
try {
  const snapshot = await snapshotService.getSnapshotById(...);
  // ... process snapshot
} catch (error) {
  console.error('Error retrieving snapshot:', error);
  return new Response(JSON.stringify({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error"
    }
  }), { status: 500 });
}
```

### Error Logging Strategy

**Application Logs**:

- Log all 500-level errors with full stack traces
- Log 400-level errors at debug level
- Include request context (user_id, event_id, snapshot_id) for traceability

**No Audit Log Entries**:

- This is a read-only operation without data mutation
- Don't create audit_log entries to avoid excessive logging
- Audit logs reserved for actions that modify data

## 8. Performance Considerations

### Query Optimization

**Conditional Projection**:

- When `plan=false`, exclude `plan_data` column from SELECT
- **Benefit**: Reduces payload from ~100-500 KB to ~1 KB
- **Use Case**: List/navigation views that only need metadata

**Indexed Lookups**:

- Primary key index on `snapshots.id` (automatic)
- Foreign key index on `snapshots.event_id` (should exist)
- **Expected Query Time**: <10ms for indexed lookup

**RLS Policy Performance**:

- Ensure `events.owner_id` is indexed
- RLS policy joins snapshots → events → auth.users
- **Expected Overhead**: ~5-10ms for policy evaluation

### Payload Size

**With plan_data** (default):

- **Typical Size**: 50-500 KB depending on number of guests/tables
- **Large Events**: Can exceed 1 MB for 300+ guests with notes
- **Recommendation**: Use gzip compression (Astro default)

**Without plan_data**:

- **Size**: ~500 bytes - 2 KB (metadata only)
- **Use Case**: Snapshot list/history views

### Caching Strategy

**Client-Side Caching**:

- ETags: Generate from `updated_at` timestamp
- Cache-Control: `private, max-age=300` (5 minutes)
- **Justification**: Snapshots are immutable once created

**CDN Caching**:

- Not recommended due to authorization requirements
- Each user sees different snapshots based on ownership

### Database Connection Pooling

- Leverage Supabase connection pooling (automatic)
- No special configuration needed for read operations
- **Concurrent Request Capacity**: Limited by Supabase plan tier

## 9. Implementation Steps

### Step 1: Create Snapshot Service

**File**: `src/lib/services/snapshot.service.ts`

```typescript
import type { SupabaseClient } from "@/db/supabase.client";
import type { SnapshotDTO, SnapshotDetailDTO } from "@/types";

export class SnapshotService {
  /**
   * Retrieves a snapshot by ID with optional plan_data inclusion
   * @param supabase - Authenticated Supabase client
   * @param eventId - Parent event UUID
   * @param snapshotId - Snapshot UUID
   * @param includePlan - Whether to include plan_data field (default: true)
   * @returns SnapshotDetailDTO if includePlan=true, SnapshotDTO otherwise, or null if not found
   */
  static async getSnapshotById(
    supabase: SupabaseClient,
    eventId: string,
    snapshotId: string,
    includePlan: boolean = true
  ): Promise<SnapshotDetailDTO | SnapshotDTO | null> {
    // Build conditional select string
    const baseFields = "id, event_id, created_at, created_by, is_manual, label, previous_snapshot_id";
    const selectFields = includePlan ? `${baseFields}, plan_data` : baseFields;

    const { data, error } = await supabase
      .from("snapshots")
      .select(selectFields)
      .eq("id", snapshotId)
      .eq("event_id", eventId) // Cross-event protection
      .single();

    if (error) {
      // Supabase returns PGRST116 for no rows
      if (error.code === "PGRST116") {
        return null;
      }
      throw error;
    }

    return data;
  }
}
```

**Tasks**:

- [ ] Create `src/lib/services/snapshot.service.ts`
- [ ] Implement `getSnapshotById` method with conditional projection
- [ ] Add TypeScript types for return values
- [ ] Handle error cases (not found, database errors)

### Step 2: Create Validation Schemas

**File**: `src/pages/api/events/[event_id]/snapshots/[snapshot_id].ts` (inline schemas)

```typescript
import { z } from "zod";

// Path parameters validation
const paramsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
  snapshot_id: z.string().uuid({ message: "Invalid snapshot ID format" }),
});

// Query parameters validation
const querySchema = z.object({
  plan: z.coerce.boolean().optional().default(true),
});
```

**Tasks**:

- [ ] Define Zod schemas for path and query parameters
- [ ] Add custom error messages for validation failures
- [ ] Use `.coerce.boolean()` for flexible plan parameter parsing

### Step 3: Implement API Route Handler

**File**: `src/pages/api/events/[event_id]/snapshots/[snapshot_id].ts`

```typescript
import type { APIRoute } from "astro";
import { z } from "zod";
import { SnapshotService } from "@/lib/services/snapshot.service";
import type { SnapshotDTO, SnapshotDetailDTO, ApiErrorDTO } from "@/types";

export const prerender = false;

// Validation schemas (from Step 2)
const paramsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
  snapshot_id: z.string().uuid({ message: "Invalid snapshot ID format" }),
});

const querySchema = z.object({
  plan: z.coerce.boolean().optional().default(true),
});

export const GET: APIRoute = async ({ params, url, locals }) => {
  const supabase = locals.supabase;

  // 1. Validate path parameters
  const paramsValidation = paramsSchema.safeParse(params);
  if (!paramsValidation.success) {
    const errorResponse: ApiErrorDTO = {
      error: {
        code: "INVALID_SNAPSHOT_ID",
        message: "Invalid snapshot or event ID format",
        details: paramsValidation.error.flatten(),
      },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { event_id: eventId, snapshot_id: snapshotId } = paramsValidation.data;

  // 2. Validate query parameters
  const queryValidation = querySchema.safeParse({
    plan: url.searchParams.get("plan"),
  });

  if (!queryValidation.success) {
    const errorResponse: ApiErrorDTO = {
      error: {
        code: "INVALID_QUERY_PARAM",
        message: "Invalid value for 'plan' parameter",
        details: queryValidation.error.flatten(),
      },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { plan: includePlan } = queryValidation.data;

  // 3. Authenticate user
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();
  if (authError || !user) {
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

  // 4. Retrieve snapshot via service
  try {
    const snapshot = await SnapshotService.getSnapshotById(supabase, eventId, snapshotId, includePlan);

    if (!snapshot) {
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "SNAPSHOT_NOT_FOUND",
          message: "Snapshot not found",
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Return successful response
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=300", // 5 minute cache
      },
    });
  } catch (error) {
    console.error("Error retrieving snapshot:", {
      error,
      eventId,
      snapshotId,
      userId: user.id,
    });

    const errorResponse: ApiErrorDTO = {
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
```

**Tasks**:

- [ ] Create file `src/pages/api/events/[event_id]/snapshots/[snapshot_id].ts`
- [ ] Set `export const prerender = false`
- [ ] Implement GET handler with all validation steps
- [ ] Add proper error handling for each failure case
- [ ] Include structured logging for 500 errors
- [ ] Set appropriate cache headers

### Step 4: Configure Row Level Security (Database)

**File**: `supabase/migrations/[timestamp]_add_snapshots_rls.sql`

```sql
-- Enable RLS on snapshots table
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view snapshots of events they own
CREATE POLICY "Users can view snapshots of their events"
ON snapshots FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM events
    WHERE events.id = snapshots.event_id
    AND events.owner_id = auth.uid()
    AND events.deleted_at IS NULL
  )
);

-- Ensure indexes exist for performance
CREATE INDEX IF NOT EXISTS idx_snapshots_event_id ON snapshots(event_id);
CREATE INDEX IF NOT EXISTS idx_events_owner_id ON events(owner_id);
```

**Tasks**:

- [ ] Create migration file for RLS policies
- [ ] Enable RLS on snapshots table if not already enabled
- [ ] Create SELECT policy joining to events table
- [ ] Add necessary indexes for policy performance
- [ ] Apply migration to development and production databases

### Step 5: Add TypeScript Type Guards (Optional)

**File**: `src/lib/services/snapshot.service.ts` (extend)

```typescript
export function isSnapshotDetailDTO(snapshot: SnapshotDTO | SnapshotDetailDTO): snapshot is SnapshotDetailDTO {
  return "plan_data" in snapshot;
}
```

**Tasks**:

- [ ] Add type guard for runtime type checking
- [ ] Use in frontend when consuming API response
- [ ] Helps TypeScript narrow union types

### Step 6: Write Integration Tests

**File**: `tests/api/snapshots.test.ts`

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { createTestUser, createTestEvent, createTestSnapshot } from "./helpers";

describe("GET /api/events/{event_id}/snapshots/{snapshot_id}", () => {
  let authToken: string;
  let eventId: string;
  let snapshotId: string;

  beforeAll(async () => {
    const user = await createTestUser();
    authToken = user.token;
    const event = await createTestEvent(user.id);
    eventId = event.id;
    const snapshot = await createTestSnapshot(eventId, user.id);
    snapshotId = snapshot.id;
  });

  it("should return snapshot with plan_data by default", async () => {
    const response = await fetch(`http://localhost:4321/api/events/${eventId}/snapshots/${snapshotId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("plan_data");
    expect(data.id).toBe(snapshotId);
  });

  it("should return snapshot without plan_data when plan=false", async () => {
    const response = await fetch(`http://localhost:4321/api/events/${eventId}/snapshots/${snapshotId}?plan=false`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).not.toHaveProperty("plan_data");
    expect(data.id).toBe(snapshotId);
  });

  it("should return 401 without authentication", async () => {
    const response = await fetch(`http://localhost:4321/api/events/${eventId}/snapshots/${snapshotId}`);
    expect(response.status).toBe(401);
  });

  it("should return 404 for non-existent snapshot", async () => {
    const fakeSnapshotId = "00000000-0000-0000-0000-000000000000";
    const response = await fetch(`http://localhost:4321/api/events/${eventId}/snapshots/${fakeSnapshotId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(response.status).toBe(404);
  });

  it("should return 404 when snapshot belongs to different event", async () => {
    const otherEvent = await createTestEvent(user.id);
    const response = await fetch(`http://localhost:4321/api/events/${otherEvent.id}/snapshots/${snapshotId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(response.status).toBe(404);
  });

  it("should return 400 for invalid UUID format", async () => {
    const response = await fetch(`http://localhost:4321/api/events/${eventId}/snapshots/invalid-uuid`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(response.status).toBe(400);
  });
});
```

**Tasks**:

- [ ] Create test file with integration tests
- [ ] Test successful retrieval with and without plan_data
- [ ] Test all error cases (401, 404, 400, 403)
- [ ] Test cross-event access prevention
- [ ] Run tests and verify all pass

### Step 7: Update API Documentation

**File**: `.ai/api-plan.md` (update or create endpoint reference)

**Tasks**:

- [ ] Document endpoint in API reference
- [ ] Include request/response examples
- [ ] Document query parameters and behavior
- [ ] Add security and authorization notes
- [ ] Update changelog or API version notes

### Step 8: Manual Testing Checklist

**Test Cases**:

- [ ] Retrieve snapshot with plan_data (default)
- [ ] Retrieve snapshot without plan_data (plan=false)
- [ ] Verify plan=true and plan=1 work equivalently
- [ ] Verify plan=false and plan=0 work equivalently
- [ ] Test with missing authentication token (expect 401)
- [ ] Test with expired token (expect 401)
- [ ] Test with invalid snapshot UUID (expect 400)
- [ ] Test with non-existent snapshot (expect 404)
- [ ] Test accessing another user's snapshot (expect 404/403)
- [ ] Test snapshot from wrong event (expect 404)
- [ ] Verify response includes all SnapshotDTO fields
- [ ] Verify plan_data structure matches PlanDataDTO type
- [ ] Test with large plan_data (300+ guests) and measure response time
- [ ] Verify gzip compression is applied to large responses
- [ ] Test cache headers are present and correct

---

## Implementation Checklist Summary

- [ ] **Step 1**: Create SnapshotService with getSnapshotById method
- [ ] **Step 2**: Define Zod validation schemas
- [ ] **Step 3**: Implement GET API route handler
- [ ] **Step 4**: Configure Row Level Security policies
- [ ] **Step 5**: Add TypeScript type guards (optional)
- [ ] **Step 6**: Write integration tests
- [ ] **Step 7**: Update API documentation
- [ ] **Step 8**: Complete manual testing checklist

**Estimated Implementation Time**: 3-4 hours

**Dependencies**:

- Supabase client configured in middleware
- Authentication working via Supabase JWT
- Database migrations for snapshots table completed
- Zod library installed
