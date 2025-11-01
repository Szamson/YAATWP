# API Endpoint Implementation Plan: POST /api/events/{event_id}/plan/guests

## 1. Endpoint Overview

This endpoint creates a new guest entry within an event's embedded `plan_data` JSONB structure. Guests are stored in the `plan_data.guests` array within the `events` table (not as separate database rows). The endpoint generates a unique guest ID, validates input according to PRD constraints, increments the autosave version for concurrency control, creates an audit log entry, and returns the newly created guest object.

**Primary Use Cases**:

- Manual guest addition by event owner via UI
- Programmatic guest creation before bulk import
- Single guest quick-add workflows

**Key Characteristics**:

- Transactional: All changes (plan_data update, version increment, audit log) occur atomically
- Idempotent: Optional `Idempotency-Key` header prevents duplicate creation on network retries
- Concurrency-safe: Uses optimistic locking via `If-Match` header with `autosave_version`
- Audit-tracked: Creates `guest_add` audit log entry with guest metadata

---

## 2. Request Details

### HTTP Method

`POST`

### URL Structure

```
POST /api/events/{event_id}/plan/guests
```

### Path Parameters

| Parameter  | Type | Required | Constraints          | Description                                |
| ---------- | ---- | -------- | -------------------- | ------------------------------------------ |
| `event_id` | UUID | Yes      | Valid UUID v4 format | The event to which the guest will be added |

### Headers

| Header            | Required | Format                         | Description                                           |
| ----------------- | -------- | ------------------------------ | ----------------------------------------------------- |
| `Authorization`   | Yes      | `Bearer <supabase_jwt>`        | Supabase authentication token                         |
| `Content-Type`    | Yes      | `application/json`             | Request content type                                  |
| `If-Match`        | Optional | `<autosave_version>` (integer) | Current autosave version for optimistic locking       |
| `Idempotency-Key` | Optional | UUID v4                        | Prevents duplicate creation on retry (24-hour window) |

### Request Body

**Type**: `AddGuestCommand` (from `types.ts`)

```typescript
type AddGuestCommand = Omit<GuestDTO, "id">;
```

**JSON Schema**:

```json
{
  "name": "Alice Smith", // REQUIRED: 1-150 chars, non-empty after trim
  "note": "Vegan, nut allergy", // OPTIONAL: max 500 chars
  "tag": "Family", // OPTIONAL: max 50 chars (group label)
  "rsvp": "Yes" // OPTIONAL: max 20 chars (e.g., Yes/No/Maybe)
}
```

**Validation Rules** (enforced via Zod schema):

1. **name** (REQUIRED):
   - Type: `string`
   - Minimum length: 1 (after trimming whitespace)
   - Maximum length: 150 characters
   - Transformation: Trim leading/trailing whitespace
   - Error if empty or whitespace-only

2. **note** (OPTIONAL):
   - Type: `string` or `undefined`
   - Maximum length: 500 characters
   - Use case: Dietary restrictions, accessibility needs, seating preferences

3. **tag** (OPTIONAL):
   - Type: `string` or `undefined`
   - Maximum length: 50 characters
   - Use case: Group categorization (e.g., "Family", "Groom's Friends", "Colleagues")

4. **rsvp** (OPTIONAL):
   - Type: `string` or `undefined`
   - Maximum length: 20 characters
   - Common values: "Yes", "No", "Maybe", "Pending" (not enforced as enum in MVP)
   - Case-insensitive storage recommended (normalize to title case)

---

## 3. Used Types

### Command Models

- **`AddGuestCommand`** (`types.ts`): Input validation model
  ```typescript
  type AddGuestCommand = Omit<GuestDTO, "id">;
  ```

### Response DTOs

- **`GuestDTO`** (`types.ts`): Output response model
  ```typescript
  interface GuestDTO {
    id: string;
    name: string;
    note?: string;
    tag?: string;
    rsvp?: string;
  }
  ```

### Internal Types

- **`PlanDataDTO`** (`types.ts`): Full plan data structure containing guests array
- **`DBEventRow`** (from `Tables<"events">`): Database row type for events table
- **`SupabaseClient`** (`src/db/supabase.client.ts`): Typed Supabase client

### Database Enums

- **`action_type_enum`**: `'guest_add'` value for audit logging

---

## 4. Response Details

### Success Response (201 Created)

**HTTP Status**: `201 Created`

**Headers**:

```
Content-Type: application/json
ETag: "<new_autosave_version>"
```

**Body**: `GuestDTO`

```json
{
  "id": "g_a1b2c3d4e5f6",
  "name": "Alice Smith",
  "note": "Vegan, nut allergy",
  "tag": "Family",
  "rsvp": "Yes"
}
```

