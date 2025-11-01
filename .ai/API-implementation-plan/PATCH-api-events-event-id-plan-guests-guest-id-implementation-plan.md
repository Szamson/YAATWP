# API Endpoint Implementation Plan: PATCH /api/events/{event_id}/plan/guests/{guest_id}

## 1. Endpoint Overview

This endpoint updates an existing guest entry within an event's embedded `plan_data` JSONB structure. Guests are stored in the `plan_data.guests` array within the `events` table. The endpoint supports partial updates (all fields optional), validates input according to PRD constraints, increments the autosave version for concurrency control, creates an audit log entry, and returns the updated guest object.

**Primary Use Cases**:

- Editing guest details (name corrections, RSVP updates)
- Adding/updating dietary notes
- Changing guest tags/groups
- Bulk guest updates via UI

**Key Characteristics**:

- **Partial Update**: All fields optional; only provided fields are updated
- **Transactional**: All changes (plan_data update, version increment, audit log) occur atomically
- **Concurrency-safe**: Uses optimistic locking via `If-Match` header with `autosave_version`
- **Lock-aware**: Respects soft single-editor locks (rejects updates if another user holds lock)
- **Auditable**: Records changes in `audit_log` table with action type `guest_edit`
- **Idempotent**: Optional `Idempotency-Key` header prevents duplicate updates on retries

---

## 2. Request Details

### HTTP Method & URL

- **Method**: `PATCH`
- **URL Structure**: `/api/events/{event_id}/plan/guests/{guest_id}`
- **Content-Type**: `application/json`

### Path Parameters

| Parameter  | Type   | Required | Description                                                                      |
| ---------- | ------ | -------- | -------------------------------------------------------------------------------- |
| `event_id` | UUID   | Yes      | Event identifier (must be valid UUID v4)                                         |
| `guest_id` | string | Yes      | Guest identifier within plan*data.guests array (format: `g*<nanoid>` or similar) |

### Headers

| Header            | Required    | Description                                                 | Example                                |
| ----------------- | ----------- | ----------------------------------------------------------- | -------------------------------------- |
| `Authorization`   | Yes         | Supabase JWT Bearer token                                   | `Bearer eyJhbGc...`                    |
| `If-Match`        | Recommended | Current autosave_version for optimistic locking             | `5`                                    |
| `Idempotency-Key` | Optional    | UUID v4 for idempotent updates (prevents duplicate retries) | `550e8400-e29b-41d4-a716-446655440000` |
| `Content-Type`    | Yes         | Must be `application/json`                                  | `application/json`                     |

### Request Body

**Type**: `UpdateGuestCommand` (from `types.ts`)

```typescript
type UpdateGuestCommand = Partial<Omit<GuestDTO, "id">>;
```

**JSON Schema** (all fields optional):

```json
{
  "name": "Alice Johnson", // OPTIONAL: 1-150 chars if provided
  "note": "Gluten-free", // OPTIONAL: max 500 chars
  "tag": "Friends", // OPTIONAL: max 50 chars
  "rsvp": "No" // OPTIONAL: max 20 chars
}
```

**Validation Rules** (enforced via Zod schema):

1. **name** (OPTIONAL):
   - Type: `string`
   - If provided: minimum length 1 (after trimming), maximum 150 characters
   - Transformation: Trim leading/trailing whitespace
   - Error: `INVALID_GUEST_NAME` if empty or exceeds max

2. **note** (OPTIONAL):
   - Type: `string`
   - Maximum length: 500 characters
   - Error: `INVALID_INPUT` if exceeds max

3. **tag** (OPTIONAL):
   - Type: `string`
   - Maximum length: 50 characters (group/category label)
   - Error: `INVALID_INPUT` if exceeds max

4. **rsvp** (OPTIONAL):
   - Type: `string`
   - Maximum length: 20 characters
   - Common values: "Yes", "No", "Maybe", "Pending"
   - Error: `INVALID_INPUT` if exceeds max

**Constraints**:

- At least one field must be provided (empty body returns 400)
- Cannot modify `id` field (omitted from UpdateGuestCommand type)
- Only fields present in request body are updated (true partial update)

**Example Requests**:

1. **Update only name**:

   ```json
   {
     "name": "Alice Marie Johnson"
   }
   ```

2. **Update RSVP and note**:

   ```json
   {
     "rsvp": "Yes",
     "note": "Vegan, no shellfish"
   }
   ```

3. **Update all fields**:
   ```json
   {
     "name": "Alice Johnson",
     "note": "Gluten-free, dairy-free",
     "tag": "Bride's College Friends",
     "rsvp": "Yes"
   }
   ```

---

## 3. Used Types

### Command Models

