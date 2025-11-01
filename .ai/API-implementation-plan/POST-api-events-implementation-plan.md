# API Endpoint Implementation Plan: POST /api/events

## 1. Endpoint Overview

Creates a new wedding event (seating plan) for the authenticated user. This endpoint initializes an empty event with a configurable grid canvas and default settings. The event owner can subsequently add tables, guests, and configure seating arrangements through other API endpoints.

**Key Responsibilities:**

- Validate and authenticate the requesting user
- Create a new event record with owner association
- Initialize empty plan_data structure with default settings
- Log event creation for audit and analytics purposes
- Return the complete event object for immediate client use

## 2. Request Details

- **HTTP Method**: POST
- **URL Structure**: `/api/events`
- **Authentication**: Required (Supabase session)
- **Content-Type**: `application/json`

### Parameters

**Required (in request body):**

- `name`: string (1-150 characters) - Display name for the event
- `grid_rows`: number (integer > 0) - Canvas grid height
- `grid_cols`: number (integer > 0) - Canvas grid width

**Optional (in request body):**

- `event_date`: string (YYYY-MM-DD format) or null - Scheduled event date

### Request Body Example

```json
{
  "name": "Sarah & John's Wedding",
  "event_date": "2026-06-15",
  "grid_rows": 20,
  "grid_cols": 30
}
```

## 3. Used Types

### Request Type

```typescript
interface CreateEventCommand {
  name: string;
  event_date?: string | null;
  grid_rows: number;
  grid_cols: number;
}
```

### Response Type

```typescript
interface EventDTO {
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
```

### Error Response Type

```typescript
interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Internal Service Types

```typescript
interface CreateEventParams {
  owner_id: UUID;
  name: string;
  event_date: string | null;
  grid_rows: number;
  grid_cols: number;
}
```

## 4. Response Details

### Success Response (201 Created)

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "owner_id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "name": "Sarah & John's Wedding",
  "event_date": "2026-06-15",
  "grid": { "rows": 20, "cols": 30 },
  "plan_data": {
    "tables": [],
    "guests": [],
    "settings": { "color_palette": "default" }
  },
  "autosave_version": 0,
  "lock": { "held_by": null, "expires_at": null },
  "created_at": "2025-11-01T14:30:00.000Z",
  "updated_at": "2025-11-01T14:30:00.000Z"
}
```

### Error Responses

**400 Bad Request - INVALID_EVENT_INPUT**

```json
{
  "error": {
    "code": "INVALID_EVENT_INPUT",
    "message": "Invalid event input: name must be between 1 and 150 characters",
    "details": {
      "field": "name",
      "constraint": "length"
    }
  }
}
```

**401 Unauthorized**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

**500 Internal Server Error**

```json
{
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "An unexpected error occurred while creating the event"
  }
}
```

## 5. Data Flow

### Step-by-Step Process

1. **Request Reception**
   - Astro API route handler receives POST request
   - Route is configured with `export const prerender = false`

2. **Authentication Check**
   - Extract Supabase client from `context.locals` (injected by middleware)
   - Retrieve authenticated user session via `supabase.auth.getUser()`
   - If no valid session, return 401 Unauthorized

3. **Input Validation**
   - Parse request body JSON
   - Validate against Zod schema:
     - `name`: non-empty string, max 150 chars
     - `event_date`: optional, valid YYYY-MM-DD or null
     - `grid_rows`: positive integer
     - `grid_cols`: positive integer
   - Apply additional business rules (e.g., max grid dimensions)
   - If validation fails, return 400 with detailed error

4. **Service Layer Invocation**
   - Call `eventService.createEvent(supabase, userId, validatedCommand)`
   - Service constructs database insert parameters

5. **Database Insertion**
   - Insert new row into `events` table with:
     - Auto-generated `id` (uuid default)
     - `owner_id` from authenticated user
     - Validated fields from command
     - `plan_data` initialized as `{"tables":[],"guests":[],"settings":{"color_palette":"default"}}`
     - `autosave_version` = 0
     - `created_at`, `updated_at` auto-generated
     - All lock fields null
   - Use Supabase client `.insert()` with `.select()` to return created row

6. **Audit Logging**
   - Insert into `audit_log`:
     - `event_id`: newly created event ID
     - `user_id`: authenticated user
     - `action_type`: 'event_created'
     - `details`: JSON with event metadata
   - Insert into `analytics_events`:
     - `event_type`: 'event_created'
     - `event_id`: newly created event ID
     - `user_id`: authenticated user