**Fields**:

- `id`: Server-generated unique identifier (UUID v4 or nanoid with `g_` prefix)
- `name`: Trimmed guest name as submitted
- `note`: Optional note (omitted from response if not provided)
- `tag`: Optional group tag
- `rsvp`: Optional RSVP status

---

### Error Responses

All error responses follow the `ApiErrorDTO` structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description",
    "details": {
      /* optional structured metadata */
    }
  }
}
```

| HTTP Status | Error Code             | Scenario                                   | Message Example                                                                          |
| ----------- | ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| **400**     | `INVALID_INPUT`        | Malformed JSON or schema violation         | "Invalid request body: name is required"                                                 |
| **400**     | `INVALID_GUEST_NAME`   | Empty name or exceeds 150 chars            | "Guest name must be between 1 and 150 characters"                                        |
| **400**     | `INVALID_FIELD_LENGTH` | note/tag/rsvp exceeds max length           | "Note exceeds maximum length of 500 characters"                                          |
| **401**     | `UNAUTHORIZED`         | Missing or invalid JWT token               | "Authentication required"                                                                |
| **403**     | `FORBIDDEN`            | User is not event owner                    | "You do not have permission to modify this event"                                        |
| **404**     | `EVENT_NOT_FOUND`      | Event doesn't exist or soft-deleted        | "Event not found or has been deleted"                                                    |
| **409**     | `VERSION_CONFLICT`     | If-Match header mismatch                   | "Event has been modified by another user. Please refresh and retry."                     |
| **409**     | `EVENT_LOCKED`         | Event locked by another user               | "Event is currently being edited by another user (lock expires at 2025-11-01T14:30:00Z)" |
| **409**     | `GUEST_LIMIT_EXCEEDED` | Maximum guest count reached                | "Event has reached the maximum guest limit of 5000"                                      |
| **409**     | `IDEMPOTENCY_CONFLICT` | Idempotency key reused with different data | "Idempotency key already used for a different request"                                   |
| **500**     | `INTERNAL_ERROR`       | Database error or unexpected failure       | "An unexpected error occurred. Please try again."                                        |

**Error Response Examples**:

**400 - Invalid Name**:

```json
{
  "error": {
    "code": "INVALID_GUEST_NAME",
    "message": "Guest name must be between 1 and 150 characters",
    "details": {
      "field": "name",
      "provided_length": 0,
      "max_length": 150
    }
  }
}
```

**409 - Version Conflict**:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Event has been modified by another user. Please refresh and retry.",
    "details": {
      "expected_version": 5,
      "current_version": 7
    }
  }
}
```

---

## 5. Data Flow

### High-Level Flow

```
Client Request
    ↓
[1] API Route Handler (/api/events/[event_id]/plan/guests.ts)
    ↓
[2] Middleware: JWT Authentication (context.locals.supabase)
    ↓
[3] Input Validation (Zod schema)
    ↓
[4] Service Layer (src/lib/services/plan.service.ts)
    ├─ [4a] Fetch Event & Ownership Check
    ├─ [4b] Soft Lock Validation
    ├─ [4c] Version Conflict Check (If-Match)
    ├─ [4d] Guest Limit Validation
    ├─ [4e] Generate Guest ID
    ├─ [4f] Update plan_data.guests Array
    ├─ [4g] Increment autosave_version
    ├─ [4h] Persist to Database (Transaction)
    └─ [4i] Create Audit Log Entry
    ↓
[5] Return GuestDTO (201)
```

### Detailed Steps

#### Step 1: API Route Handler

- **File**: `src/pages/api/events/[event_id]/plan/guests.ts`
- **Exports**: `export const prerender = false`
- **Handler**: `export async function POST(context: APIContext)`
- **Responsibilities**:
  - Extract `event_id` from path parameters
  - Extract headers (`Authorization`, `If-Match`, `Idempotency-Key`)
  - Parse JSON body
  - Delegate to service layer
  - Transform service response to HTTP response

#### Step 2: Authentication & Authorization

- **Source**: `context.locals.supabase` (injected by middleware)
- **Actions**:
  - Call `supabase.auth.getUser()` to retrieve authenticated user
  - Return 401 if no valid session
  - Extract `user.id` for ownership checks

#### Step 3: Input Validation

- **Tool**: Zod schema (`addGuestSchema`)
- **Schema Definition**:
  ```typescript
  const addGuestSchema = z.object({
    name: z.string().trim().min(1, "Name is required").max(150, "Name too long"),
    note: z.string().max(500).optional(),
    tag: z.string().max(50).optional(),
    rsvp: z.string().max(20).optional(),
  });
  ```
