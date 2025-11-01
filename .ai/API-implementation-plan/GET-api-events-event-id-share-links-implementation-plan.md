# API Endpoint Implementation Plan: GET /api/events/{event_id}/share-links

## 1. Endpoint Overview

This endpoint retrieves a list of share links for a specific event. It allows the event owner to view all share links (both active and revoked) with optional filtering by active status. Share links enable view-only access to seating plans for external stakeholders (guests, planners, venue staff).

**Purpose**: List all share links associated with an event, supporting management and auditing of public access.

**Access Level**: Authenticated users only; restricted to event owner.

## 2. Request Details

- **HTTP Method**: `GET`
- **URL Structure**: `/api/events/{event_id}/share-links`
- **Authentication**: Required (Supabase Auth JWT)

### Path Parameters

| Parameter  | Type | Required | Description                        |
| ---------- | ---- | -------- | ---------------------------------- |
| `event_id` | UUID | Yes      | The unique identifier of the event |

### Query Parameters

| Parameter | Type           | Required | Default | Description                                                                                                                       |
| --------- | -------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `active`  | boolean string | No       | -       | Filter by active status. `"true"` returns only non-revoked links, `"false"` returns only revoked links, omitted returns all links |

### Request Headers

| Header          | Required | Description                     |
| --------------- | -------- | ------------------------------- |
| `Authorization` | Yes      | Bearer token from Supabase Auth |

### Example Requests

```http
# Get all share links
GET /api/events/550e8400-e29b-41d4-a716-446655440000/share-links

# Get only active share links
GET /api/events/550e8400-e29b-41d4-a716-446655440000/share-links?active=true

# Get only revoked share links
GET /api/events/550e8400-e29b-41d4-a716-446655440000/share-links?active=false
```

## 3. Used Types

### Response DTOs

```typescript
// From src/types.ts
interface ShareLinkDTO {
  id: UUID;
  event_id: UUID;
  token: string;
  expires_at: ISO8601Timestamp | null;
  include_pii: boolean;
  revoked_at: ISO8601Timestamp | null;
  created_at: ISO8601Timestamp;
  created_by: UUID;
  last_accessed_at: ISO8601Timestamp | null;
  url: string; // Computed field: ${origin}/share/${token}
}

interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Validation Schemas

```typescript
// To be defined in route handler
const ParamsSchema = z.object({
  event_id: z.string().uuid({
    message: "Invalid event_id format",
  }),
});

