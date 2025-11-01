# API Endpoint Implementation Plan: GET /api/events

## 1. Endpoint Overview

The `GET /api/events` endpoint retrieves a paginated list of wedding seating events owned by the authenticated user. It supports filtering by event name (search), date range, and soft-delete status. The endpoint returns lightweight `EventSummary` objects by default (excluding heavy `plan_data` fields) to optimize bandwidth and performance. Clients can optionally request full plan data via the `include_plan` query parameter.

**Primary Use Cases:**

- Display user's events list in dashboard
- Search and filter events by name or date
- Support infinite scroll or pagination in UI
- Optionally preview plan data without separate fetch

## 2. Request Details

### HTTP Method

`GET`

### URL Structure

```
GET /api/events?limit=20&cursor={token}&search={query}&date_from={date}&date_to={date}&include_deleted=false&include_plan=false
```

### Authentication

- **Required**: Yes
- **Method**: Supabase session token (cookie or Authorization header)
- **Validation**: Middleware extracts authenticated user from `context.locals.supabase.auth.getUser()`

### Query Parameters

| Parameter         | Type    | Required | Default | Validation                  | Description                          |
| ----------------- | ------- | -------- | ------- | --------------------------- | ------------------------------------ |
| `limit`           | integer | No       | 20      | Min: 1, Max: 100            | Number of items per page             |
| `cursor`          | string  | No       | null    | Base64-encoded signed token | Opaque pagination cursor             |
| `search`          | string  | No       | null    | Max length: 150 chars       | Case-insensitive name filter (ILIKE) |
| `date_from`       | string  | No       | null    | ISO date (YYYY-MM-DD)       | Filter events on or after this date  |
| `date_to`         | string  | No       | null    | ISO date (YYYY-MM-DD)       | Filter events on or before this date |
| `include_deleted` | boolean | No       | false   | true/false                  | Include soft-deleted events          |
| `include_plan`    | boolean | No       | false   | true/false                  | Include full plan_data in response   |

### Request Body

None (GET request)

### Headers

- `Authorization: Bearer {token}` (optional if using cookie-based auth)
- Standard Supabase auth headers handled by middleware

## 3. Used Types

### Response DTOs (from `src/types.ts`)

```typescript
// Primary response type
PaginatedDTO<EventSummaryDTO>

// Individual item type
EventSummaryDTO extends Omit<EventDTO, "plan_data" | "lock"> {
  plan_data?: PlanDataDTO;  // Optional when include_plan=true
  lock?: LockStatusDTO;      // Optional when include_plan=true
}

// Supporting types
CursorToken = string;
ISO8601Timestamp = string;
UUID = string;
```

### Internal Types (to be created)

```typescript
// Query parameter validation schema
interface EventListQueryParams {
  limit?: number;
  cursor?: string;
  search?: string;
  date_from?: string;
  date_to?: string;
  include_deleted?: boolean;
  include_plan?: boolean;
}

// Cursor structure (internal, encoded)
interface EventCursor {
  created_at: string; // ISO timestamp
  id: string; // UUID for tie-breaking
}
```

## 4. Response Details

### Success Response (200 OK)

```json
{
  "items": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "owner_id": "660e8400-e29b-41d4-a716-446655440000",
      "name": "Smith Wedding",
      "event_date": "2025-06-15",
      "grid": { "rows": 20, "cols": 30 },
      "autosave_version": 5,
      "created_at": "2025-01-15T10:30:00.000Z",
      "updated_at": "2025-01-20T14:22:00.000Z"
    }
  ],
  "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNS0wMS0yMFQxNDoyMjowMC4wMDBaIiwiaWQiOiI1NTBlODQwMC1lMjliLTQxZDQtYTcxNi00NDY2NTU0NDAwMDAifQ=="
}
```

**Notes:**

- `items`: Array of EventSummaryDTO (may be empty)
- `next_cursor`: Present only if more results exist; null/undefined otherwise
- `plan_data` and `lock` fields excluded by default unless `include_plan=true`
- Soft-deleted events excluded unless `include_deleted=true`