- **Error Handling**: Return 400 with validation error details if schema parse fails

#### Step 4: Service Layer Processing

**Service**: `PlanService.addGuest()`

**Sub-steps**:

**4a. Fetch Event & Ownership Check**:

```sql
SELECT id, owner_id, plan_data, autosave_version, lock_held_by, lock_expires_at, deleted_at
FROM events
WHERE id = $1
```

- Return 404 if no row or `deleted_at IS NOT NULL`
- Return 403 if `owner_id != user.id`

**4b. Soft Lock Validation**:

- Check `lock_held_by` and `lock_expires_at`
- If lock held by another user AND not expired:
  - Return 409 `EVENT_LOCKED` with lock details
- If lock expired: treat as unlocked (implicit release)

**4c. Version Conflict Check**:

- If `If-Match` header provided:
  - Compare header value to `event.autosave_version`
  - Return 409 `VERSION_CONFLICT` if mismatch
- Best practice: Clients should always provide `If-Match` for data integrity

**4d. Guest Limit Validation** (optional but recommended):

- Check `plan_data.guests.length`
- If exceeds configurable limit (e.g., 5000):
  - Return 409 `GUEST_LIMIT_EXCEEDED`
- Prevents abuse and performance degradation

**4e. Generate Guest ID**:

- Use `crypto.randomUUID()` or `nanoid()` with prefix `g_`
- Ensure uniqueness within `plan_data.guests` array
- Retry on collision (unlikely with UUID v4)

**4f. Update plan_data.guests Array**:

```typescript
const newGuest: GuestDTO = {
  id: generatedId,
  name: validatedInput.name,
  note: validatedInput.note,
  tag: validatedInput.tag,
  rsvp: validatedInput.rsvp,
};

const updatedPlanData = {
  ...event.plan_data,
  guests: [...event.plan_data.guests, newGuest],
};
```

**4g. Increment autosave_version**:

```typescript
const newVersion = event.autosave_version + 1;
```

**4h. Persist to Database (Transaction)**:

```sql
UPDATE events
SET
  plan_data = $1,
  autosave_version = $2,
  updated_at = NOW()
WHERE id = $3
  AND autosave_version = $4  -- Optimistic lock
RETURNING *;
```

- If `RETURNING` yields no rows: version conflict occurred (return 409)
- Use Supabase transaction if bundling with audit log insert

**4i. Create Audit Log Entry**:

```sql
INSERT INTO audit_log (event_id, user_id, action_type, details)
VALUES ($1, $2, 'guest_add', $3::jsonb);
```

- `details` JSON:
  ```json
  {
    "guest_id": "g_a1b2c3d4",
    "guest_name": "Alice Smith",
    "tag": "Family",
    "autosave_version": 6
  }
  ```

#### Step 5: Return Response

- HTTP 201 Created
- `ETag` header: new `autosave_version`
- Body: `GuestDTO` (the newly created guest)

---

### Idempotency Handling (Optional Advanced Feature)

**Mechanism**:

- Client provides `Idempotency-Key: <uuid>` header
- Server stores mapping in cache or database table:
  - `idempotency_keys(key UUID, user_id UUID, endpoint TEXT, response_body JSONB, created_at TIMESTAMPTZ)`
- TTL: 24 hours (after which key can be reused)

**Logic**:

1. Check if `Idempotency-Key` exists for this user + endpoint
2. If exists:
   - If request body matches stored request: return stored response (201 with same guest)
   - If request body differs: return 409 `IDEMPOTENCY_CONFLICT`
3. If not exists: proceed with guest creation and store key + response

**Implementation Complexity**: Medium (requires Redis or database table for key storage)

---

## 6. Security Considerations

### Authentication

- **Mechanism**: Supabase JWT in `Authorization: Bearer <token>` header
- **Validation**: Performed by Astro middleware (`src/middleware/index.ts`)
- **Session**: Extract user via `context.locals.supabase.auth.getUser()`
- **Failure**: Return 401 `UNAUTHORIZED` if token missing/invalid/expired

### Authorization

- **Rule**: Only the event owner (`events.owner_id`) can add guests
- **Check**: Compare `event.owner_id` with `authenticated_user.id`
- **Failure**: Return 403 `FORBIDDEN` if mismatch
- **Future**: Support collaborators via `event_collaborators` table (out of scope for MVP)

### Input Sanitization

- **XSS Prevention**:
  - Validate input with Zod (type + length checks)
  - Do NOT render user input as raw HTML in frontend
  - Use React's built-in escaping (it escapes by default)