const QuerySchema = z.object({
  active: z
    .enum(["true", "false"], {
      errorMap: () => ({ message: "Active parameter must be 'true' or 'false'" }),
    })
    .optional(),
});
```

## 4. Response Details

### Success Response (200 OK)

Returns an array of share link objects.

```json
[
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "event_id": "550e8400-e29b-41d4-a716-446655440000",
    "token": "xY9kLm3pQr",
    "expires_at": "2025-12-31T23:59:59.999Z",
    "include_pii": false,
    "revoked_at": null,
    "created_at": "2025-11-01T10:00:00.000Z",
    "created_by": "user-uuid-1",
    "last_accessed_at": "2025-11-15T14:30:00.000Z",
    "url": "https://app.example.com/share/xY9kLm3pQr"
  },
  {
    "id": "223e4567-e89b-12d3-a456-426614174001",
    "event_id": "550e8400-e29b-41d4-a716-446655440000",
    "token": "aB7cDe2fGh",
    "expires_at": null,
    "include_pii": true,
    "revoked_at": "2025-11-10T09:00:00.000Z",
    "created_at": "2025-10-28T08:00:00.000Z",
    "created_by": "user-uuid-1",
    "last_accessed_at": "2025-11-09T16:45:00.000Z",
    "url": "https://app.example.com/share/aB7cDe2fGh"
  }
]
```

### Error Responses

| Status | Error Code          | Description                             | Example                                                                                                |
| ------ | ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 400    | `INVALID_PARAMETER` | Invalid path or query parameter format  | `{ "error": { "code": "INVALID_PARAMETER", "message": "Invalid event_id format" } }`                   |
| 401    | `UNAUTHORIZED`      | Missing or invalid authentication token | `{ "error": { "code": "UNAUTHORIZED", "message": "Authentication required" } }`                        |
| 403    | `FORBIDDEN`         | User is not the event owner             | `{ "error": { "code": "FORBIDDEN", "message": "You don't have permission to access this resource" } }` |
| 404    | `EVENT_NOT_FOUND`   | Event doesn't exist or is deleted       | `{ "error": { "code": "EVENT_NOT_FOUND", "message": "Event not found" } }`                             |
| 500    | `INTERNAL_ERROR`    | Unexpected server error                 | `{ "error": { "code": "INTERNAL_ERROR", "message": "An unexpected error occurred" } }`                 |

## 5. Data Flow

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ GET /api/events/{event_id}/share-links?active=true
       │ Headers: Authorization: Bearer <token>
       ▼
┌─────────────────────┐
│ Astro Middleware    │
│ - Extract JWT       │
│ - Create Supabase   │
│   client with user  │
│   context           │
└──────┬──────────────┘
       │
       ▼
┌────────────────────────────────────────────────┐
│ Route Handler                                  │
│ /src/pages/api/events/[event_id]/             │
│ share-links/index.ts                           │
│                                                │
│ 1. Validate path params (event_id)            │
│ 2. Validate query params (active)             │
│ 3. Parse active filter                        │
└──────┬─────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────┐
│ Service Layer                                  │
│ /src/lib/services/share-link.service.ts        │
│                                                │
│ verifyEventOwnership():                        │
│ - Query events table                           │
│ - Check owner_id matches user                  │
│ - Check deleted_at IS NULL                     │
│ - Return event or throw error                  │
└──────┬─────────────────────────────────────────┘
       │
       ▼
┌────────────────────────────────────────────────┐
│ Service Layer (continued)                      │
│                                                │
│ listShareLinks():                              │
│ - Query share_links table                      │
│ - Filter by event_id                           │
│ - Apply active filter if present               │
│   (WHERE revoked_at IS NULL for active=true)   │
│   (WHERE revoked_at IS NOT NULL for            │
│    active=false)                               │
│ - Order by created_at DESC                     │
│ - Map rows to ShareLinkDTO                     │
│ - Compute url field for each                   │
└──────┬─────────────────────────────────────────┘
       │
       ▼
┌─────────────────────┐
│   Supabase          │
│   PostgreSQL        │
│                     │
│ - events table      │
│ - share_links table │
└──────┬──────────────┘
       │
       ▼
┌────────────────────────────────────────────────┐
│ Route Handler (response)                       │
│                                                │
│ - Return ShareLinkDTO[] with 200               │
│ - Or return ApiErrorDTO with appropriate code  │
└──────┬─────────────────────────────────────────┘
       │
       ▼
┌─────────────┐
│   Client    │
└─────────────┘
```

## 6. Security Considerations

### Authentication

- **Requirement**: Valid Supabase Auth JWT token in Authorization header
- **Implementation**: Handled by Astro middleware (`src/middleware/index.ts`)
- **Failure Mode**: Return 401 UNAUTHORIZED if token missing or invalid

### Authorization

- **Requirement**: User must be the owner of the event
- **Implementation**: Query `events` table, verify `owner_id` matches authenticated user
- **Failure Mode**: Return 403 FORBIDDEN if user is not owner

### Data Access Control

- **Sensitive Fields**: Exclude `password_hash` from response (already excluded in ShareLinkDTO)
- **Soft Deletes**: Filter out events where `deleted_at IS NOT NULL` (treat as not found)
- **Implementation**: Use explicit column selection in queries, never SELECT \*

### Input Validation

- **Path Parameters**: Validate `event_id` is valid UUID format
- **Query Parameters**: Validate `active` is either 'true', 'false', or omitted
- **SQL Injection**: Use parameterized queries (Supabase client handles this)

### Rate Limiting

- **Consideration**: Not required for MVP (read operation, owner-only access)
- **Future**: Consider implementing if abuse detected