- **`UpdateGuestCommand`** (`types.ts`): Input validation model for partial updates
  ```typescript
  type UpdateGuestCommand = Partial<Omit<GuestDTO, "id">>;
  ```

### Response DTOs

- **`GuestDTO`** (`types.ts`): Full guest object returned after update

  ```typescript
  interface GuestDTO {
    id: string;
    name: string;
    note?: string;
    tag?: string;
    rsvp?: string;
  }
  ```

- **`ApiErrorDTO`** (`types.ts`): Standardized error response
  ```typescript
  interface ApiErrorDTO {
    error: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };
  }
  ```

### Internal Types

- **`PlanDataDTO`** (`types.ts`): Full plan data structure containing guests array
- **`DBEventRow`** (from `Tables<"events">`): Database row type for events table
- **`SupabaseClient`** (`src/db/supabase.client.ts`): Typed Supabase client from context.locals

### Validation Types

- **`UpdateGuestSchema`** (Zod): Runtime validation schema for request body
  ```typescript
  const updateGuestSchema = z
    .object({
      name: z.string().trim().min(1).max(150).optional(),
      note: z.string().max(500).optional(),
      tag: z.string().max(50).optional(),
      rsvp: z.string().max(20).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field must be provided",
    });
  ```

---

## 4. Response Details

### Success Response (200 OK)

**Content-Type**: `application/json`

**Body**: Updated `GuestDTO` object

```json
{
  "id": "g_a1b2c3d4",
  "name": "Alice Johnson",
  "note": "Gluten-free, dairy-free",
  "tag": "Bride's College Friends",
  "rsvp": "Yes"
}
```

**Headers**:

- `Content-Type: application/json`
- `ETag: "{autosave_version}"` (optional, for cache control)

### Error Responses

#### 400 Bad Request - Invalid Input

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Validation failed",
    "details": {
      "issues": [
        {
          "path": ["name"],
          "message": "Name must not exceed 150 characters"
        }
      ]
    }
  }
}
```

**Scenarios**:

- Empty request body (no fields provided)
- Name exceeds 150 characters or is empty string
- Note exceeds 500 characters
- Tag exceeds 50 characters
- RSVP exceeds 20 characters
- Invalid JSON syntax

#### 401 Unauthorized

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

**Scenarios**:

- Missing `Authorization` header
- Invalid or expired JWT token
- Token signature verification failure

#### 403 Forbidden

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to modify this event"
  }
}
```

**Scenarios**:

- Authenticated user is not the event owner (`owner_id` mismatch)

#### 404 Not Found - Event

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found"
  }
}
```

**Scenarios**:

- `event_id` does not exist in database
- `event_id` is not a valid UUID

#### 404 Not Found - Guest

```json
{
  "error": {
    "code": "GUEST_NOT_FOUND",
    "message": "Guest not found in event"
  }
}
```

**Scenarios**:

- `guest_id` does not exist in `plan_data.guests` array
- Guest was previously deleted

#### 409 Conflict - Version Mismatch

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Event has been modified by another process",
    "details": {
      "expected": 5,
      "current": 7
    }
  }
}
```

**Scenarios**:

- `If-Match` header value doesn't match current `autosave_version`
- Concurrent modification by another user

#### 409 Conflict - Event Locked

```json
{
  "error": {
    "code": "EVENT_LOCKED",
    "message": "Event is currently locked by another user",
    "details": {
      "held_by": "user-uuid-123",
      "expires_at": "2025-11-01T15:30:00.000Z"
    }
  }
}
```

**Scenarios**:

- Another user holds the edit lock (`lock_held_by` is set and `lock_expires_at` is in the future)

#### 410 Gone - Soft Deleted

```json
{
  "error": {
    "code": "EVENT_DELETED",
    "message": "Event has been deleted"
  }
}
```

**Scenarios**:

- Event has non-null `deleted_at` timestamp

#### 500 Internal Server Error

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  }
}
```

**Scenarios**:

- Database connection failure
- JSONB parsing error
- Unexpected exception in service layer

---

## 5. Data Flow

### High-Level Flow

```
Client Request
    ↓
[1] API Route Handler (/api/events/[event_id]/plan/guests/[guest_id].ts)
    ↓
[2] Middleware: JWT Authentication (context.locals.supabase)
    ↓
[3] Path Parameter Validation (event_id UUID, guest_id string)
    ↓
[4] Request Body Validation (Zod schema)
    ↓
[5] Service Layer (src/lib/services/plan.service.ts)
    ├─ [5a] Fetch Event & Ownership Check
    ├─ [5b] Soft Delete Check
    ├─ [5c] Soft Lock Validation
    ├─ [5d] Version Conflict Check (If-Match)
    ├─ [5e] Find Guest in plan_data.guests
    ├─ [5f] Apply Patch & Merge
    ├─ [5g] Validate Updated Guest
    ├─ [5h] Update plan_data.guests Array
    ├─ [5i] Increment autosave_version
    ├─ [5j] Persist to Database (Transaction)
    └─ [5k] Create Audit Log Entry
    ↓