### Error Responses

#### 401 Unauthorized

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

#### 400 Bad Request

```json
{
  "error": {
    "code": "INVALID_QUERY_PARAMS",
    "message": "Validation failed",
    "details": {
      "limit": "Must be between 1 and 100",
      "date_to": "Must be on or after date_from"
    }
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

### High-Level Flow

```
1. Client Request
   ↓
2. Middleware (Authentication)
   ↓
3. Route Handler (/api/events.ts)
   ↓
4. Input Validation (Zod Schema)
   ↓
5. Event Service (listUserEvents)
   ↓
6. Supabase Query (with filters)
   ↓
7. Row → DTO Mapping
   ↓
8. Cursor Generation (if has more)
   ↓
9. JSON Response
```

### Detailed Data Flow

#### Step 1: Authentication (Middleware)

- Middleware extracts Supabase client from `context.locals.supabase`
- Calls `supabase.auth.getUser()` to validate session
- If unauthorized, returns 401 before reaching route handler
- Attaches `user` object to context for route handler

#### Step 2: Query Validation (Route Handler)

- Parse query parameters from `context.request.url.searchParams`
- Validate with Zod schema:
  - Coerce numeric strings to numbers
  - Parse boolean strings ("true"/"false")
  - Validate date formats
  - Enforce constraints (limit max, date ranges)
- Return 400 if validation fails

#### Step 3: Service Layer (EventService.listUserEvents)

```typescript
async listUserEvents(params: {
  userId: UUID;
  limit: number;
  cursor?: CursorToken;
  filters: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    includeDeleted: boolean;
  };
  includePlan: boolean;
}): Promise<PaginatedDTO<EventSummaryDTO>>
```

#### Step 4: Database Query (Supabase)

```typescript
let query = supabase
  .from("events")
  .select("*")
  .eq("owner_id", userId)
  .order("created_at", { ascending: false })
  .order("id", { ascending: false }); // Tie-breaker

// Apply filters
if (!filters.includeDeleted) {
  query = query.is("deleted_at", null);
}

if (filters.search) {
  query = query.ilike("name", `%${filters.search}%`);
}

if (filters.dateFrom) {
  query = query.gte("event_date", filters.dateFrom);
}

if (filters.dateTo) {
  query = query.lte("event_date", filters.dateTo);
}

// Cursor-based pagination
if (cursor) {
  const decoded = decodeCursor(cursor);
  query = query.or(`created_at.lt.${decoded.created_at},and(created_at.eq.${decoded.created_at},id.lt.${decoded.id})`);
}