### CORS

- **Configuration**: Handled by Astro configuration
- **Requirement**: Restrict to same-origin or configured allowed origins

## 7. Error Handling

### Error Scenarios and Handling Strategy

| Error Type                | Detection                            | Status Code | Error Code          | Handling                                           |
| ------------------------- | ------------------------------------ | ----------- | ------------------- | -------------------------------------------------- |
| Missing auth token        | Middleware                           | 401         | `UNAUTHORIZED`      | Return immediately from middleware                 |
| Invalid auth token        | Supabase client                      | 401         | `UNAUTHORIZED`      | Return immediately from middleware                 |
| Invalid event_id format   | Zod validation                       | 400         | `INVALID_PARAMETER` | Return with validation error details               |
| Invalid active param      | Zod validation                       | 400         | `INVALID_PARAMETER` | Return with validation error details               |
| Event not found           | Database query (0 rows)              | 404         | `EVENT_NOT_FOUND`   | Return after ownership check                       |
| Event soft-deleted        | Database query (deleted_at NOT NULL) | 404         | `EVENT_NOT_FOUND`   | Return after ownership check                       |
| Not event owner           | owner_id mismatch                    | 403         | `FORBIDDEN`         | Return after ownership check                       |
| Database connection error | Supabase client                      | 500         | `INTERNAL_ERROR`    | Log error, return generic message                  |
| Unexpected error          | try-catch                            | 500         | `INTERNAL_ERROR`    | Log error with stack trace, return generic message |

### Error Response Format

All errors follow the `ApiErrorDTO` structure:

```typescript
{
  error: {
    code: string,        // Machine-readable error code
    message: string,     // Human-readable message
    details?: object     // Optional additional context (validation errors, etc.)
  }
}
```

### Logging Strategy

- **Error Logging**: Use `console.error()` for 500-level errors with full context
- **Access Logging**: Not required for this endpoint (read operation)
- **Audit Logging**: Not required (no mutation)
- **Log Contents**: Include event_id, user_id, error message, stack trace (for 500s)

```typescript
console.error("Failed to list share links", {
  event_id,
  user_id: user.id,
  error: error.message,
  stack: error.stack,
});
```

## 8. Performance Considerations

### Database Optimization

**Indexes Required**:

```sql
-- Assumed to exist from FK constraint
CREATE INDEX idx_share_links_event_id ON share_links(event_id);

-- Recommended for active filtering
CREATE INDEX idx_share_links_event_id_revoked_at
ON share_links(event_id, revoked_at);
```

**Query Optimization**:

- Use explicit column selection (avoid SELECT \*)
- Single query for ownership verification and event existence
- Efficient filtering with indexed columns
- Order by indexed column (`created_at`)

### Response Size

**Expected Size**:

- Typical event: 1-10 share links
- Maximum realistic: ~100 share links
- No pagination needed for MVP (array response acceptable)

**Future Optimization** (if needed):

- Implement cursor-based pagination using `created_at`
- Add `limit` and `cursor` query parameters
- Return `PaginatedDTO<ShareLinkDTO>` with `next_cursor`

### Caching Strategy

**Not Recommended for MVP**:

- Share links change infrequently but need real-time accuracy
- Cache invalidation complexity not justified for low-volume reads
- Database query is fast with proper indexes

**Future Consideration**:

- Short-lived cache (5-10 seconds) for high-traffic scenarios
- Cache key: `share-links:${event_id}:${active}`
- Invalidate on share link create/update/revoke

### Network Optimization

- **Compression**: Enable gzip/brotli for JSON responses (handled by Astro)
- **Response Size**: Minimal overhead (~500-1000 bytes per share link)
- **HTTP/2**: Leverage connection multiplexing (server configuration)

## 9. Implementation Steps

### Step 1: Create Share Link Service

