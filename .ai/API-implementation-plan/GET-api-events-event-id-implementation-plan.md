# API Endpoint Implementation Plan: GET /api/events/{event_id}

## 1. Endpoint Overview

This endpoint fetches a single wedding seating event by its unique identifier. The endpoint returns the complete event metadata along with the full `plan_data` JSONB structure containing tables, guests, and settings. An optional query parameter allows clients to request metadata-only responses, omitting the potentially large plan_data payload.

**Primary Use Cases:**

- Load full event state for the seating planner canvas/editor
- Fetch event metadata for display in navigation or breadcrumbs
- Verify event ownership and access permissions

**Key Characteristics:**

- Read-only operation (no mutations)
- Owner-only access enforced via Supabase Row Level Security (RLS)
- Supports conditional projection of plan_data for performance optimization
- Returns lock status to coordinate multi-user editing scenarios

## 2. Request Details

### HTTP Method

`GET`

### URL Structure

```
/api/events/{event_id}
```

### Path Parameters

| Parameter  | Type | Required | Constraints          | Description                                |
| ---------- | ---- | -------- | -------------------- | ------------------------------------------ |
| `event_id` | UUID | Yes      | Valid UUID v4 format | Unique identifier of the event to retrieve |

### Query Parameters

| Parameter | Type   | Required | Default | Valid Values              | Description                                                                                 |
| --------- | ------ | -------- | ------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| `plan`    | string | No       | "true"  | "true", "false", "1", "0" | Controls inclusion of plan_data in response. Set to "false" or "0" to omit heavy plan data. |

### Headers

| Header          | Required | Description                                              |
| --------------- | -------- | -------------------------------------------------------- |
| `Authorization` | Yes      | Bearer token with Supabase JWT. Format: `Bearer <token>` |
| `Accept`        | No       | Should be `application/json` (default assumed)           |

### Request Body

None (GET request)

### Example Requests

**Full event with plan_data:**

```
GET /api/events/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Metadata-only (no plan_data):**

```
GET /api/events/550e8400-e29b-41d4-a716-446655440000?plan=false
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 3. Used Types

### Response DTOs

**EventDTO** (Full response with plan_data):

```typescript
interface EventDTO {
  id: UUID;
  owner_id: UUID;
  name: string;
  event_date: string | null; // 'YYYY-MM-DD' or null
  grid: { rows: number; cols: number }; // Derived from grid_rows / grid_cols
  plan_data: PlanDataDTO; // Refined JSONB
  autosave_version: number;
  lock: LockStatusDTO; // Derived from lock_held_by / lock_expires_at
  created_at: ISO8601Timestamp;
  updated_at: ISO8601Timestamp;
  deleted_at?: ISO8601Timestamp | null; // Present if soft-deleted
}
```

**EventSummaryDTO** (Metadata-only response when plan=false):

```typescript
interface EventSummaryDTO extends Omit<EventDTO, "plan_data" | "lock"> {
  // plan_data and lock omitted by default
  plan_data?: PlanDataDTO; // Never included when plan=false
  lock?: LockStatusDTO; // Never included when plan=false
}
```

**Nested Types:**

```typescript
interface PlanDataDTO {
  tables: TableDTO[];
  guests: GuestDTO[];
  settings: PlanSettingsDTO;
}

interface LockStatusDTO {
  held_by: UUID | null;
  expires_at: ISO8601Timestamp | null;
}
```

**Error Response:**

```typescript
interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Database Types

**DBEventRow** (from database.types.ts):

```typescript
type DBEventRow = Tables<"events">;
// Corresponds to the events table Row type with fields:
// id, owner_id, name, event_date, grid_rows, grid_cols,
// plan_data (Json), autosave_version, lock_held_by, lock_expires_at,
// deleted_at, created_at, updated_at
```

### Validation Schemas (Zod)

```typescript
const GetEventParamsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
});

const GetEventQuerySchema = z.object({
  plan: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((val) => val !== "false" && val !== "0")
    .default("true"),
});
```

## 4. Response Details

### Success Response (200 OK)

**With plan_data (default):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "owner_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "name": "Sarah & Tom's Wedding",
  "event_date": "2026-06-15",
  "grid": {
    "rows": 20,
    "cols": 30
  },
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
      },
      {
        "id": "g2",
        "name": "Bob Johnson",
        "tag": "Friends",
        "rsvp": "Maybe"
      }
    ],
    "settings": {
      "color_palette": "default"
    }
  },
  "autosave_version": 42,
  "lock": {
    "held_by": null,
    "expires_at": null
  },
  "created_at": "2025-10-01T14:30:00.000Z",
  "updated_at": "2025-10-29T10:15:22.543Z"
}
```