// Fetch limit + 1 to detect if more results exist
query = query.limit(limit + 1);
```

#### Step 5: Cursor Handling

- Fetch `limit + 1` records
- If result count > limit:
  - Extract last item (index = limit - 1)
  - Generate cursor from last item's `created_at` and `id`
  - Sign cursor with HMAC-SHA256 using secret key
  - Base64-encode signed cursor
  - Trim results to exactly `limit` items
- If result count <= limit:
  - Set `next_cursor` to null
  - Return all items

#### Step 6: Row Mapping

```typescript
function mapEventRowToSummary(row: DBEventRow, includePlan: boolean): EventSummaryDTO {
  const summary: EventSummaryDTO = {
    id: row.id,
    owner_id: row.owner_id,
    name: row.name,
    event_date: row.event_date,
    grid: { rows: row.grid_rows, cols: row.grid_cols },
    autosave_version: row.autosave_version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at || undefined,
  };

  if (includePlan) {
    summary.plan_data = row.plan_data as PlanDataDTO;
    summary.lock = {
      held_by: row.lock_held_by,
      expires_at: row.lock_expires_at,
    };
  }

  return summary;
}
```

## 6. Security Considerations

### Authentication & Authorization

- **Authentication Required**: All requests must include valid Supabase session
- **User Isolation**: Query MUST filter by `owner_id = authenticated_user.id`
- **No Cross-User Access**: Implement RLS-style check even if Supabase RLS is disabled in code

### Input Validation & Sanitization

- **SQL Injection**: Use Supabase's parameterized queries (.ilike(), .eq(), .gte(), etc.)
- **Cursor Tampering**: Sign cursors with HMAC-SHA256 using server-side secret
- **DoS Protection**: Enforce max limit of 100 to prevent memory exhaustion
- **XSS Prevention**: No HTML rendering server-side; JSON response only

### Data Privacy

- **Soft Delete Respect**: Default behavior excludes `deleted_at != null` events
- **Plan Data Exclusion**: Heavy `plan_data` excluded by default to prevent bandwidth abuse
- **No PII Leakage**: EventSummary doesn't expose guest names/notes unless plan_data included

### Rate Limiting (Future)

- Consider implementing per-user rate limits via `admin_flags.rate_limit_exports_daily`
- Track request count in Redis or similar (not in MVP scope)

### HTTPS Enforcement

- Ensure production deployment enforces HTTPS
- Supabase auth tokens transmitted securely

## 7. Error Handling

### Error Categories & Responses

| Scenario                   | Status | Code                 | Message                               | Handling                                |
| -------------------------- | ------ | -------------------- | ------------------------------------- | --------------------------------------- |
| No auth token              | 401    | UNAUTHORIZED         | Authentication required               | Return early from middleware            |
| Invalid/expired token      | 401    | UNAUTHORIZED         | Invalid or expired session            | Supabase auth validation                |
| Invalid limit (<1 or >100) | 400    | INVALID_QUERY_PARAMS | limit must be between 1 and 100       | Zod validation error                    |
| Invalid cursor format      | 400    | INVALID_CURSOR       | Invalid pagination cursor             | Cursor decode/verify failure            |
| Invalid date format        | 400    | INVALID_QUERY_PARAMS | date_from must be YYYY-MM-DD          | Zod date validation                     |
| date_to < date_from        | 400    | INVALID_QUERY_PARAMS | date_to must be >= date_from          | Custom Zod refinement                   |
| Invalid boolean value      | 400    | INVALID_QUERY_PARAMS | include_deleted must be true or false | Zod boolean coercion                    |
| Supabase connection error  | 500    | INTERNAL_ERROR       | Database connection failed            | Log error, return generic message       |
| Unexpected exception       | 500    | INTERNAL_ERROR       | An unexpected error occurred          | Log stack trace, return generic message |

### Error Logging Strategy

```typescript
// Log errors but don't expose internals to client
try {
  // ... operation
} catch (error) {
  console.error("[GET /api/events] Error:", {
    userId: user.id,
    error: error instanceof Error ? error.message : error,
    stack: error instanceof Error ? error.stack : undefined,
  });

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
```

### Validation Error Formatting

```typescript
// Zod error transformation
const formatZodError = (error: ZodError): ApiErrorDTO => ({
  error: {
    code: "INVALID_QUERY_PARAMS",
    message: "Validation failed",
    details: error.errors.reduce(
      (acc, err) => {
        acc[err.path.join(".")] = err.message;
        return acc;
      },
      {} as Record<string, string>
    ),
  },
});
```

## 8. Performance Considerations

### Query Optimization

- **Index Requirements**:
  - `events(owner_id, created_at DESC, id DESC)` - composite index for pagination
  - `events(owner_id, name)` - for search queries
  - `events(owner_id, event_date)` - for date range filters
  - `events(deleted_at)` - for soft-delete filtering

- **Query Efficiency**:
  - Use `.select()` with specific columns when plan_data not needed
  - Avoid `.select('*')` when `include_plan=false`
  - Leverage Supabase's query planner for optimal execution

### Pagination Strategy

- **Cursor-Based (Keyset) Pagination**:
  - More efficient than OFFSET for large datasets
  - Consistent results even with concurrent inserts
  - Cursor encodes `(created_at, id)` for deterministic ordering
  - Avoids scanning skipped rows

- **Fetch Limit + 1**:
  - Single query to detect "has more" without COUNT(\*)
  - Reduces database round-trips

### Caching Opportunities (Future)

- Cache event list per user with short TTL (30s)
- Invalidate on event creation/update/delete
- Use Redis or in-memory cache
- Not in MVP scope

### Response Size

- Default exclusion of `plan_data` reduces response from ~10KB to ~500B per event
- Enable compression (gzip/brotli) at server/CDN level
- Consider pagination limit default of 20 to balance UX and bandwidth

## 9. Implementation Steps

### Step 1: Create Validation Schema

**File**: `src/lib/validation/event-list-query.schema.ts`

```typescript
import { z } from "zod";

export const eventListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    search: z.string().max(150).optional(),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    include_deleted: z
      .enum(["true", "false"])
      .transform((val) => val === "true")
      .default("false"),
    include_plan: z
      .enum(["true", "false"])
      .transform((val) => val === "true")
      .default("false"),
  })
  .refine(
    (data) => {
      if (data.date_from && data.date_to) {
        return new Date(data.date_from) <= new Date(data.date_to);
      }
      return true;
    },
    { message: "date_to must be on or after date_from", path: ["date_to"] }
  );