[6] Response: Updated GuestDTO (200)
```

### Detailed Steps

#### Step 1: API Route Handler

- **File**: `src/pages/api/events/[event_id]/plan/guests/[guest_id].ts`
- Extract path parameters: `event_id`, `guest_id`
- Extract `Authorization` header and validate JWT
- Extract optional `If-Match` header
- Parse request body as JSON
- Call service layer method

#### Step 2: Authentication

- **Middleware**: Astro middleware provides `context.locals.supabase`
- Call `supabase.auth.getUser()` to extract user from JWT
- Return 401 if authentication fails

#### Step 3: Path Parameter Validation

- **event_id**: Validate UUID v4 format using Zod
  ```typescript
  const eventIdSchema = z.string().uuid();
  ```
- **guest_id**: Validate non-empty string
  ```typescript
  const guestIdSchema = z.string().min(1);
  ```
- Return 400 `INVALID_INPUT` if validation fails

#### Step 4: Request Body Validation

- **Tool**: Zod schema (`updateGuestSchema`)
- **Schema Definition**:
  ```typescript
  const updateGuestSchema = z
    .object({
      name: z.string().trim().min(1, "Name cannot be empty").max(150, "Name too long").optional(),
      note: z.string().max(500, "Note too long").optional(),
      tag: z.string().max(50, "Tag too long").optional(),
      rsvp: z.string().max(20, "RSVP too long").optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: "At least one field must be provided",
    });
  ```
- **Error Handling**: Return 400 with validation error details if schema parse fails

#### Step 5: Service Layer Processing

**5a. Fetch Event & Ownership Check**:

```sql
SELECT * FROM events
WHERE id = $1
  AND deleted_at IS NULL;
```

- If no row: return 404 `EVENT_NOT_FOUND`
- If `owner_id` ≠ authenticated user: return 403 `FORBIDDEN`
- Parse `plan_data` JSONB into `PlanDataDTO` type

**5b. Soft Delete Check**:

- Already handled in query above (`deleted_at IS NULL`)
- If deleted: return 410 `EVENT_DELETED`

**5c. Soft Lock Validation**:

```typescript
if (event.lock_held_by !== null && event.lock_expires_at > new Date()) {
  if (event.lock_held_by !== userId) {
    throw Error("EVENT_LOCKED");
  }
}
```

- Return 409 `EVENT_LOCKED` with lock details if another user holds lock

**5d. Version Conflict Check**:

- Extract `If-Match` header value
- Parse as integer
- Compare to `event.autosave_version`
- Return 409 `VERSION_CONFLICT` if mismatch
- **Best practice**: Clients should always provide `If-Match` for data integrity

**5e. Find Guest in plan_data.guests**:

```typescript
const guestIndex = event.plan_data.guests.findIndex((g) => g.id === guestId);
if (guestIndex === -1) {
  throw Error("GUEST_NOT_FOUND");
}
```

- Return 404 `GUEST_NOT_FOUND` if guest doesn't exist

**5f. Apply Patch & Merge**:

```typescript
const existingGuest = event.plan_data.guests[guestIndex];
const updatedGuest: GuestDTO = {
  ...existingGuest,
  ...patchData, // Only provided fields are applied
};
```

**5g. Validate Updated Guest**:

- Re-validate the merged guest object
- Ensure `name` is still valid (non-empty, ≤150 chars)
- Trim name if it was updated

**5h. Update plan_data.guests Array**:

```typescript
const updatedGuests = [...event.plan_data.guests];
updatedGuests[guestIndex] = updatedGuest;