**Without plan_data (plan=false):**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "owner_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "name": "Sarah & Tom's Wedding",
  "event_date": "2026-06-15",
  "grid": {
    "rows": 20,
    "cols": 30
  },
  "autosave_version": 42,
  "created_at": "2025-10-01T14:30:00.000Z",
  "updated_at": "2025-10-29T10:15:22.543Z"
}
```

### Error Responses

**404 Not Found - Event doesn't exist or access denied:**

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

**401 Unauthorized - Missing or invalid JWT:**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required",
    "details": {}
  }
}
```

**400 Bad Request - Invalid event_id format:**

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

**500 Internal Server Error - Database or server error:**

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
   - Extract plan query param
   ↓
4. Authentication Check
   - Extract JWT from Authorization header
   - Call supabase.auth.getUser() to verify token & get user_id
   - Return 401 if invalid/missing
   ↓
5. Input Validation
   - Validate event_id with Zod (UUID format)
   - Validate plan query param with Zod (boolean-like)
   - Return 400 if validation fails
   ↓
6. Service Layer Call (src/lib/services/events.service.ts)
   - EventsService.getEventById(supabase, event_id, user_id, includePlan)
   ↓
7. Database Query
   - Query events table with RLS enforcement
   - SELECT * FROM events WHERE id = event_id AND owner_id = user_id
   - RLS policy automatically filters by owner_id
   ↓
8. Authorization Check (implicit via RLS)
   - If event exists but user doesn't own it: RLS returns no rows
   - If event doesn't exist: returns no rows
   - Both cases handled identically (404)
   ↓
9. Data Transformation
   - Map database row to EventDTO or EventSummaryDTO
   - Transform grid_rows/grid_cols → grid object
   - Transform lock_held_by/lock_expires_at → lock object
   - Cast plan_data JSONB to PlanDataDTO (with optional validation)
   - Omit plan_data and lock if includePlan = false
   ↓
10. Response
    - Return 200 with EventDTO/EventSummaryDTO JSON
    - OR return 404 with ApiErrorDTO if event not found
```

### Database Interaction

**Query:**

```sql
SELECT
  id,
  owner_id,
  name,
  event_date,
  grid_rows,
  grid_cols,
  plan_data,
  autosave_version,
  lock_held_by,
  lock_expires_at,
  created_at,
  updated_at,
  deleted_at
FROM events
WHERE id = $1
  AND owner_id = $2  -- Enforced by RLS
  AND deleted_at IS NULL;  -- Exclude soft-deleted events