7. **Response Mapping**
   - Map database row to `EventDTO` structure:
     - Combine `grid_rows` and `grid_cols` into `grid` object
     - Parse `plan_data` JSONB to typed structure
     - Extract lock information into `lock` object
     - Format timestamps as ISO8601 strings
   - Return 201 Created with EventDTO body

### Database Interaction Pattern

```typescript
// Insert event
const { data: eventRow, error } = await supabase
  .from("events")
  .insert({
    owner_id: userId,
    name: command.name,
    event_date: command.event_date ?? null,
    grid_rows: command.grid_rows,
    grid_cols: command.grid_cols,
    plan_data: {
      tables: [],
      guests: [],
      settings: { color_palette: "default" },
    },
    autosave_version: 0,
  })
  .select()
  .single();

// Insert audit log
await supabase.from("audit_log").insert({
  event_id: eventRow.id,
  user_id: userId,
  action_type: "event_created",
  details: { name: command.name, grid_rows: command.grid_rows, grid_cols: command.grid_cols },
});
```

## 6. Security Considerations

### Authentication & Authorization

- **Session Validation**: Verify valid Supabase session exists before processing
- **User Identity**: Extract user ID from authenticated session (not from request body)
- **Ownership**: Automatically set `owner_id` from authenticated user to prevent privilege escalation

### Input Validation & Sanitization

- **Type Safety**: Use Zod schema validation to enforce strict typing
- **Length Constraints**: Enforce 1-150 character limit on `name` to prevent oversized data
- **Range Validation**: Ensure `grid_rows` and `grid_cols` are positive integers
- **Upper Bounds**: Consider maximum grid dimensions (e.g., 100×100) to prevent resource exhaustion
- **Date Format**: Validate event_date follows YYYY-MM-DD pattern if provided
- **XSS Prevention**: While stored as-is, validation prevents extremely malicious patterns

### Rate Limiting & Abuse Prevention

- **Event Creation Limit**: Consider implementing per-user daily/hourly limits (future enhancement)
- **Grid Size DoS**: Maximum grid dimensions prevent memory/storage abuse
- **Malformed Requests**: Early validation prevents wasted database resources

### Data Privacy

- **PII Handling**: Event name may contain PII; ensure GDPR/CCPA compliance documented
- **Consent**: Consider requiring consent checkbox for event creation (future)

### CORS & CSRF

- **CORS Configuration**: Ensure proper origin restrictions in Astro config
- **Content-Type Enforcement**: Accept only `application/json`

## 7. Error Handling

### Client Errors (4xx)

| Status | Error Code          | Scenario                  | Response Message                                  |
| ------ | ------------------- | ------------------------- | ------------------------------------------------- |
| 400    | INVALID_EVENT_INPUT | Missing required field    | "Missing required field: {field_name}"            |
| 400    | INVALID_EVENT_INPUT | Name empty or too long    | "Event name must be between 1 and 150 characters" |
| 400    | INVALID_EVENT_INPUT | grid_rows ≤ 0             | "Grid rows must be a positive integer"            |
| 400    | INVALID_EVENT_INPUT | grid_cols ≤ 0             | "Grid columns must be a positive integer"         |
| 400    | INVALID_EVENT_INPUT | Grid dimensions too large | "Grid dimensions must not exceed 100×100"         |
| 400    | INVALID_EVENT_INPUT | Invalid date format       | "Event date must be in YYYY-MM-DD format"         |
| 400    | INVALID_EVENT_INPUT | Malformed JSON            | "Invalid JSON in request body"                    |
| 401    | UNAUTHORIZED        | No session token          | "Authentication required"                         |
| 401    | UNAUTHORIZED        | Expired session           | "Session expired, please log in again"            |

### Server Errors (5xx)

| Status | Error Code            | Scenario                           | Response Message                                        |
| ------ | --------------------- | ---------------------------------- | ------------------------------------------------------- |
| 500    | INTERNAL_SERVER_ERROR | Database connection failure        | "Unable to connect to database"                         |
| 500    | INTERNAL_SERVER_ERROR | Unexpected DB constraint violation | "An unexpected error occurred while creating the event" |
| 500    | INTERNAL_SERVER_ERROR | Audit log insertion failure        | "Event created but logging failed" (still return 201)   |

### Error Response Format

All errors follow the `ApiErrorDTO` structure:

```typescript
return new Response(
  JSON.stringify({
    error: {
      code: "INVALID_EVENT_INPUT",
      message: "Event name must be between 1 and 150 characters",
      details: { field: "name", provided_length: 200 },
    },
  }),
  { status: 400, headers: { "Content-Type": "application/json" } }
);
```