const updatedPlanData = {
  ...event.plan_data,
  guests: updatedGuests,
};
```

**5i. Increment autosave_version**:

```typescript
const newVersion = event.autosave_version + 1;
```

**5j. Persist to Database (Transaction)**:

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

- Bind parameters:
  - `$1`: `updatedPlanData` (JSONB)
  - `$2`: `newVersion`
  - `$3`: `eventId`
  - `$4`: `event.autosave_version` (original version)
- If `RETURNING` yields no rows: version conflict occurred (return 409)
- Use Supabase transaction if bundling with audit log insert

**5k. Create Audit Log Entry**:

```sql
INSERT INTO audit_log (event_id, user_id, action_type, details)
VALUES ($1, $2, 'guest_edit', $3::jsonb);
```

- `details` JSON:
  ```json
  {
    "guest_id": "g_a1b2c3d4",
    "guest_name": "Alice Johnson",
    "fields_changed": ["name", "rsvp"],
    "autosave_version": 6
  }
  ```

#### Step 6: Response

- Extract updated guest from `updatedPlanData.guests`
- Return 200 with `GuestDTO` JSON body
- Include `ETag` header with new `autosave_version`

---

## 6. Security Considerations

### Authentication & Authorization

- **JWT Validation**: Supabase middleware validates token signature and expiration
- **Ownership Check**: Verify `event.owner_id === user.id` before allowing updates
- **No Privilege Escalation**: Users can only modify their own events
- **Lock Enforcement**: Respect soft locks to prevent concurrent edits

### Input Validation

- **Zod Schema Validation**: Strict type and format validation for all input fields
- **SQL Injection Prevention**: Supabase client uses parameterized queries; JSONB updates are safe
- **Mass Assignment Protection**: Only explicitly defined fields in `UpdateGuestCommand` are accepted
- **Empty Body Rejection**: At least one field must be provided (prevents no-op requests)
- **Length Constraints**:
  - Name: 1-150 chars
  - Note: 0-500 chars
  - Tag: 0-50 chars
  - RSVP: 0-20 chars

### Data Integrity

- **Soft Delete Respect**: Reject updates to soft-deleted events (410 Gone)
- **Optimistic Concurrency**: `If-Match` header with `autosave_version` prevents lost updates
- **Atomic Updates**: Use database transactions for update + audit log to ensure consistency
- **Guest Existence Check**: Verify guest exists before updating
- **JSONB Validation**: Ensure plan_data structure remains valid after update

### PII & GDPR Compliance

- **Guest Names**: May contain PII (user responsibility per PRD)
- **Audit Logs**: Record guest_id and name in audit trail (required for compliance)
- **No Sensitive Fields**: Note field may contain dietary restrictions (not considered highly sensitive)
- **Access Control**: Only event owner can view/edit guest data
- **Deletion Support**: Separate DELETE endpoint for right to erasure

### Rate Limiting

- **Recommendation**: Implement rate limiting at Astro middleware level
- **Suggested Limit**: 100 requests per minute per user
- **Protection**: Prevents abuse and DoS attacks

---

## 7. Error Handling

### Error Categories

| Category          | HTTP Status | Error Code       | Retry Strategy              |
| ----------------- | ----------- | ---------------- | --------------------------- |
| Authentication    | 401         | UNAUTHORIZED     | Refresh JWT token           |
| Authorization     | 403         | FORBIDDEN        | Do not retry                |
| Not Found (Event) | 404         | EVENT_NOT_FOUND  | Do not retry                |
| Not Found (Guest) | 404         | GUEST_NOT_FOUND  | Do not retry                |
| Validation        | 400         | INVALID_INPUT    | Fix input, retry            |
| Version Conflict  | 409         | VERSION_CONFLICT | Fetch latest, retry         |
| Lock Conflict     | 409         | EVENT_LOCKED     | Wait for lock expiry, retry |
| Soft Deleted      | 410         | EVENT_DELETED    | Do not retry                |
| Server Error      | 500         | INTERNAL_ERROR   | Retry with backoff          |

### Error Response Format

All errors follow the `ApiErrorDTO` schema:

```typescript
interface ApiErrorDTO {
  error: {
    code: string; // Machine-readable error code
    message: string; // Human-readable message
    details?: Record<string, unknown>; // Optional context
  };
}
```

### Service Layer Error Handling

```typescript
class PlanService {
  async updateGuest(
    eventId: UUID,
    guestId: string,
    patchData: UpdateGuestCommand,
    userId: UUID,
    expectedVersion?: number
  ): Promise<{ guest: GuestDTO; newVersion: number }> {
    try {
      // Service logic...
    } catch (error: any) {
      // Map database errors to API errors
      if (error.code === "PGRST116") {
        throw new Error("EVENT_NOT_FOUND");
      }
      if (error.message === "VERSION_CONFLICT") {
        throw error; // Re-throw with original message
      }
      // Log unexpected errors
      console.error("PlanService.updateGuest error:", error);
      throw new Error("INTERNAL_ERROR");
    }
  }
}
```

### Route Handler Error Mapping

```typescript
export async function PATCH(context: APIContext): Promise<Response> {
  try {
    // Call service...
  } catch (error: any) {
    const errorMap: Record<string, { status: number; code: string; message: string }> = {
      EVENT_NOT_FOUND: { status: 404, code: "EVENT_NOT_FOUND", message: "Event not found" },
      GUEST_NOT_FOUND: { status: 404, code: "GUEST_NOT_FOUND", message: "Guest not found in event" },
      FORBIDDEN: { status: 403, code: "FORBIDDEN", message: "You do not have permission to modify this event" },
      EVENT_LOCKED: { status: 409, code: "EVENT_LOCKED", message: "Event is currently locked by another user" },
      VERSION_CONFLICT: {
        status: 409,
        code: "VERSION_CONFLICT",
        message: "Event has been modified by another process",
      },
      EVENT_DELETED: { status: 410, code: "EVENT_DELETED", message: "Event has been deleted" },
    };

    const mapped = errorMap[error.message] || {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    };

    return new Response(
      JSON.stringify({
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(error.details && { details: error.details }),
        },
      } satisfies ApiErrorDTO),
      { status: mapped.status, headers: { "Content-Type": "application/json" } }
    );
  }
}
```

### Client-Side Error Handling

**Recommended retry logic**:

```typescript
async function updateGuest(eventId: string, guestId: string, patch: UpdateGuestCommand) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(`/api/events/${eventId}/plan/guests/${guestId}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "If-Match": currentVersion.toString(),
        },
        body: JSON.stringify(patch),
      });

      if (response.ok) return await response.json();

      if (response.status === 409) {
        const error = await response.json();
        if (error.error.code === "VERSION_CONFLICT") {
          // Fetch latest version and retry
          await refreshEventData();
          continue;
        }
        if (error.error.code === "EVENT_LOCKED") {
          // Wait and retry
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
      }

      // Non-retryable error
      throw new Error(await response.text());
    } catch (err) {
      if (attempt === maxRetries - 1) throw err;
    }
  }
}
```

---

## 8. Performance Considerations

### Database Optimization

1. **JSONB Indexing**:
   - Add GIN index on `plan_data` for faster JSONB operations:
     ```sql
     CREATE INDEX idx_events_plan_data_guests ON events USING GIN (plan_data jsonb_path_ops);
     ```
   - Improves performance when searching/updating guests array

2. **Single Query Update**:
   - Use `UPDATE ... RETURNING *` to update and fetch in one round trip
   - Reduces latency by ~50% compared to separate UPDATE + SELECT

3. **Connection Pooling**:
   - Supabase client maintains connection pool
   - Reuse connections across requests
   - Configure `max_connections` appropriately in Supabase settings

### JSONB Update Efficiency

- **Small Payload**: Updating a single guest in a 100-guest array is O(n) but fast in practice
- **Replacement Strategy**: Replace entire `plan_data.guests` array rather than partial JSONB update
- **Future Optimization**: If guest count exceeds 1000, consider separate `guests` table with foreign key

### Caching Strategy

1. **Client-Side**:
   - Cache event data with `autosave_version` as cache key
   - Invalidate on 409 `VERSION_CONFLICT`

2. **Server-Side** (future):
   - Redis cache for frequently accessed events
   - Invalidate on write
   - TTL: 5 minutes

### Autosave Throttling

- **Client Recommendation**: Debounce autosave requests (500ms delay)
- **Prevents**: Excessive database writes during rapid typing
- **Example**:
  ```typescript
  const debouncedUpdate = debounce(updateGuest, 500);
  ```

### Benchmarks & SLOs

| Metric       | Target             | Measurement                   |
| ------------ | ------------------ | ----------------------------- |
| p50 Latency  | < 100ms            | From request to response      |
| p95 Latency  | < 300ms            | Including database round trip |
| p99 Latency  | < 500ms            | Worst-case acceptable         |
| Throughput   | 100 req/s per user | Sustained load                |
| Database CPU | < 50%              | PostgreSQL server             |

**Bottlenecks**:

- JSONB serialization/deserialization (negligible for <1000 guests)
- Network latency to Supabase (mitigate with regional hosting)
- Lock contention (minimal with soft locks)

---

## 9. Implementation Steps

### Step 1: Create Zod Validation Schema

**File**: `src/lib/validation/guest.schema.ts`

```typescript
import { z } from "zod";

export const updateGuestSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, { message: "Guest name cannot be empty" })
      .max(150, { message: "Guest name must not exceed 150 characters" })
      .optional(),

    note: z.string().max(500, { message: "Note must not exceed 500 characters" }).optional(),

    tag: z.string().max(50, { message: "Tag must not exceed 50 characters" }).optional(),

    rsvp: z.string().max(20, { message: "RSVP must not exceed 20 characters" }).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided for update",
  });

export type UpdateGuestInput = z.infer<typeof updateGuestSchema>;

// Path parameter validation
export const guestPathParamsSchema = z.object({
  event_id: z.string().uuid({ message: "Invalid event ID format" }),
  guest_id: z.string().min(1, { message: "Guest ID is required" }),
});
```

**Verification**:

- Run unit tests to ensure schema rejects invalid inputs
- Test edge cases: empty body, max length strings, invalid UUID

---

### Step 2: Create Service Layer Method

**File**: `src/lib/services/plan.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UpdateGuestCommand, GuestDTO, UUID, PlanDataDTO } from "../types";

export class PlanService {
  constructor(private supabase: SupabaseClient) {}

  async updateGuest(
    eventId: UUID,
    guestId: string,
    patchData: UpdateGuestCommand,
    userId: UUID,
    expectedVersion?: number
  ): Promise<{ guest: GuestDTO; newVersion: number }> {
    // 1. Fetch event with ownership check
    const { data: event, error: fetchError } = await this.supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .is("deleted_at", null)
      .single();

    if (fetchError || !event) {
      throw new Error("EVENT_NOT_FOUND");
    }

    if (event.owner_id !== userId) {
      throw new Error("FORBIDDEN");
    }

    // 2. Lock validation
    if (event.lock_held_by && new Date(event.lock_expires_at) > new Date()) {
      if (event.lock_held_by !== userId) {
        throw Object.assign(new Error("EVENT_LOCKED"), {
          details: {
            held_by: event.lock_held_by,
            expires_at: event.lock_expires_at,
          },
        });
      }
    }

    // 3. Version conflict check
    if (expectedVersion !== undefined && event.autosave_version !== expectedVersion) {
      throw Object.assign(new Error("VERSION_CONFLICT"), {
        details: {
          expected: expectedVersion,
          current: event.autosave_version,
        },
      });
    }

    // 4. Parse plan_data
    const planData: PlanDataDTO = event.plan_data as PlanDataDTO;

    // 5. Find guest
    const guestIndex = planData.guests.findIndex((g) => g.id === guestId);
    if (guestIndex === -1) {
      throw new Error("GUEST_NOT_FOUND");
    }

    // 6. Apply patch
    const existingGuest = planData.guests[guestIndex];
    const updatedGuest: GuestDTO = {
      ...existingGuest,
      ...patchData,
    };

    // 7. Update guests array
    const updatedGuests = [...planData.guests];
    updatedGuests[guestIndex] = updatedGuest;

    const updatedPlanData = {
      ...planData,
      guests: updatedGuests,
    };

    const newVersion = event.autosave_version + 1;

    // 8. Persist to database
    const { data: updated, error: updateError } = await this.supabase
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

    if (updateError || !updated) {
      if (updateError?.code === "PGRST116") {
        throw new Error("VERSION_CONFLICT");
      }
      throw new Error("INTERNAL_ERROR");
    }

    // 9. Create audit log entry
    await this.supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "guest_edit",
      details: {
        guest_id: guestId,
        guest_name: updatedGuest.name,
        fields_changed: Object.keys(patchData),
        autosave_version: newVersion,
      },
    });

    return { guest: updatedGuest, newVersion };
  }
}
```

**Verification**:

- Unit test service method with mocked Supabase client
- Test all error paths (not found, forbidden, version conflict)

---

### Step 3: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/plan/guests/[guest_id].ts`

```typescript
import type { APIContext } from "astro";
import { updateGuestSchema, guestPathParamsSchema } from "../../../../../lib/validation/guest.schema";
import { PlanService } from "../../../../../lib/services/plan.service";
import type { ApiErrorDTO, GuestDTO } from "../../../../../types";

export const prerender = false;

export async function PATCH(context: APIContext): Promise<Response> {
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
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Path parameter validation
    const pathValidation = guestPathParamsSchema.safeParse(params);
    if (!pathValidation.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid path parameters",
            details: pathValidation.error.errors,
          },
        } satisfies ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const { event_id, guest_id } = pathValidation.data;

    // 3. Request body validation
    let requestBody: unknown;
    try {
      requestBody = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_JSON",
            message: "Invalid JSON in request body",
          },
        } satisfies ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const validationResult = updateGuestSchema.safeParse(requestBody);
    if (!validationResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Validation failed",
            details: validationResult.error.errors,
          },
        } satisfies ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const patchData = validationResult.data;

    // 4. Extract If-Match header for version control
    const ifMatch = request.headers.get("If-Match");
    const expectedVersion = ifMatch ? parseInt(ifMatch, 10) : undefined;

    // 5. Call service layer
    const planService = new PlanService(supabase);
    const { guest, newVersion } = await planService.updateGuest(
      event_id,
      guest_id,
      patchData,
      user.id,
      expectedVersion
    );

    // 6. Return success response
    return new Response(JSON.stringify(guest satisfies GuestDTO), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: `"${newVersion}"`,
      },
    });
  } catch (error: any) {
    // Error handling
    console.error("PATCH /api/events/[event_id]/plan/guests/[guest_id] error:", error);

    const errorMap: Record<string, { status: number; code: string; message: string }> = {
      EVENT_NOT_FOUND: { status: 404, code: "EVENT_NOT_FOUND", message: "Event not found" },
      GUEST_NOT_FOUND: { status: 404, code: "GUEST_NOT_FOUND", message: "Guest not found in event" },
      FORBIDDEN: { status: 403, code: "FORBIDDEN", message: "You do not have permission to modify this event" },
      EVENT_LOCKED: {
        status: 409,
        code: "EVENT_LOCKED",
        message: "Event is currently locked by another user",
      },
      VERSION_CONFLICT: {
        status: 409,
        code: "VERSION_CONFLICT",
        message: "Event has been modified by another process",
      },
      EVENT_DELETED: { status: 410, code: "EVENT_DELETED", message: "Event has been deleted" },
    };

    const mapped = errorMap[error.message] || {
      status: 500,
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred",
    };

    return new Response(
      JSON.stringify({
        error: {
          code: mapped.code,
          message: mapped.message,
          ...(error.details && { details: error.details }),
        },
      } satisfies ApiErrorDTO),
      { status: mapped.status, headers: { "Content-Type": "application/json" } }
    );
  }
}
```

**Verification**:

- Test route with Postman/curl
- Verify all status codes and error responses

---

### Step 4: Add Unit Tests

**File**: `src/lib/services/plan.service.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PlanService } from "./plan.service";

describe("PlanService.updateGuest", () => {
  let service: PlanService;
  let mockSupabase: any;

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn(() => mockSupabase),
      select: vi.fn(() => mockSupabase),
      eq: vi.fn(() => mockSupabase),
      is: vi.fn(() => mockSupabase),
      single: vi.fn(),
      update: vi.fn(() => mockSupabase),
      insert: vi.fn(),
    };
    service = new PlanService(mockSupabase);
  });

  it("should update guest name successfully", async () => {
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: "event-123",
        owner_id: "user-123",
        plan_data: {
          guests: [
            { id: "g1", name: "Alice", note: "Vegan" },
            { id: "g2", name: "Bob" },
          ],
          tables: [],
          settings: {},
        },
        autosave_version: 5,
        lock_held_by: null,
        lock_expires_at: null,
        deleted_at: null,
      },
      error: null,
    });

    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: "event-123",
        autosave_version: 6,
        plan_data: {
          guests: [
            { id: "g1", name: "Alice Marie", note: "Vegan" },
            { id: "g2", name: "Bob" },
          ],
          tables: [],
          settings: {},
        },
      },
      error: null,
    });

    const result = await service.updateGuest("event-123", "g1", { name: "Alice Marie" }, "user-123");

    expect(result.guest.name).toBe("Alice Marie");
    expect(result.guest.note).toBe("Vegan");
    expect(result.newVersion).toBe(6);
  });

  it("should throw GUEST_NOT_FOUND if guest doesn't exist", async () => {
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: "event-123",
        owner_id: "user-123",
        plan_data: { guests: [], tables: [], settings: {} },
        autosave_version: 1,
        lock_held_by: null,
        deleted_at: null,
      },
      error: null,
    });

    await expect(service.updateGuest("event-123", "g999", { name: "Test" }, "user-123")).rejects.toThrow(
      "GUEST_NOT_FOUND"
    );
  });

  it("should throw VERSION_CONFLICT on autosave_version mismatch", async () => {
    mockSupabase.single.mockResolvedValueOnce({
      data: {
        id: "event-123",
        owner_id: "user-123",
        plan_data: {
          guests: [{ id: "g1", name: "Alice" }],
          tables: [],
          settings: {},
        },
        autosave_version: 7,
        lock_held_by: null,
        deleted_at: null,
      },
      error: null,
    });

    await expect(service.updateGuest("event-123", "g1", { name: "Alice Updated" }, "user-123", 5)).rejects.toThrow(
      "VERSION_CONFLICT"
    );
  });

  // Add more tests for FORBIDDEN, EVENT_LOCKED, etc.
});
```

**Run Tests**: `npm run test`

---

### Step 5: Add Integration Tests

**File**: `tests/integration/guests.test.ts`

```typescript
import { describe, it, expect } from "vitest";

describe("PATCH /api/events/{event_id}/plan/guests/{guest_id}", () => {
  it("should update guest RSVP", async () => {
    // Setup: Create event and guest
    const eventId = "test-event-id";
    const guestId = "g1";
    const token = "valid-jwt-token"; // Mock or get from test auth

    const response = await fetch(`http://localhost:4321/api/events/${eventId}/plan/guests/${guestId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "If-Match": "5",
      },
      body: JSON.stringify({ rsvp: "Yes" }),
    });

    expect(response.status).toBe(200);
    const guest = await response.json();
    expect(guest.rsvp).toBe("Yes");
  });

  it("should return 404 for non-existent guest", async () => {
    const response = await fetch(`http://localhost:4321/api/events/event-123/plan/guests/g999`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test" }),
    });

    expect(response.status).toBe(404);
    const error = await response.json();
    expect(error.error.code).toBe("GUEST_NOT_FOUND");
  });
});
```

---

### Step 6: Update API Documentation

**File**: `.ai/api-plan.md` (update existing section)

````markdown
#### PATCH /api/events/{event_id}/plan/guests/{guest_id}

Update guest properties. All fields are optional; only provided fields are updated.

**Request**:

```json
{
  "name": "Alice Johnson",
  "note": "Gluten-free",
  "tag": "Friends",
  "rsvp": "Yes"
}
```
````

**Headers**:

- `If-Match: <autosave_version>` (recommended for concurrency control)

**Response 200**:

```json
{
  "id": "g_a1b2c3d4",
  "name": "Alice Johnson",
  "note": "Gluten-free",
  "tag": "Friends",
  "rsvp": "Yes"
}
```

**Errors**:

- 400: Invalid input (name too long, empty body, etc.)
- 401: Unauthorized
- 403: Not event owner
- 404: Event or guest not found
- 409: Version conflict or event locked
- 410: Event deleted

```