**File**: `src/lib/services/share-link.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { ShareLinkDTO, UUID } from "../types";

/**
 * Verify that the authenticated user owns the specified event.
 * Throws error if event not found, deleted, or user is not owner.
 */
export async function verifyEventOwnership(supabase: SupabaseClient, eventId: UUID, userId: UUID): Promise<void> {
  // Early return: validate inputs
  if (!eventId || !userId) {
    throw new Error("EVENT_NOT_FOUND");
  }

  const { data: event, error } = await supabase
    .from("events")
    .select("id, owner_id, deleted_at")
    .eq("id", eventId)
    .is("deleted_at", null)
    .single();

  // Handle query errors
  if (error) {
    if (error.code === "PGRST116") {
      // No rows returned
      throw new Error("EVENT_NOT_FOUND");
    }
    throw error;
  }

  // Verify ownership
  if (event.owner_id !== userId) {
    throw new Error("FORBIDDEN");
  }
}

/**
 * Compute the public share URL for a given token.
 */
export function computeShareLinkUrl(token: string, origin: string): string {
  return `${origin}/share/${token}`;
}

/**
 * List share links for an event with optional active filtering.
 */
export async function listShareLinks(
  supabase: SupabaseClient,
  eventId: UUID,
  options?: { activeOnly?: boolean; origin?: string }
): Promise<ShareLinkDTO[]> {
  const { activeOnly, origin = "" } = options || {};

  // Build query
  let query = supabase
    .from("share_links")
    .select("id, event_id, token, expires_at, include_pii, revoked_at, created_at, created_by, last_accessed_at")
    .eq("event_id", eventId)
    .order("created_at", { ascending: false });

  // Apply active filter
  if (activeOnly === true) {
    query = query.is("revoked_at", null);
  } else if (activeOnly === false) {
    query = query.not("revoked_at", "is", null);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  // Map to DTOs with computed url field
  return (data || []).map((row) => ({
    ...row,
    url: computeShareLinkUrl(row.token, origin),
  }));
}
```

### Step 2: Create Route Handler

**File**: `src/pages/api/events/[event_id]/share-links/index.ts`

```typescript
import type { APIRoute } from "astro";
import { z } from "zod";
import type { ApiErrorDTO } from "../../../../../types";
import { verifyEventOwnership, listShareLinks } from "../../../../../lib/services/share-link.service";

export const prerender = false;

// Validation schemas
const ParamsSchema = z.object({
  event_id: z.string().uuid({
    message: "Invalid event_id format",
  }),
});

const QuerySchema = z.object({
  active: z
    .enum(["true", "false"], {
      errorMap: () => ({ message: "Active parameter must be 'true' or 'false'" }),
    })
    .optional(),
});

export const GET: APIRoute = async ({ params, url, locals }) => {
  const supabase = locals.supabase;
  const user = locals.user;

  // Guard: authentication required
  if (!user) {
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

  try {
    // Validate path parameters
    const paramsResult = ParamsSchema.safeParse(params);
    if (!paramsResult.success) {
      const error: ApiErrorDTO = {
        error: {
          code: "INVALID_PARAMETER",
          message: paramsResult.error.errors[0]?.message || "Invalid parameters",
          details: { errors: paramsResult.error.errors },
        },
      };
      return new Response(JSON.stringify(error), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const { event_id } = paramsResult.data;

    // Validate query parameters
    const queryParams = Object.fromEntries(url.searchParams);
    const queryResult = QuerySchema.safeParse(queryParams);
    if (!queryResult.success) {
      const error: ApiErrorDTO = {
        error: {
          code: "INVALID_PARAMETER",
          message: queryResult.error.errors[0]?.message || "Invalid query parameters",
          details: { errors: queryResult.error.errors },
        },
      };
      return new Response(JSON.stringify(error), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse active filter
    const activeFilter =
      queryResult.data.active === "true" ? true : queryResult.data.active === "false" ? false : undefined;

    // Verify ownership
    await verifyEventOwnership(supabase, event_id, user.id);

    // Fetch share links
    const shareLinks = await listShareLinks(supabase, event_id, {
      activeOnly: activeFilter,
      origin: url.origin,
    });

    // Return success response
    return new Response(JSON.stringify(shareLinks), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: any) {
    // Handle known errors
    if (error.message === "EVENT_NOT_FOUND") {
      const apiError: ApiErrorDTO = {
        error: {
          code: "EVENT_NOT_FOUND",
          message: "Event not found",
        },
      };
      return new Response(JSON.stringify(apiError), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (error.message === "FORBIDDEN") {
      const apiError: ApiErrorDTO = {
        error: {
          code: "FORBIDDEN",
          message: "You don't have permission to access this resource",
        },
      };
      return new Response(JSON.stringify(apiError), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Handle unexpected errors
    console.error("Failed to list share links", {
      event_id: params.event_id,
      user_id: user.id,
      error: error.message,
      stack: error.stack,
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

### Step 3: Update Middleware (if needed)

**File**: `src/middleware/index.ts`

Ensure middleware:

1. Extracts JWT from Authorization header
2. Creates authenticated Supabase client
3. Attaches user to `locals.user`
4. Attaches supabase client to `locals.supabase`

If not already implemented, add:

```typescript
import { defineMiddleware } from "astro:middleware";
import { createServerClient } from "../db/supabase.client";