```

**Supabase Client Call:**

```typescript
const { data, error } = await supabase.from("events").select("*").eq("id", eventId).is("deleted_at", null).single();
```

## 6. Security Considerations

### Authentication & Authorization

1. **JWT Validation**
   - Supabase SDK automatically validates JWT signature, expiration, and issuer
   - Extract user_id from verified JWT claims
   - Reject requests with missing or invalid tokens (401)

2. **Row Level Security (RLS)**
   - Database policy ensures users can only access events where `owner_id = auth.uid()`
   - RLS provides defense-in-depth even if application logic has bugs
   - No need for additional authorization checks in application code

3. **Ownership Verification**
   - User can only fetch their own events
   - Attempting to access another user's event returns 404 (not 403) to avoid information disclosure
   - Soft-deleted events also return 404

### Input Validation

1. **Path Parameter Sanitization**
   - Validate event_id as UUID before database query
   - Prevents SQL injection or path traversal attempts
   - Zod schema ensures type safety

2. **Query Parameter Validation**
   - Validate plan parameter as boolean-like value
   - Graceful handling of invalid values (default to true)
   - Prevents unexpected behavior from malicious inputs

### Data Protection

1. **PII Handling**
   - This endpoint is owner-only; owners have full access to their data
   - plan_data may contain PII (guest names, dietary notes)
   - PII filtering only applies to public share link endpoints (separate from this endpoint)

2. **Output Sanitization**
   - plan_data returned as-is from JSONB column
   - No need for sanitization since owner created the data
   - Future enhancement: validate plan_data structure against schema

### Rate Limiting (Future Enhancement)

- Consider implementing per-user rate limits (e.g., 100 req/min)
- Prevents abuse and ensures fair resource usage
- Can be implemented via middleware or edge functions

### HTTPS Enforcement

- All API requests must use HTTPS in production
- Prevents JWT token interception
- Configured at hosting/reverse proxy level

## 7. Error Handling

### Error Categories and Responses

| Error Category            | Status Code | Error Code       | Handling Strategy                                                 |
| ------------------------- | ----------- | ---------------- | ----------------------------------------------------------------- |
| **Validation Errors**     | 400         | INVALID_EVENT_ID | Validate input with Zod; return detailed validation errors        |
| **Authentication Errors** | 401         | UNAUTHORIZED     | Check JWT with supabase.auth.getUser(); return generic message    |
| **Authorization Errors**  | 404         | EVENT_NOT_FOUND  | RLS filters unauthorized events; indistinguishable from not found |
| **Not Found Errors**      | 404         | EVENT_NOT_FOUND  | Return same error for non-existent and unauthorized events        |
| **Database Errors**       | 500         | INTERNAL_ERROR   | Log error details; return generic message to client               |
| **JSONB Parsing Errors**  | 500         | DATA_CORRUPTION  | Log malformed plan_data; return generic error                     |

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
**Detection:** Supabase query returns null (single() throws error if no rows)  
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
**Detection:** RLS filters out row; query returns null  
**Response:** Same as #4 (intentionally indistinguishable)  
**Status:** 404

#### 6. Soft-Deleted Event

**Trigger:** Event has deleted_at timestamp  
**Detection:** Query filters by `deleted_at IS NULL`  
**Response:** Same as #4  
**Status:** 404

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

#### 8. Malformed plan_data JSONB

**Trigger:** plan_data doesn't match expected PlanDataDTO structure  
**Detection:** Runtime validation fails (optional)  
**Logging:** Log event_id and plan_data structure  
**Response:** Same as #7  
**Status:** 500

### Error Logging Strategy

**What to Log:**

- All 500 errors with full error details and stack traces
- 401 errors (authentication failures) - potential security incidents
- 400 errors (validation failures) - may indicate client bugs or attacks
- Database query performance (slow queries)

**What NOT to Log:**

- Valid 404 responses (normal operation)
- Successful requests (unless debugging)
- Sensitive data (JWT tokens, PII from plan_data)

**Logging Levels:**

- ERROR: 500 errors, database failures
- WARN: 401 errors, repeated validation failures from same client
- INFO: Request/response summaries (development only)
- DEBUG: Full request/response bodies (development only)

**Implementation:**

```typescript
// Use Astro's logger or console in MVP
console.error("[GET /api/events/:id]", {
  event_id: eventId,
  user_id: userId,
  error: error.message,
  stack: error.stack,
});
```

## 8. Performance Considerations

### Potential Bottlenecks

1. **Large plan_data Payloads**
   - Events with hundreds of guests/tables result in multi-KB JSONB
   - **Mitigation:** Support `plan=false` query param for metadata-only fetches
   - **Future:** Implement field projection (e.g., `fields=name,event_date`)

2. **JSONB Parsing Overhead**
   - PostgreSQL must deserialize JSONB column for every query
   - **Mitigation:** Acceptable for single-row queries; no optimization needed for MVP
   - **Future:** Consider caching frequently accessed events

3. **RLS Policy Evaluation**
   - PostgreSQL evaluates RLS policy for every query
   - **Mitigation:** RLS is highly optimized; negligible overhead for simple equality checks
   - **Monitoring:** Track query execution time

4. **Network Latency**
   - Multiple round-trips (JWT validation, database query)
   - **Mitigation:** Supabase client reuses connections; JWT validated locally after first fetch
   - **Future:** Implement edge caching for public endpoints

### Optimization Strategies

1. **Conditional Projection**
   - Already implemented via `plan=false` query param
   - Reduces response size by ~90% for metadata-only requests

2. **Database Indexing**
   - Ensure index on `events(id)` (primary key, automatic)
   - Ensure index on `events(owner_id)` for RLS performance
   - Composite index not needed (single-row lookup)

3. **Caching** (Future Enhancement)
   - Cache events in Redis/Memcached with TTL
   - Invalidate cache on updates
   - Not needed for MVP (low traffic expected)

4. **Response Compression**
   - Enable gzip/brotli compression at Astro/hosting level
   - Reduces network transfer time for large plan_data

5. **Database Connection Pooling**
   - Supabase handles connection pooling automatically
   - No application-level configuration needed

### Expected Performance Metrics

- **Response Time (p95):** < 200ms for metadata-only, < 500ms with plan_data
- **Database Query Time:** < 50ms
- **Payload Size:** 1-10 KB (metadata only), 10-100 KB (with plan_data)
- **Throughput:** 100+ requests/second per instance (limited by database, not application)

## 9. Implementation Steps

### Step 1: Create Validation Schemas

**File:** `src/lib/validation/events.validation.ts`

```typescript
import { z } from "zod";