- **SQL Injection**:
  - Use parameterized queries via Supabase client (prevents injection)
  - Never concatenate user input into SQL strings

### PII Handling (GDPR/CCPA Compliance)

- **Guest Names**: Considered PII (Personally Identifiable Information)
- **Notes Field**: May contain sensitive data (medical, dietary, accessibility needs)
- **Responsibilities**:
  - Inform users that guest data is PII (consent during import, see `import_consent` table)
  - Implement data export (DSAR) via `/api/data-requests` endpoint
  - Support deletion via soft-delete or hard-delete on request
  - Ensure share links respect `include_pii` flag (sanitize notes if false)

### Rate Limiting

- **Recommended Limits**:
  - Per-user: 60 requests/minute for guest creation
  - Per-event: 1000 guests/hour (prevent bulk abuse)
- **Implementation**: Use middleware with in-memory counter or Redis
- **Response**: 429 `TOO_MANY_REQUESTS` with `Retry-After` header

### Soft Lock Enforcement

- **Purpose**: Prevent conflicting edits when lock held by another user
- **Check**: Validate `lock_held_by` and `lock_expires_at` before allowing mutation
- **Bypass**: If lock expired, treat as unlocked (auto-release)
- **Response**: 409 `EVENT_LOCKED` if another user holds active lock

### Version Conflict Handling

- **Mechanism**: Optimistic locking via `autosave_version`
- **Client Responsibility**: Include `If-Match: <version>` header
- **Server Validation**: Compare header to current DB version
- **Failure**: Return 409 `VERSION_CONFLICT` with current version in response

---

## 7. Error Handling

### Validation Errors (400 Bad Request)

**Scenario**: Zod schema validation fails

**Examples**:

- Empty name: `{ "code": "INVALID_GUEST_NAME", "message": "Name is required" }`
- Name too long: `{ "code": "INVALID_GUEST_NAME", "message": "Name exceeds 150 characters" }`
- Invalid JSON: `{ "code": "INVALID_INPUT", "message": "Request body must be valid JSON" }`

**Implementation**:

```typescript
try {
  const validated = addGuestSchema.parse(await request.json());
} catch (err) {
  if (err instanceof z.ZodError) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Validation failed",
          details: err.errors,
        },
      }),
      { status: 400 }
    );
  }
}
```

### Authentication Errors (401 Unauthorized)

**Scenario**: Missing or invalid JWT token

**Response**:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

**Implementation**:

```typescript
const {
  data: { user },
  error,
} = await supabase.auth.getUser();
if (error || !user) {
  return new Response(
    JSON.stringify({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    }),
    { status: 401 }
  );
}
```

### Authorization Errors (403 Forbidden)

**Scenario**: User is not the event owner

**Response**:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to modify this event"
  }
}
```

**Implementation**:

```typescript
if (event.owner_id !== user.id) {
  return new Response(
    JSON.stringify({
      error: { code: "FORBIDDEN", message: "Permission denied" },
    }),
    { status: 403 }
  );
}
```

### Not Found Errors (404 Not Found)

**Scenario**: Event doesn't exist or is soft-deleted

**Response**:

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found or has been deleted"
  }
}
```

**Implementation**:

```typescript
const { data: event, error } = await supabase
  .from("events")
  .select("*")
  .eq("id", event_id)
  .is("deleted_at", null)
  .single();

if (error || !event) {
  return new Response(
    JSON.stringify({
      error: { code: "EVENT_NOT_FOUND", message: "Event not found" },
    }),
    { status: 404 }
  );
}
```

### Conflict Errors (409 Conflict)

**Scenarios**:

1. **Version Conflict**: `autosave_version` mismatch
2. **Event Locked**: Another user holds edit lock
3. **Guest Limit Exceeded**: Too many guests
4. **Idempotency Conflict**: Key reused with different data

**Response Examples**:

**Version Conflict**:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Event has been modified. Please refresh.",
    "details": {
      "expected_version": 5,
      "current_version": 7
    }
  }
}
```

**Event Locked**:

```json
{
  "error": {
    "code": "EVENT_LOCKED",
    "message": "Event is locked by another user",
    "details": {
      "locked_by": "user_uuid",
      "expires_at": "2025-11-01T14:30:00Z"
    }
  }
}
```

### Server Errors (500 Internal Server Error)

**Scenario**: Unexpected database error, network failure, or unhandled exception

**Response**:

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred. Please try again."
  }
}
```

**Logging**:

- Log full error details server-side (include stack trace, request ID)
- Do NOT expose internal error details to client (security risk)
- Use structured logging (e.g., Winston, Pino) for monitoring

**Implementation**:

```typescript
try {
  // ... service logic
} catch (err) {
  console.error("Error adding guest:", err);
  return new Response(
    JSON.stringify({
      error: { code: "INTERNAL_ERROR", message: "Unexpected error" },
    }),
    { status: 500 }
  );
}
```

---

## 8. Performance Considerations

### Database Query Optimization

**Concerns**:

- `plan_data` is JSONB and can grow large with many tables/guests
- Fetching full event row for every guest addition may be inefficient

**Optimizations**:

1. **Selective Column Retrieval**: Only fetch required columns
   ```sql
   SELECT id, owner_id, plan_data, autosave_version, lock_held_by, lock_expires_at
   FROM events WHERE id = $1
   ```
2. **JSONB Indexing**: Create GIN index on `plan_data` for faster queries (if filtering)

   ```sql
   CREATE INDEX idx_events_plan_data ON events USING GIN (plan_data);
   ```

3. **Connection Pooling**: Use Supabase connection pooler to handle concurrent requests

### JSONB Mutation Performance

**Concern**: JavaScript object spread (`{...planData, guests: [...]}`) creates full copy

**Impact**:

- Acceptable for MVP (events with <1000 guests perform well)
- May degrade at scale (10k+ guests in single event)

**Future Optimization** (post-MVP):

- Use PostgreSQL JSONB path operators for in-place updates:
  ```sql
  UPDATE events
  SET plan_data = jsonb_set(
    plan_data,
    '{guests}',
    plan_data->'guests' || $1::jsonb
  )
  WHERE id = $2
  ```
- Migrate to separate `guests` table with foreign key to `events.id`

### Audit Log Write Performance

**Concern**: Synchronous audit log insert adds latency

**Options**:

1. **Synchronous** (MVP): Insert in same transaction (ensures consistency)
2. **Asynchronous** (future): Queue audit writes via background job
   - Pros: Faster response times
   - Cons: Risk of lost logs on failure, eventual consistency

**Recommendation**: Use synchronous writes for MVP (simplicity + data integrity)

### Caching Strategy

**Guest Data**:

- Not cached (frequently mutated, requires latest data)
- Client-side caching via `ETag` header + HTTP 304 Not Modified for GETs

**Event Metadata**:

- Cache ownership checks in Redis (TTL: 5 minutes)
- Invalidate on event update/delete

### Concurrency Handling

**Challenge**: Multiple users adding guests simultaneously

**Solution**: Optimistic locking via `autosave_version`

- Database UPDATE includes `WHERE autosave_version = $expected`
- If no rows updated: version conflict (client must refresh and retry)

**Alternative** (not recommended for MVP): Pessimistic locking

- Acquire row-level lock with `SELECT ... FOR UPDATE`
- Higher contention, potential deadlocks

---

## 9. Implementation Steps

### Step 1: Create Zod Validation Schema

**File**: `src/lib/validation/guest.schema.ts`

```typescript
import { z } from "zod";

export const addGuestSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, { message: "Guest name is required" })
    .max(150, { message: "Guest name must not exceed 150 characters" }),

  note: z.string().max(500, { message: "Note must not exceed 500 characters" }).optional(),

  tag: z.string().max(50, { message: "Tag must not exceed 50 characters" }).optional(),

  rsvp: z.string().max(20, { message: "RSVP must not exceed 20 characters" }).optional(),
});

export type AddGuestInput = z.infer<typeof addGuestSchema>;
```

**Verification**:

- Test schema with valid/invalid inputs
- Ensure error messages are user-friendly

---

### Step 2: Create Service Layer Function