### Error Logging Strategy

- **Client Errors (400)**: Log to console.warn with sanitized input for debugging
- **Auth Errors (401)**: Log attempt with timestamp, no PII
- **Server Errors (500)**: Log full stack trace with context, alert monitoring system
- **Audit Log Failures**: Log separately but don't block event creation (best-effort logging)

## 8. Performance Considerations

### Potential Bottlenecks

- **Database Write Latency**: Event creation involves multiple tables (events, audit_log, analytics_events)
- **JSONB Initialization**: Minimal impact as default plan_data is small
- **Session Validation**: Requires network call to Supabase auth service

### Optimization Strategies

- **Async Logging**: Audit and analytics logging can be fire-and-forget (non-blocking)
- **Connection Pooling**: Supabase client handles this automatically
- **Index Usage**: Ensure `events.owner_id` is indexed for future queries
- **Minimal Validation**: Validate only what's necessary for data integrity

### Expected Performance

- **Target Response Time**: < 200ms for P95
- **Database Operations**: 1-3 writes (event + audit logs)
- **Payload Size**: ~500 bytes request, ~1KB response

### Scalability Notes

- **Horizontal Scaling**: Stateless endpoint, scales linearly with instances
- **Database Growth**: Events table will grow; partition by owner_id or created_at if needed (future)
- **Monitoring**: Track event_created count and latency distribution

## 9. Implementation Steps

### Step 1: Create Zod Validation Schema

**File**: `src/lib/schemas/eventSchemas.ts` (new file)

```typescript
import { z } from "zod";

export const createEventSchema = z.object({
  name: z.string().min(1, "Event name is required").max(150, "Event name must not exceed 150 characters"),
  event_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Event date must be in YYYY-MM-DD format")
    .nullable()
    .optional(),
  grid_rows: z
    .number()
    .int()
    .positive("Grid rows must be a positive integer")
    .max(100, "Grid rows must not exceed 100"),
  grid_cols: z
    .number()
    .int()
    .positive("Grid columns must be a positive integer")
    .max(100, "Grid columns must not exceed 100"),
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
```

### Step 2: Create Event Service

**File**: `src/lib/services/eventService.ts` (new file)

```typescript
import type { SupabaseClient } from "@/db/supabase.client";
import type { EventDTO, CreateEventCommand, UUID, PlanDataDTO } from "@/types";
import type { Tables } from "@/db/database.types";

export class EventService {
  async createEvent(supabase: SupabaseClient, userId: UUID, command: CreateEventCommand): Promise<EventDTO> {
    // Insert event
    const { data: eventRow, error: insertError } = await supabase
      .from("events")
      .insert({
        owner_id: userId,
        name: command.name,
        event_date: command.event_date ?? null,
        grid_rows: command.grid_rows,
        grid_cols: command.grid_cols,
        plan_data: {
          tables: [],
          guests: [],
          settings: { color_palette: "default" },
        },
        autosave_version: 0,
      })
      .select()
      .single();

    if (insertError || !eventRow) {
      throw new Error(`Failed to create event: ${insertError?.message}`);
    }

    // Log audit entry (best-effort, non-blocking)
    supabase
      .from("audit_log")
      .insert({
        event_id: eventRow.id,
        user_id: userId,
        action_type: "event_created",
        details: {
          name: command.name,
          grid_rows: command.grid_rows,
          grid_cols: command.grid_cols,
        },
      })
      .then(({ error }) => {
        if (error) console.warn("Audit log insertion failed:", error);
      });

    // Log analytics event (best-effort, non-blocking)
    supabase
      .from("analytics_events")
      .insert({
        event_type: "event_created",
        event_id: eventRow.id,
        user_id: userId,
        metadata: null,
      })
      .then(({ error }) => {
        if (error) console.warn("Analytics event logging failed:", error);
      });

    return this.mapRowToDTO(eventRow);
  }

  private mapRowToDTO(row: Tables<"events">): EventDTO {
    return {
      id: row.id,
      owner_id: row.owner_id,
      name: row.name,
      event_date: row.event_date,
      grid: {
        rows: row.grid_rows,
        cols: row.grid_cols,
      },
      plan_data: row.plan_data as PlanDataDTO,
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
}

export const eventService = new EventService();
```

### Step 3: Create API Route Handler

**File**: `src/pages/api/events.ts` (new file)