export const GetEventParamsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
});

export const GetEventQuerySchema = z.object({
  plan: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((val) => val !== "false" && val !== "0")
    .default("true"),
});
```

### Step 2: Create Service Layer

**File:** `src/lib/services/events.service.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../db/database.types";
import type { EventDTO, EventSummaryDTO, UUID } from "../../types";

export class EventsService {
  /**
   * Fetch a single event by ID
   * @param supabase - Supabase client with user JWT
   * @param eventId - Event UUID
   * @param userId - Authenticated user UUID (for logging/audit)
   * @param includePlanData - Whether to include full plan_data (default true)
   * @returns EventDTO or EventSummaryDTO, or null if not found/unauthorized
   */
  static async getEventById(
    supabase: SupabaseClient<Database>,
    eventId: UUID,
    userId: UUID,
    includePlanData: boolean = true
  ): Promise<EventDTO | EventSummaryDTO | null> {
    // Query database with RLS enforcement
    const { data, error } = await supabase.from("events").select("*").eq("id", eventId).is("deleted_at", null).single();

    if (error) {
      // PostgresError with code 'PGRST116' means no rows returned
      if (error.code === "PGRST116") {
        return null;
      }
      // Other errors are unexpected
      throw error;
    }

    // Transform database row to DTO
    return this.mapEventRowToDTO(data, includePlanData);
  }

  /**
   * Map database row to EventDTO or EventSummaryDTO
   */
  private static mapEventRowToDTO(
    row: Database["public"]["Tables"]["events"]["Row"],
    includePlanData: boolean
  ): EventDTO | EventSummaryDTO {
    const baseEvent = {
      id: row.id,
      owner_id: row.owner_id,
      name: row.name,
      event_date: row.event_date,
      grid: {
        rows: row.grid_rows,
        cols: row.grid_cols,
      },
      autosave_version: row.autosave_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
      ...(row.deleted_at && { deleted_at: row.deleted_at }),
    };

    if (includePlanData) {
      return {
        ...baseEvent,
        plan_data: row.plan_data as any, // TODO: Runtime validation
        lock: {
          held_by: row.lock_held_by,
          expires_at: row.lock_expires_at,
        },
      } as EventDTO;
    }

    return baseEvent as EventSummaryDTO;
  }
}
```

### Step 3: Create API Route Handler

**File:** `src/pages/api/events/[event_id].ts`

```typescript
import type { APIRoute } from "astro";
import { GetEventParamsSchema, GetEventQuerySchema } from "../../../lib/validation/events.validation";
import { EventsService } from "../../../lib/services/events.service";
import type { ApiErrorDTO, EventDTO, EventSummaryDTO } from "../../../types";

export const prerender = false;