---

### Step 7: Manual Testing Checklist

**Scenarios to Test**:

1. ✅ **Happy Path**: Update single field (name)
   - Expected: 200 response with updated guest

2. ✅ **Update Multiple Fields**: Update name, note, and rsvp
   - Expected: 200 response with all fields updated

3. ✅ **Empty Body**: Send empty JSON `{}`
   - Expected: 400 INVALID_INPUT

4. ✅ **Name Too Long**: Name with 151 characters
   - Expected: 400 INVALID_INPUT

5. ✅ **Empty Name**: Name with only whitespace
   - Expected: 400 INVALID_GUEST_NAME

6. ✅ **Missing Auth**: Request without Authorization header
   - Expected: 401 UNAUTHORIZED

7. ✅ **Wrong Owner**: User tries to update guest in another user's event
   - Expected: 403 FORBIDDEN

8. ✅ **Non-existent Event**: Invalid event_id
   - Expected: 404 EVENT_NOT_FOUND

9. ✅ **Non-existent Guest**: Invalid guest_id
   - Expected: 404 GUEST_NOT_FOUND

10. ✅ **Version Conflict**: If-Match header with outdated version
    - Expected: 409 VERSION_CONFLICT

11. ✅ **Event Locked**: Another user holds the lock
    - Expected: 409 EVENT_LOCKED