export type EventListQueryParams = z.infer<typeof eventListQuerySchema>;
```

### Step 2: Create Cursor Utilities

**File**: `src/lib/utils/cursor.ts`

```typescript
import crypto from "crypto";

const CURSOR_SECRET = import.meta.env.CURSOR_SECRET || "development-secret-change-in-production";

interface EventCursor {
  created_at: string;
  id: string;
}

export function encodeCursor(cursor: EventCursor): string {
  const payload = JSON.stringify(cursor);
  const signature = crypto.createHmac("sha256", CURSOR_SECRET).update(payload).digest("hex");

  const signed = JSON.stringify({ payload, signature });
  return Buffer.from(signed).toString("base64url");
}

export function decodeCursor(token: string): EventCursor {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    const { payload, signature } = JSON.parse(decoded);

    // Verify signature
    const expectedSig = crypto.createHmac("sha256", CURSOR_SECRET).update(payload).digest("hex");

    if (signature !== expectedSig) {
      throw new Error("Invalid cursor signature");
    }

    return JSON.parse(payload);
  } catch (error) {
    throw new Error("Invalid cursor format");
  }
}
```

### Step 3: Create Event Service

**File**: `src/lib/services/event.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { EventSummaryDTO, PaginatedDTO, UUID, CursorToken } from "../types";
import { encodeCursor, decodeCursor } from "../utils/cursor";

export interface ListEventsParams {
  userId: UUID;
  limit: number;
  cursor?: CursorToken;
  filters: {
    search?: string;
    dateFrom?: string;
    dateTo?: string;
    includeDeleted: boolean;
  };
  includePlan: boolean;
}

export class EventService {
  constructor(private supabase: SupabaseClient) {}

  async listUserEvents(params: ListEventsParams): Promise<PaginatedDTO<EventSummaryDTO>> {
    const { userId, limit, cursor, filters, includePlan } = params;

    // Build base query
    let query = this.supabase
      .from("events")
      .select("*")
      .eq("owner_id", userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });

    // Apply soft-delete filter
    if (!filters.includeDeleted) {
      query = query.is("deleted_at", null);
    }

    // Apply search filter
    if (filters.search) {
      query = query.ilike("name", `%${filters.search}%`);
    }

    // Apply date range filters
    if (filters.dateFrom) {
      query = query.gte("event_date", filters.dateFrom);
    }

    if (filters.dateTo) {
      query = query.lte("event_date", filters.dateTo);
    }