```typescript
import type { APIRoute } from "astro";
import { eventService } from "@/lib/services/eventService";
import { createEventSchema } from "@/lib/schemas/eventSchemas";
import type { ApiErrorDTO, EventDTO } from "@/types";

export const prerender = false;

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    // 1. Authentication check
    const supabase = locals.supabase;
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

    // 2. Parse request body
    let body;
    try {
      body = await request.json();
    } catch {
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "INVALID_EVENT_INPUT",
          message: "Invalid JSON in request body",
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Validate input
    const validationResult = createEventSchema.safeParse(body);
    if (!validationResult.success) {
      const firstError = validationResult.error.errors[0];
      const errorResponse: ApiErrorDTO = {
        error: {
          code: "INVALID_EVENT_INPUT",
          message: firstError.message,
          details: {
            field: firstError.path.join("."),
            issue: firstError.code,
          },
        },
      };
      return new Response(JSON.stringify(errorResponse), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. Create event via service
    const event: EventDTO = await eventService.createEvent(supabase, user.id, validationResult.data);

    // 5. Return success response
    return new Response(JSON.stringify(event), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error creating event:", error);
    const errorResponse: ApiErrorDTO = {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred while creating the event",
      },
    };
    return new Response(JSON.stringify(errorResponse), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
```

### Step 4: Update Middleware (if needed)

**File**: `src/middleware/index.ts`

Ensure Supabase client is properly injected into `context.locals`:

```typescript
import { defineMiddleware } from "astro:middleware";
import { createSupabaseClient } from "@/db/supabase.client";

export const onRequest = defineMiddleware(async (context, next) => {
  // Initialize Supabase client and attach to locals
  context.locals.supabase = createSupabaseClient(context.request);

  return next();
});
```

### Step 5: Add Error Helper Utilities (Optional)

**File**: `src/lib/utils/apiErrors.ts` (new file)

```typescript
import type { ApiErrorDTO } from "@/types";

export function createErrorResponse(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>
): Response {
  const errorBody: ApiErrorDTO = {
    error: { code, message, details },
  };
  return new Response(JSON.stringify(errorBody), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function unauthorized(message = "Authentication required"): Response {
  return createErrorResponse("UNAUTHORIZED", message, 401);
}

export function badRequest(message: string, details?: Record<string, unknown>): Response {
  return createErrorResponse("INVALID_EVENT_INPUT", message, 400, details);
}

export function internalError(message = "An unexpected error occurred"): Response {
  return createErrorResponse("INTERNAL_SERVER_ERROR", message, 500);
}
```

Then simplify the API route by using these helpers.

### Step 6: Write Unit Tests

**File**: `src/lib/services/eventService.test.ts` (new file)

Test scenarios:

- Event creation with all required fields
- Event creation with optional event_date
- Event creation with null event_date
- Proper plan_data initialization
- Correct DTO mapping
- Error handling for database failures

### Step 7: Write Integration Tests

**File**: `tests/api/events.test.ts` (new file)

Test scenarios:

- POST with valid data returns 201
- POST without auth returns 401
- POST with missing name returns 400
- POST with invalid grid_rows returns 400
- POST with invalid grid_cols returns 400
- POST with invalid date format returns 400
- POST with name > 150 chars returns 400
- Verify audit log entry created
- Verify analytics event logged

### Step 8: Update API Documentation

**File**: `.ai/api-plan.md`

Mark POST /api/events as implemented and document any deviations from original spec.

### Step 9: Manual Testing Checklist

- [ ] Test with Postman/Thunder Client using valid auth token
- [ ] Verify 201 response with complete EventDTO
- [ ] Confirm event appears in Supabase dashboard
- [ ] Verify audit_log entry exists
- [ ] Verify analytics_events entry exists
- [ ] Test error cases (no auth, invalid input)
- [ ] Verify CORS headers if frontend on different origin
- [ ] Test with edge cases (very long names, huge grids)

### Step 10: Deployment & Monitoring

- Deploy to staging environment
- Monitor error rates and response times
- Set up alerts for 500 errors
- Verify database indexes on events.owner_id
- Document any production issues and resolutions

---

## Additional Notes

### Database Indexes Required

Ensure the following indexes exist (should be in migrations):

- `events.owner_id` (for future GET /api/events queries)
- `events.id` (primary key, auto-indexed)
- `audit_log.event_id` (for audit trail queries)

### Future Enhancements

- Implement rate limiting per user
- Add event templates for quick creation
- Support bulk event creation
- Add webhook notifications for event creation
- Implement soft quotas (max events per user tier)

### Related Endpoints

After implementing POST /api/events, consider:

- GET /api/events (list user's events)
- GET /api/events/:id (retrieve single event)
- PATCH /api/events/:id (update event metadata)
- DELETE /api/events/:id (soft delete event)