export const onRequest = defineMiddleware(async ({ request, locals }, next) => {
  // Extract token from Authorization header
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");

  // Create Supabase client
  const supabase = createServerClient(token);

  // Get user if authenticated
  let user = null;
  if (token) {
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser();
    user = authUser;
  }

  // Attach to locals
  locals.supabase = supabase;
  locals.user = user;

  return next();
});
```

### Step 4: Create Database Indexes (if not exist)

**File**: `supabase/migrations/YYYYMMDDHHMMSS_add_share_links_indexes.sql`

```sql
-- Index for event_id filtering (likely exists from FK)
CREATE INDEX IF NOT EXISTS idx_share_links_event_id
ON share_links(event_id);

-- Composite index for event + active filtering
CREATE INDEX IF NOT EXISTS idx_share_links_event_id_revoked_at
ON share_links(event_id, revoked_at);

-- Index for created_at ordering
CREATE INDEX IF NOT EXISTS idx_share_links_created_at
ON share_links(created_at DESC);
```

### Step 5: Update TypeScript Types (if needed)

Verify `src/middleware/index.ts` has proper type declarations for `locals`:

```typescript
// In src/middleware/index.ts or env.d.ts
declare namespace App {
  interface Locals {
    supabase: SupabaseClient;
    user: User | null;
  }
}
```

### Step 6: Write Unit Tests

**File**: `src/lib/services/__tests__/share-link.service.test.ts`

Test cases:

- `verifyEventOwnership`: valid owner, non-owner, deleted event, non-existent event
- `computeShareLinkUrl`: correct URL formation
- `listShareLinks`: no filter, active=true, active=false, empty results

**File**: `src/pages/api/events/[event_id]/share-links/__tests__/index.test.ts`

Test cases:

- Valid request returns 200 with array
- Invalid event_id returns 400
- Invalid active param returns 400
- Non-existent event returns 404
- Non-owner returns 403
- Unauthenticated returns 401
- Active filter works correctly

### Step 7: Integration Testing

Manual testing checklist:

- [ ] Create test event and share links (some active, some revoked)
- [ ] GET without filter returns all links
- [ ] GET with active=true returns only non-revoked
- [ ] GET with active=false returns only revoked
- [ ] Non-owner receives 403
- [ ] Invalid UUID receives 400
- [ ] Deleted event returns 404

### Step 8: Update API Documentation

Update API documentation with:

- Endpoint path and method
- Parameters (path, query, headers)
- Request/response examples
- Error codes and meanings
- Security requirements

---

## Summary

This implementation plan provides a comprehensive guide for implementing the `GET /api/events/{event_id}/share-links` endpoint. The endpoint follows REST best practices, implements proper security controls, and maintains consistency with the application's architecture and coding standards.

Key implementation highlights:

- Service layer pattern for business logic separation
- Comprehensive input validation with Zod
- Proper error handling with structured error responses
- Performance optimization through database indexing
- Security through authentication, authorization, and input validation
- Clear separation of concerns between route handler, service, and data layers