    // Apply cursor pagination
    if (cursor) {
      const decoded = decodeCursor(cursor);
      query = query.or(
        `created_at.lt.${decoded.created_at},and(created_at.eq.${decoded.created_at},id.lt.${decoded.id})`
      );
    }

    // Fetch limit + 1 to detect more results
    query = query.limit(limit + 1);

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to fetch events: ${error.message}`);
    }

    // Determine if there are more results
    const hasMore = data.length > limit;
    const items = hasMore ? data.slice(0, limit) : data;

    // Generate next cursor
    let nextCursor: CursorToken | null = null;
    if (hasMore) {
      const lastItem = items[items.length - 1];
      nextCursor = encodeCursor({
        created_at: lastItem.created_at,
        id: lastItem.id,
      });
    }

    // Map rows to DTOs
    const mappedItems = items.map((row) => this.mapRowToSummary(row, includePlan));

    return {
      items: mappedItems,
      next_cursor: nextCursor,
    };
  }

  private mapRowToSummary(
    row: any, // DBEventRow from database.types.ts
    includePlan: boolean
  ): EventSummaryDTO {
    const summary: EventSummaryDTO = {
      id: row.id,
      owner_id: row.owner_id,
      name: row.name,
      event_date: row.event_date,
      grid: { rows: row.grid_rows, cols: row.grid_cols },
      autosave_version: row.autosave_version,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };

    if (row.deleted_at) {
      summary.deleted_at = row.deleted_at;
    }

    if (includePlan) {
      summary.plan_data = row.plan_data;
      summary.lock = {
        held_by: row.lock_held_by,
        expires_at: row.lock_expires_at,
      };
    }

    return summary;
  }
}
```

### Step 4: Create API Route Handler

**File**: `src/pages/api/events.ts`

```typescript
import type { APIRoute } from "astro";
import { eventListQuerySchema } from "../../lib/validation/event-list-query.schema";
import { EventService } from "../../lib/services/event.service";
import type { ApiErrorDTO } from "../../types";
import { ZodError } from "zod";

export const prerender = false;

export const GET: APIRoute = async (context) => {
  // 1. Authenticate user
  const {
    data: { user },
    error: authError,
  } = await context.locals.supabase.auth.getUser();

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

  try {
    // 2. Parse and validate query parameters
    const url = new URL(context.request.url);
    const queryParams = Object.fromEntries(url.searchParams.entries());

    const validatedParams = eventListQuerySchema.parse(queryParams);

    // 3. Call service layer
    const eventService = new EventService(context.locals.supabase);
    const result = await eventService.listUserEvents({
      userId: user.id,
      limit: validatedParams.limit,
      cursor: validatedParams.cursor,
      filters: {
        search: validatedParams.search,
        dateFrom: validatedParams.date_from,
        dateTo: validatedParams.date_to,
        includeDeleted: validatedParams.include_deleted,
      },
      includePlan: validatedParams.include_plan,
    });

    // 4. Return successful response
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Handle validation errors
    if (error instanceof ZodError) {
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "INVALID_QUERY_PARAMS",
          message: "Validation failed",
          details: error.errors.reduce(
            (acc, err) => {
              acc[err.path.join(".")] = err.message;
              return acc;
            },
            {} as Record<string, unknown>
          ),
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle cursor errors
    if (error instanceof Error && error.message.includes("cursor")) {
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "INVALID_CURSOR",
          message: error.message,
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle unexpected errors
    console.error("[GET /api/events] Unexpected error:", {
      userId: user.id,
      error: error instanceof Error ? error.message : error,
      stack: error instanceof Error ? error.stack : undefined,
    });

    const errorResponse: ApiErrorDTO = {
      error: {
        code: "INTERNAL_ERROR",
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

### Step 5: Add Environment Variable

**File**: `.env` (add to .env.example as well)

```env
# Cursor signing secret (generate secure random string for production)
CURSOR_SECRET=your-secure-random-string-here-min-32-chars
```

### Step 6: Update Middleware (if needed)

**File**: `src/middleware/index.ts`

Ensure middleware properly attaches Supabase client to `context.locals`. Current implementation looks correct based on review.

### Step 7: Create Database Indexes (Migration)

**File**: `supabase/migrations/[timestamp]_add_event_list_indexes.sql`

```sql
-- Index for owner-based queries with pagination
CREATE INDEX IF NOT EXISTS idx_events_owner_created_id
ON events(owner_id, created_at DESC, id DESC);

-- Index for search queries
CREATE INDEX IF NOT EXISTS idx_events_owner_name
ON events(owner_id, name);

-- Index for date range queries
CREATE INDEX IF NOT EXISTS idx_events_owner_date
ON events(owner_id, event_date);

-- Index for soft-delete filtering
CREATE INDEX IF NOT EXISTS idx_events_deleted_at
ON events(deleted_at) WHERE deleted_at IS NULL;
```

### Step 8: Testing Checklist

**Unit Tests** (`src/lib/services/event.service.test.ts`):

- [ ] Test pagination with various limit values
- [ ] Test cursor encoding/decoding
- [ ] Test cursor signature validation
- [ ] Test filter combinations (search + date range)
- [ ] Test soft-delete filtering
- [ ] Test include_plan flag behavior
- [ ] Test empty results handling
- [ ] Test row-to-DTO mapping

**Integration Tests** (`src/pages/api/events.test.ts`):

- [ ] Test authenticated request returns 200
- [ ] Test unauthenticated request returns 401
- [ ] Test invalid limit returns 400
- [ ] Test invalid cursor returns 400
- [ ] Test invalid date format returns 400
- [ ] Test date_to < date_from returns 400
- [ ] Test search filtering works correctly
- [ ] Test date range filtering works correctly
- [ ] Test pagination with next_cursor
- [ ] Test last page has null next_cursor
- [ ] Test include_deleted flag
- [ ] Test include_plan flag
- [ ] Test user isolation (can't see other users' events)

**Manual Testing**:

- [ ] Test with Postman/curl
- [ ] Test pagination in browser DevTools
- [ ] Test with large datasets (100+ events)
- [ ] Verify response times (<200ms for typical queries)
- [ ] Test cursor manipulation attempt (should fail)

### Step 9: Documentation Updates

- [ ] Add JSDoc comments to EventService methods
- [ ] Document cursor format in technical docs
- [ ] Update API documentation (Swagger/OpenAPI if applicable)
- [ ] Add usage examples in developer guide

### Step 10: Deployment Checklist

- [ ] Set CURSOR_SECRET environment variable in production
- [ ] Run database migrations (indexes)
- [ ] Verify Supabase connection in production
- [ ] Enable HTTPS enforcement
- [ ] Configure CORS if needed
- [ ] Set up monitoring/alerts for 500 errors
- [ ] Configure response compression (gzip/brotli)
- [ ] Load test with realistic traffic patterns

---

## Additional Notes

### Future Enhancements (Post-MVP)

1. **Caching**: Implement Redis cache for frequent queries
2. **Rate Limiting**: Add per-user rate limits using admin_flags
3. **Analytics**: Track query patterns for optimization
4. **Sorting Options**: Allow sorting by name, date, updated_at
5. **Batch Operations**: Support bulk event operations
6. **GraphQL Alternative**: Consider GraphQL for flexible querying
7. **Real-time Updates**: WebSocket notifications for event changes

### Dependencies

- `zod`: Query parameter validation
- `crypto` (Node.js built-in): Cursor signing
- Supabase JS client: Database queries
- Astro: Route handling

### Performance Targets

- **Response Time**: <100ms (p50), <300ms (p99)
- **Throughput**: 1000 req/sec per instance
- **Database Query Time**: <50ms
- **Pagination Cursor Overhead**: <5ms

### Monitoring Metrics

- Request count by status code
- Average response time
- Cursor validation failure rate
- Search query performance
- Database query execution time
- User isolation violation attempts (should be 0)