export const GET: APIRoute = async (context) => {
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

    // Step 3: Validate query parameters
    const queryResult = GetEventQuerySchema.safeParse({
      plan: context.url.searchParams.get("plan"),
    });

    const includePlanData = queryResult.success ? queryResult.data.plan : true;

    // Step 4: Fetch event from service
    const event = await EventsService.getEventById(
      context.locals.supabase,
      paramsResult.data.event_id,
      user.id,
      includePlanData
    );

    // Step 5: Handle not found
    if (!event) {
      return new Response(
        JSON.stringify({
          error: {
            code: "EVENT_NOT_FOUND",
            message: "Event not found or access denied",
            details: {
              event_id: paramsResult.data.event_id,
            },
          },
        } as ApiErrorDTO),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // Step 6: Return success response
    return new Response(JSON.stringify(event as EventDTO | EventSummaryDTO), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Log error server-side
    console.error("[GET /api/events/:id] Unexpected error:", {
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

### Step 4: Update Supabase Client Type Export

**File:** `src/db/supabase.client.ts`

Ensure the exported client has the correct type:

```typescript
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

const supabaseUrl = import.meta.env.SUPABASE_URL;
const supabaseAnonKey = import.meta.env.SUPABASE_KEY;

export const supabaseClient = createClient<Database>(supabaseUrl, supabaseAnonKey);

export type SupabaseClient = typeof supabaseClient;
```

### Step 5: Update Middleware Type Definitions

**File:** `src/middleware/index.ts`

Ensure `context.locals.supabase` is properly typed:

```typescript
import { defineMiddleware } from "astro:middleware";
import { supabaseClient } from "../db/supabase.client";

export const onRequest = defineMiddleware((context, next) => {
  context.locals.supabase = supabaseClient;
  return next();
});
```

**File:** `src/env.d.ts`

Add type definitions for locals:

```typescript
/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    supabase: import("./db/supabase.client").SupabaseClient;
  }
}
```

### Step 6: Configure Supabase RLS Policy

**Migration File:** `supabase/migrations/YYYYMMDDHHMMSS_events_rls_policy.sql`

```sql
-- Enable RLS on events table
ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only select their own events
CREATE POLICY "Users can view own events"
  ON events
  FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());

-- Policy: Service role bypasses RLS (for background jobs)
CREATE POLICY "Service role has full access"
  ON events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
```

### Step 7: Add Environment Variables

**File:** `.env`

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
```

Ensure these are configured in Astro:

**File:** `astro.config.mjs`

```javascript
import { defineConfig } from "astro/config";

export default defineConfig({
  // Environment variables are automatically available via import.meta.env
});
```

### Step 8: Manual Testing Checklist

1. **Test Valid Request**
   - Request event with valid event_id and JWT
   - Verify 200 response with full EventDTO

2. **Test plan=false Query Param**
   - Request event with `?plan=false`
   - Verify response omits plan_data and lock fields

3. **Test Invalid UUID**
   - Request event with invalid event_id (e.g., "abc123")
   - Verify 400 response with INVALID_EVENT_ID error

4. **Test Missing JWT**
   - Request event without Authorization header
   - Verify 401 response with UNAUTHORIZED error

5. **Test Invalid JWT**
   - Request event with malformed or expired JWT
   - Verify 401 response

6. **Test Non-Existent Event**
   - Request event with valid UUID that doesn't exist
   - Verify 404 response with EVENT_NOT_FOUND error

7. **Test Unauthorized Access**
   - Request another user's event
   - Verify 404 response (same as non-existent)

8. **Test Soft-Deleted Event**
   - Request event that has deleted_at timestamp
   - Verify 404 response

### Step 9: Integration Testing

Create integration test file:

**File:** `tests/api/events/get-event.test.ts`

```typescript
import { describe, it, expect, beforeAll } from "vitest";
// Import test utilities and setup authenticated client
// Test scenarios from manual testing checklist
```

### Step 10: Documentation Updates

1. Update API documentation with example requests/responses
2. Add endpoint to Postman/Insomnia collection
3. Document error codes in error handling guide
4. Add service layer to architecture documentation

### Step 11: Deploy and Monitor

1. Deploy to staging environment
2. Run smoke tests against staging
3. Monitor error rates and response times
4. Deploy to production
5. Set up alerting for elevated error rates (>5% 500 errors)

---

## Implementation Checklist

- [ ] Create validation schemas (Step 1)
- [ ] Create EventsService class (Step 2)
- [ ] Create API route handler (Step 3)
- [ ] Update Supabase client types (Step 4)
- [ ] Update middleware types (Step 5)
- [ ] Configure RLS policies (Step 6)
- [ ] Add environment variables (Step 7)
- [ ] Manual testing (Step 8)
- [ ] Write integration tests (Step 9)
- [ ] Update documentation (Step 10)
- [ ] Deploy and monitor (Step 11)

## Success Criteria

- [ ] All manual tests pass
- [ ] Integration tests achieve >90% code coverage
- [ ] No linting or type errors
- [ ] Response time <500ms (p95)
- [ ] Error rate <1% in production
- [ ] Documentation complete and accurate