**File**: `src/lib/services/plan.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { AddGuestCommand, GuestDTO, UUID } from "../types";
import { randomUUID } from "crypto";

export class PlanService {
  constructor(private supabase: SupabaseClient) {}

  async addGuest(
    eventId: UUID,
    guestData: AddGuestCommand,
    userId: UUID,
    expectedVersion?: number
  ): Promise<{ guest: GuestDTO; newVersion: number }> {
    // 1. Fetch event with ownership check
    const { data: event, error: fetchError } = await this.supabase
      .from("events")
      .select("id, owner_id, plan_data, autosave_version, lock_held_by, lock_expires_at, deleted_at")
      .eq("id", eventId)
      .single();

    if (fetchError || !event) {
      throw new Error("EVENT_NOT_FOUND");
    }

    if (event.deleted_at) {
      throw new Error("EVENT_NOT_FOUND");
    }

    if (event.owner_id !== userId) {
      throw new Error("FORBIDDEN");
    }

    // 2. Check soft lock
    if (event.lock_held_by && event.lock_held_by !== userId) {
      const lockExpiry = new Date(event.lock_expires_at!);
      if (lockExpiry > new Date()) {
        throw new Error("EVENT_LOCKED", {
          locked_by: event.lock_held_by,
          expires_at: event.lock_expires_at,
        });
      }
    }

    // 3. Version conflict check
    if (expectedVersion !== undefined && event.autosave_version !== expectedVersion) {
      throw new Error("VERSION_CONFLICT", {
        expected: expectedVersion,
        current: event.autosave_version,
      });
    }

    // 4. Guest limit validation
    const currentGuestCount = event.plan_data.guests?.length || 0;
    if (currentGuestCount >= 5000) {
      throw new Error("GUEST_LIMIT_EXCEEDED");
    }

    // 5. Generate unique guest ID
    let guestId: string;
    let attempts = 0;
    do {
      guestId = `g_${randomUUID().slice(0, 8)}`;
      attempts++;
      if (attempts > 10) throw new Error("ID_GENERATION_FAILED");
    } while (event.plan_data.guests?.some((g) => g.id === guestId));

    // 6. Create new guest object
    const newGuest: GuestDTO = {
      id: guestId,
      name: guestData.name,
      ...(guestData.note && { note: guestData.note }),
      ...(guestData.tag && { tag: guestData.tag }),
      ...(guestData.rsvp && { rsvp: guestData.rsvp }),
    };

    // 7. Update plan_data
    const updatedPlanData = {
      ...event.plan_data,
      guests: [...(event.plan_data.guests || []), newGuest],
    };

    const newVersion = event.autosave_version + 1;

    // 8. Persist to database (with optimistic lock)
    const { data: updatedEvent, error: updateError } = await this.supabase
      .from("events")
      .update({
        plan_data: updatedPlanData,
        autosave_version: newVersion,
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .eq("autosave_version", event.autosave_version) // Optimistic lock
      .select()
      .single();

    if (updateError || !updatedEvent) {
      throw new Error("VERSION_CONFLICT"); // Another update occurred
    }

    // 9. Create audit log entry
    await this.supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "guest_add",
      details: {
        guest_id: guestId,
        guest_name: newGuest.name,
        tag: newGuest.tag,
        autosave_version: newVersion,
      },
    });

    return { guest: newGuest, newVersion };
  }
}
```

**Notes**:

- Error handling uses custom error classes (define in `src/lib/errors.ts`)
- Audit log insert is fire-and-forget (don't block on failure)
- Consider wrapping steps 8-9 in transaction for atomicity

---

### Step 3: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/plan/guests.ts`

```typescript
import type { APIContext } from "astro";
import { addGuestSchema } from "../../../../lib/validation/guest.schema";
import { PlanService } from "../../../../lib/services/plan.service";
import type { ApiErrorDTO, GuestDTO } from "../../../../types";
import { z } from "zod";

export const prerender = false;

export async function POST(context: APIContext): Promise<Response> {
  const { params, request, locals } = context;
  const supabase = locals.supabase;

  try {
    // 1. Authentication
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
        } satisfies ApiErrorDTO),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 2. Extract path parameter
    const eventId = params.event_id;
    if (!eventId) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Event ID is required",
          },
        } satisfies ApiErrorDTO),
        { status: 400 }
      );
    }

    // 3. Parse and validate request body
    let requestBody;
    try {
      requestBody = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid JSON in request body",
          },
        } satisfies ApiErrorDTO),
        { status: 400 }
      );
    }

    const validationResult = addGuestSchema.safeParse(requestBody);
    if (!validationResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Validation failed",
            details: validationResult.error.errors,
          },
        } satisfies ApiErrorDTO),
        { status: 400 }
      );
    }

    const guestData = validationResult.data;

    // 4. Extract If-Match header for version control
    const ifMatch = request.headers.get("If-Match");
    const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : undefined;

    // 5. Call service layer
    const planService = new PlanService(supabase);
    const { guest, newVersion } = await planService.addGuest(eventId, guestData, user.id, expectedVersion);

    // 6. Return success response
    return new Response(JSON.stringify(guest satisfies GuestDTO), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        ETag: newVersion.toString(),
      },
    });
  } catch (error) {
    // Error handling
    if (error instanceof Error) {
      switch (error.message) {
        case "EVENT_NOT_FOUND":
          return new Response(
            JSON.stringify({
              error: {
                code: "EVENT_NOT_FOUND",
                message: "Event not found or has been deleted",
              },
            } satisfies ApiErrorDTO),
            { status: 404 }
          );

        case "FORBIDDEN":
          return new Response(
            JSON.stringify({
              error: {
                code: "FORBIDDEN",
                message: "You do not have permission to modify this event",
              },
            } satisfies ApiErrorDTO),
            { status: 403 }
          );

        case "VERSION_CONFLICT":
          return new Response(
            JSON.stringify({
              error: {
                code: "VERSION_CONFLICT",
                message: "Event has been modified by another user. Please refresh and retry.",
              },
            } satisfies ApiErrorDTO),
            { status: 409 }
          );

        case "EVENT_LOCKED":
          return new Response(
            JSON.stringify({
              error: {
                code: "EVENT_LOCKED",
                message: "Event is currently being edited by another user",
              },
            } satisfies ApiErrorDTO),
            { status: 409 }
          );

        case "GUEST_LIMIT_EXCEEDED":
          return new Response(
            JSON.stringify({
              error: {
                code: "GUEST_LIMIT_EXCEEDED",
                message: "Event has reached the maximum guest limit",
              },
            } satisfies ApiErrorDTO),
            { status: 409 }
          );
      }
    }

    // Generic error
    console.error("Error adding guest:", error);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "An unexpected error occurred. Please try again.",
        },
      } satisfies ApiErrorDTO),
      { status: 500 }
    );
  }
}
```

**Verification**:

- Test with valid request (should return 201)
- Test with missing name (should return 400)
- Test with non-owner user (should return 403)
- Test with non-existent event (should return 404)

---

### Step 4: Create Custom Error Classes

**File**: `src/lib/errors.ts`

```typescript
export class PlanServiceError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PlanServiceError";
  }
}

export class EventNotFoundError extends PlanServiceError {
  constructor() {
    super("Event not found or has been deleted", "EVENT_NOT_FOUND");
  }
}

export class ForbiddenError extends PlanServiceError {
  constructor() {
    super("You do not have permission to modify this event", "FORBIDDEN");
  }
}

export class VersionConflictError extends PlanServiceError {
  constructor(expected: number, current: number) {
    super("Version conflict", "VERSION_CONFLICT", { expected, current });
  }
}

export class EventLockedError extends PlanServiceError {
  constructor(lockedBy: string, expiresAt: string) {
    super("Event is locked by another user", "EVENT_LOCKED", {
      locked_by: lockedBy,
      expires_at: expiresAt,
    });
  }
}

export class GuestLimitExceededError extends PlanServiceError {
  constructor() {
    super("Guest limit exceeded", "GUEST_LIMIT_EXCEEDED");
  }
}
```

**Usage**: Refactor service to throw these custom errors instead of generic `Error`

---

### Step 5: Add Unit Tests

**File**: `src/lib/services/__tests__/plan.service.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { PlanService } from "../plan.service";
import { createMockSupabaseClient } from "../../test-utils/supabase-mock";

describe("PlanService.addGuest", () => {
  let service: PlanService;
  let mockSupabase: ReturnType<typeof createMockSupabaseClient>;

  beforeEach(() => {
    mockSupabase = createMockSupabaseClient();
    service = new PlanService(mockSupabase as any);
  });

  it("should add guest successfully", async () => {
    // Arrange
    const eventId = "event-123";
    const userId = "user-456";
    const guestData = { name: "Alice Smith", tag: "Family" };

    mockSupabase.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: {
                id: eventId,
                owner_id: userId,
                plan_data: { guests: [], tables: [], settings: {} },
                autosave_version: 5,
                lock_held_by: null,
                lock_expires_at: null,
                deleted_at: null,
              },
              error: null,
            }),
        }),
      }),
    });

    // Act
    const result = await service.addGuest(eventId, guestData, userId);

    // Assert
    expect(result.guest.name).toBe("Alice Smith");
    expect(result.guest.id).toMatch(/^g_/);
    expect(result.newVersion).toBe(6);
  });

  it("should throw EVENT_NOT_FOUND for non-existent event", async () => {
    // Arrange
    mockSupabase.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null, error: { message: "Not found" } }),
        }),
      }),
    });

    // Act & Assert
    await expect(service.addGuest("invalid-id", { name: "Test" }, "user-123")).rejects.toThrow("EVENT_NOT_FOUND");
  });

  it("should throw FORBIDDEN for non-owner user", async () => {
    // Arrange
    mockSupabase.from.mockReturnValue({
      select: () => ({
        eq: () => ({
          single: () =>
            Promise.resolve({
              data: {
                id: "event-123",
                owner_id: "different-user",
                plan_data: { guests: [] },
                autosave_version: 1,
                deleted_at: null,
              },
              error: null,
            }),
        }),
      }),
    });

    // Act & Assert
    await expect(service.addGuest("event-123", { name: "Test" }, "user-123")).rejects.toThrow("FORBIDDEN");
  });

  // Add more tests for lock validation, version conflicts, etc.
});
```

**Run Tests**: `npm run test`

---

### Step 6: Add Integration Tests

**File**: `src/pages/api/events/[event_id]/plan/__tests__/guests.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { POST } from "../guests";

describe("POST /api/events/{event_id}/plan/guests", () => {
  it("should return 201 with guest object", async () => {
    // Integration test with test database
    // Use Supabase local dev environment
  });

  it("should return 400 for missing name", async () => {
    // Test validation errors
  });

  it("should return 401 for unauthenticated request", async () => {
    // Test auth flow
  });
});
```

---

### Step 7: Update API Documentation

**File**: `.ai/api-plan.md` (add detailed example)

````markdown
#### POST /api/events/{event_id}/plan/guests

Add a new guest to the event's guest list.

**Request**:

```json
{
  "name": "Alice Smith",
  "note": "Vegan, nut allergy",
  "tag": "Family",
  "rsvp": "Yes"
}
```
````

**Response 201**:

```json
{
  "id": "g_a1b2c3d4",
  "name": "Alice Smith",
  "note": "Vegan, nut allergy",
  "tag": "Family",
  "rsvp": "Yes"
}
```

**Errors**:

- 400: Invalid input (name missing or too long)
- 401: Unauthorized
- 403: Not event owner
- 404: Event not found
- 409: Version conflict, event locked, or guest limit exceeded

```

---

### Step 8: Manual Testing Checklist

**Scenarios to Test**:

1. ✅ **Happy Path**: Add guest with all fields
   - Expected: 201 response with guest object

2. ✅ **Minimal Input**: Add guest with only name
   - Expected: 201 response, optional fields omitted

3. ✅ **Long Name**: Name with exactly 150 characters
   - Expected: 201 success

4. ✅ **Name Too Long**: Name with 151 characters
   - Expected: 400 INVALID_GUEST_NAME

5. ✅ **Empty Name**: Name with only whitespace
   - Expected: 400 INVALID_GUEST_NAME

6. ✅ **Missing Auth**: Request without Authorization header
   - Expected: 401 UNAUTHORIZED

7. ✅ **Wrong Owner**: User tries to add guest to another user's event
   - Expected: 403 FORBIDDEN

8. ✅ **Non-existent Event**: Invalid event_id
   - Expected: 404 EVENT_NOT_FOUND

9. ✅ **Version Conflict**: If-Match header with outdated version
   - Expected: 409 VERSION_CONFLICT

10. ✅ **Event Locked**: Another user holds the lock
    - Expected: 409 EVENT_LOCKED

**Testing Tools**:
- Postman or curl for API requests
- Supabase local dev for database
- Browser DevTools for JWT token extraction

---

### Step 9: Performance Testing

**Load Test Scenario**:
- 100 concurrent users adding guests to same event
- Measure response times and version conflict rate
- Validate autosave_version increments correctly

**Tools**:
- k6 or Apache JMeter for load testing
- Supabase Studio for query performance analysis

**Success Criteria**:
- P95 latency < 500ms
- No data corruption (all guests persisted)
- Graceful handling of version conflicts

---

### Step 10: Deploy and Monitor

**Deployment Checklist**:
1. ✅ Merge feature branch to `main`
2. ✅ Run production migrations (if schema changed)
3. ✅ Deploy to staging environment
4. ✅ Run smoke tests on staging
5. ✅ Deploy to production
6. ✅ Monitor error rates and latency

**Monitoring**:
- Set up alerts for 5xx errors (>1% of requests)
- Track endpoint latency (Supabase dashboard)
- Monitor audit log write success rate

**Rollback Plan**:
- If critical bugs: revert deployment
- If data corruption: restore from snapshot (use `snapshots` table)

---

## Summary

This implementation plan provides a comprehensive guide for building the `POST /api/events/{event_id}/plan/guests` endpoint. The design prioritizes:

- **Data Integrity**: Optimistic locking via `autosave_version`
- **Security**: JWT authentication, ownership checks, input validation
- **Auditability**: Comprehensive audit logging
- **Performance**: Efficient JSONB mutations, connection pooling
- **Maintainability**: Service layer abstraction, comprehensive error handling
- **Compliance**: PII handling considerations for GDPR/CCPA

The implementation follows Astro + Supabase best practices, uses Zod for validation, and includes test coverage at unit and integration levels. The endpoint is designed to scale for the MVP use case (events with <1000 guests) while allowing for future optimizations (separate guests table, async audit logging) as usage grows.
```