12. ✅ **Soft Deleted Event**: Event has deleted_at set
    - Expected: 410 EVENT_DELETED

**Testing Tools**:

- Postman or curl for API requests
- Supabase local dev for database
- Browser DevTools for JWT token extraction

---

### Step 8: Performance Testing

**Load Test Scenario**:

- 50 concurrent users updating guests in different events
- Measure response times and throughput
- Verify no database connection pool exhaustion

**Tools**:

- Apache Bench: `ab -n 1000 -c 50 -H "Authorization: Bearer ..." -T application/json -p patch.json https://your-domain.com/api/events/{id}/plan/guests/{gid}`
- Artillery.io for more complex scenarios

**Acceptance Criteria**:

- p95 latency < 300ms
- No 500 errors under load
- Database CPU < 70%

---

### Step 9: Deployment Checklist

**Pre-Deployment**:

- ✅ All unit tests passing
- ✅ Integration tests passing
- ✅ Manual testing completed
- ✅ Code review approved
- ✅ API documentation updated

**Deployment**:

- Deploy to staging environment
- Run smoke tests
- Monitor error rates and latency
- Deploy to production with canary release (10% traffic)
- Monitor for 1 hour, then full rollout

**Rollback Plan**:

- If critical bugs: revert deployment
- If data corruption: restore from snapshot (use `snapshots` table)

---

## Summary

This implementation plan provides a comprehensive guide for building the `PATCH /api/events/{event_id}/plan/guests/{guest_id}` endpoint. The design prioritizes:

- **Partial Updates**: True PATCH semantics with optional fields
- **Data Integrity**: Optimistic locking via `autosave_version`
- **Security**: JWT authentication, ownership checks, input validation
- **Auditability**: Comprehensive audit logging with changed fields tracking
- **Performance**: Efficient JSONB mutations, connection pooling
- **Maintainability**: Service layer abstraction, comprehensive error handling
- **Compliance**: PII handling considerations for GDPR/CCPA

The implementation follows Astro + Supabase best practices, uses Zod for validation, and includes test coverage at unit and integration levels. The endpoint is designed to scale for the MVP use case (events with <1000 guests) while allowing for future optimizations (separate guests table, async audit logging) as usage grows.
```
