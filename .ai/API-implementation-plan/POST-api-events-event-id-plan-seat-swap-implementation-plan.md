# API Endpoint Implementation Plan: POST /api/events/{event_id}/plan/seat-swap

## 1. Endpoint Overview

The `POST /api/events/{event_id}/plan/seat-swap` endpoint enables swapping two guests between seats within an event's seating plan. This endpoint supports both same-table and cross-table swaps and gracefully handles cases where one or both seats are empty (treating single-empty swaps as move operations).

**Key Behaviors:**

- Validates both seat references exist within their respective tables
- Extracts guest_ids from both seats (may be undefined for empty seats)
- Atomically exchanges the guest_ids at the two seat positions
- Handles edge cases: both empty (no-op), one empty (move), same seat (no-op)
- Updates the event's plan_data with the swapped assignments
- Increments autosave_version for optimistic concurrency control
- Creates audit log entry with action_type "seat_swap"
- Returns updated autosave_version

**Relationship to Other Endpoints:**

- Complements `POST /api/events/{event_id}/plan/assign` (random assignment)
- Part of the plan operations family alongside table/guest CRUD
- Can be included in `PATCH /api/events/{event_id}/plan/bulk` operations

## 2. Request Details

### HTTP Method

`POST`

### URL Structure

```
POST /api/events/{event_id}/plan/seat-swap
```

### Path Parameters

| Parameter  | Type | Required | Description                                         |
| ---------- | ---- | -------- | --------------------------------------------------- |
| `event_id` | UUID | Yes      | Unique identifier of the event containing the seats |

### Request Headers

| Header            | Required | Description                                               |
| ----------------- | -------- | --------------------------------------------------------- |
| `Authorization`   | Yes      | Bearer {JWT_TOKEN} from Supabase auth                     |
| `Content-Type`    | Yes      | `application/json`                                        |
| `Idempotency-Key` | No       | UUID for idempotent request handling (optional for swaps) |

### Request Body

```json
{
  "a": {
    "table_id": "string",
    "seat_no": number
  },
  "b": {
    "table_id": "string",
    "seat_no": number
  }
}
```

#### Field Descriptions

| Field        | Type       | Required | Constraints                               | Description                           |
| ------------ | ---------- | -------- | ----------------------------------------- | ------------------------------------- |
| `a`          | SeatRefDTO | Yes      | -                                         | First seat reference                  |
| `a.table_id` | string     | Yes      | Non-empty, must exist in plan_data.tables | Table ID for first seat               |
| `a.seat_no`  | number     | Yes      | Integer, >= 1, <= table capacity          | Seat number (1-based) for first seat  |
| `b`          | SeatRefDTO | Yes      | -                                         | Second seat reference                 |
| `b.table_id` | string     | Yes      | Non-empty, must exist in plan_data.tables | Table ID for second seat              |
| `b.seat_no`  | number     | Yes      | Integer, >= 1, <= table capacity          | Seat number (1-based) for second seat |

### Example Request

```bash
curl -X POST https://api.example.com/api/events/550e8400-e29b-41d4-a716-446655440000/plan/seat-swap \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{
    "a": {
      "table_id": "t1",
      "seat_no": 3
    },
    "b": {
      "table_id": "t5",
      "seat_no": 7
    }
  }'
```

## 3. Used Types

### Command Types

```typescript
// From types.ts
export interface SeatRefDTO {
  table_id: string;
  seat_no: number;
}

export interface SeatSwapCommand {
  a: SeatRefDTO;
  b: SeatRefDTO;
}
```

### Response Types

```typescript
export interface SeatSwapResponseDTO {
  autosave_version: number;
  swapped: {
    seat_a: {
      table_id: string;
      seat_no: number;
      guest_id?: string;
    };
    seat_b: {
      table_id: string;
      seat_no: number;
      guest_id?: string;
    };
  };
}
```

### Supporting Types

```typescript
// From types.ts
export type PlanDataDTO = {
  tables: TableDTO[];
  guests: GuestDTO[];
  settings: PlanSettingsDTO;
};

export type TableDTO = {
  id: string;
  shape: Enums<"table_shape_enum">;
  capacity: number;
  label?: string;
  start_index: number;
  head_seat: number;
  seats: SeatAssignmentDTO[];
};

export type SeatAssignmentDTO = {
  seat_no: number;
  guest_id?: string;
};

export type ApiErrorDTO = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
};
```

## 4. Response Details

### Success Response (200 OK)

```json
{
  "autosave_version": 15,
  "swapped": {
    "seat_a": {
      "table_id": "t1",
      "seat_no": 3,
      "guest_id": "g42"
    },
    "seat_b": {
      "table_id": "t5",
      "seat_no": 7,
      "guest_id": "g17"
    }
  }
}
```

**Status Code:** `200 OK`

**Description:** Seats successfully swapped. Returns the new autosave_version and details of the swap operation including which guests (if any) were at each seat.

### Error Responses

#### 400 Bad Request - Invalid Input

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Invalid request body",
    "details": {
      "fieldErrors": {
        "a.seat_no": ["Expected number, received string"]
      }
    }
  }
}
```

#### 400 Bad Request - Invalid Seat

```json
{
  "error": {
    "code": "INVALID_SEAT",
    "message": "Seat number exceeds table capacity",
    "details": {
      "table_id": "t1",
      "seat_no": 15,
      "capacity": 10
    }
  }
}
```

#### 401 Unauthorized

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

#### 403 Forbidden

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Permission denied"
  }
}
```

#### 404 Not Found - Event

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found",
    "details": {
      "event_id": "550e8400-e29b-41d4-a716-446655440000"
    }
  }
}
```

#### 404 Not Found - Table

```json
{
  "error": {
    "code": "TABLE_NOT_FOUND",
    "message": "Table not found",
    "details": {
      "table_id": "t999"
    }
  }
}
```

#### 409 Conflict - Version

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Event was modified by another user",
    "details": {
      "current_version": 15,
      "attempted_version": 14
    }
  }
}
```

#### 500 Internal Server Error

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error"
  }
}
```

## 5. Data Flow

### High-Level Flow

1. **Authentication & Authorization**
   - Extract user_id from JWT bearer token
   - Fetch event from database
   - Verify user is owner OR holds valid lock
   - Return 401/403 if unauthorized

2. **Input Validation**
   - Validate request body schema using Zod
   - Return 400 if validation fails

3. **Business Logic Validation**
   - Verify table A exists in plan_data.tables
   - Verify table B exists in plan_data.tables
   - Verify seat A is within table A's capacity
   - Verify seat B is within table B's capacity
   - Return 404/400 if validation fails

4. **Seat Swap Logic**
   - Find seat A in table A's seats array
   - Find seat B in table B's seats array
   - Extract guest_id from seat A (may be undefined)
   - Extract guest_id from seat B (may be undefined)
   - Set seat A's guest_id to seat B's previous value
   - Set seat B's guest_id to seat A's previous value
   - Update plan_data immutably

5. **Database Update**
   - Update events table with new plan_data
   - Increment autosave_version
   - Use optimistic locking (WHERE autosave_version = old_version)
   - Return 409 if version conflict

6. **Audit Logging**
   - Create audit_log entry with action_type "seat_swap"
   - Include guest names and seat details

7. **Response**
   - Return 200 with new autosave_version and swap details

### Detailed Service Layer Flow

```typescript
async function swapSeats(
  supabase: SupabaseClient,
  userId: UUID,
  eventId: UUID,
  command: SeatSwapCommand
): Promise<SeatSwapResponseDTO> {
  // 1. Fetch event with row-level security
  const { data: event, error: fetchError } = await supabase
    .from("events")
    .select("*")
    .eq("id", eventId)
    .is("deleted_at", null)
    .single();

  if (fetchError || !event) {
    throw new NotFoundError("EVENT_NOT_FOUND", "Event not found", {
      event_id: eventId,
    });
  }

  // 2. Verify ownership or lock
  const hasValidLock =
    event.lock_held_by === userId && event.lock_expires_at && new Date(event.lock_expires_at) > new Date();

  if (event.owner_id !== userId && !hasValidLock) {
    throw new ForbiddenError("FORBIDDEN", "Permission denied");
  }

  // 3. Validate plan_data structure
  const planData = event.plan_data as PlanDataDTO;

  // 4. Find table A
  const tableA = planData.tables.find((t) => t.id === command.a.table_id);
  if (!tableA) {
    throw new NotFoundError("TABLE_NOT_FOUND", "Table not found", {
      table_id: command.a.table_id,
    });
  }

  // 5. Find table B
  const tableB = planData.tables.find((t) => t.id === command.b.table_id);
  if (!tableB) {
    throw new NotFoundError("TABLE_NOT_FOUND", "Table not found", {
      table_id: command.b.table_id,
    });
  }

  // 6. Validate seat numbers within capacity
  if (command.a.seat_no < 1 || command.a.seat_no > tableA.capacity) {
    throw new BadRequestError("INVALID_SEAT", "Seat number exceeds table capacity", {
      table_id: tableA.id,
      seat_no: command.a.seat_no,
      capacity: tableA.capacity,
    });
  }

  if (command.b.seat_no < 1 || command.b.seat_no > tableB.capacity) {
    throw new BadRequestError("INVALID_SEAT", "Seat number exceeds table capacity", {
      table_id: tableB.id,
      seat_no: command.b.seat_no,
      capacity: tableB.capacity,
    });
  }

  // 7. Find or create seat entries
  let seatAEntry = tableA.seats.find((s) => s.seat_no === command.a.seat_no);
  let seatBEntry = tableB.seats.find((s) => s.seat_no === command.b.seat_no);

  // Get guest_ids (undefined if seat empty)
  const guestIdAtA = seatAEntry?.guest_id;
  const guestIdAtB = seatBEntry?.guest_id;

  // 8. Perform swap
  if (seatAEntry) {
    seatAEntry.guest_id = guestIdAtB;
  } else {
    // Create seat entry if it doesn't exist
    tableA.seats.push({
      seat_no: command.a.seat_no,
      guest_id: guestIdAtB,
    });
    tableA.seats.sort((a, b) => a.seat_no - b.seat_no);
  }

  if (seatBEntry) {
    seatBEntry.guest_id = guestIdAtA;
  } else {
    // Create seat entry if it doesn't exist
    tableB.seats.push({
      seat_no: command.b.seat_no,
      guest_id: guestIdAtA,
    });
    tableB.seats.sort((a, b) => a.seat_no - b.seat_no);
  }

  // 9. Update database with optimistic locking
  const newVersion = event.autosave_version + 1;
  const { error: updateError } = await supabase
    .from("events")
    .update({
      plan_data: planData,
      autosave_version: newVersion,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId)
    .eq("autosave_version", event.autosave_version);

  if (updateError) {
    // Check for version conflict
    if (updateError.code === "23505" || updateError.message.includes("version")) {
      throw new ConflictError("VERSION_CONFLICT", "Event was modified by another user", {
        current_version: event.autosave_version,
      });
    }
    throw updateError;
  }

  // 10. Get guest names for audit log
  const guestNameA = guestIdAtA ? planData.guests.find((g) => g.id === guestIdAtA)?.name : null;
  const guestNameB = guestIdAtB ? planData.guests.find((g) => g.id === guestIdAtB)?.name : null;

  // 11. Create audit log
  await supabase.from("audit_log").insert({
    event_id: eventId,
    user_id: userId,
    action_type: "seat_swap",
    details: {
      seat_a: {
        table_id: command.a.table_id,
        seat_no: command.a.seat_no,
        guest_id: guestIdAtA ?? null,
        guest_name: guestNameA,
      },
      seat_b: {
        table_id: command.b.table_id,
        seat_no: command.b.seat_no,
        guest_id: guestIdAtB ?? null,
        guest_name: guestNameB,
      },
    },
  });

  // 12. Return response
  return {
    autosave_version: newVersion,
    swapped: {
      seat_a: {
        table_id: command.a.table_id,
        seat_no: command.a.seat_no,
        guest_id: guestIdAtB,
      },
      seat_b: {
        table_id: command.b.table_id,
        seat_no: command.b.seat_no,
        guest_id: guestIdAtA,
      },
    },
  };
}
```

### JSONB Manipulation Strategy

**Finding Seat Entry:**

```typescript
function findSeat(table: TableDTO, seatNo: number): SeatAssignmentDTO | undefined {
  return table.seats.find((s) => s.seat_no === seatNo);
}
```

**Creating Missing Seat Entry:**

```typescript
function ensureSeatExists(table: TableDTO, seatNo: number): void {
  const exists = table.seats.some((s) => s.seat_no === seatNo);
  if (!exists) {
    table.seats.push({ seat_no: seatNo });
    table.seats.sort((a, b) => a.seat_no - b.seat_no);
  }
}
```

**Swapping Guest IDs:**

```typescript
function swapGuestIds(tableA: TableDTO, seatNoA: number, tableB: TableDTO, seatNoB: number): void {
  ensureSeatExists(tableA, seatNoA);
  ensureSeatExists(tableB, seatNoB);

  const seatA = tableA.seats.find((s) => s.seat_no === seatNoA)!;
  const seatB = tableB.seats.find((s) => s.seat_no === seatNoB)!;

  const tempGuestId = seatA.guest_id;
  seatA.guest_id = seatB.guest_id;
  seatB.guest_id = tempGuestId;
}
```

### Edge Cases Handling

1. **Both Seats Empty**: Swap completes successfully (no-op, both remain empty)
2. **One Seat Empty**: Effectively moves guest from occupied seat to empty seat
3. **Same Seat (a === b)**: No-op, return success without modification
4. **Same Table Different Seats**: Works normally, swaps within same table
5. **Seat Entry Missing**: Create seat entry dynamically before swap

## 6. Security Considerations

### Authentication

- **Mechanism**: Supabase JWT bearer token in Authorization header
- **Validation**: Extract user from `context.locals.supabase.auth.getUser()`
- **Failure Response**: 401 Unauthorized if token invalid/missing

### Authorization

**Rules:**

1. User must be event owner (`events.owner_id === user.id`)
2. OR user must hold valid lock (`events.lock_held_by === user.id` AND `lock_expires_at > NOW()`)

**Implementation:**

```typescript
const hasValidLock =
  event.lock_held_by === userId && event.lock_expires_at && new Date(event.lock_expires_at) > new Date();

if (event.owner_id !== userId && !hasValidLock) {
  throw new ForbiddenError("FORBIDDEN", "Permission denied");
}
```

### Input Validation

**Zod Schema:**

```typescript
const seatRefSchema = z.object({
  table_id: z.string().min(1, "table_id is required"),
  seat_no: z.number().int().positive("seat_no must be positive integer"),
});

const seatSwapSchema = z.object({
  a: seatRefSchema,
  b: seatRefSchema,
});
```

**SQL Injection Prevention:**

- Use Supabase client parameterized queries (automatic)
- Never concatenate user input into raw SQL

**JSONB Injection Prevention:**

- Strict Zod validation ensures table_id is string, seat_no is positive integer
- TypeScript type safety prevents malformed JSONB

### Concurrency Control

**Optimistic Locking:**

```sql
UPDATE events
SET
  plan_data = $1,
  autosave_version = autosave_version + 1,
  updated_at = NOW()
WHERE
  id = $2
  AND autosave_version = $3  -- Ensures no intermediate changes
```

If WHERE clause matches zero rows → 409 VERSION_CONFLICT

### Data Integrity

**Constraints:**

- Seat numbers validated against table capacity
- Table existence verified before swap
- Guest IDs not validated (guests can be removed independently)

**Atomicity:**

- Single UPDATE statement ensures atomic plan_data modification
- No partial swaps possible

## 7. Error Handling

### Error Hierarchy

```typescript
class SeatSwapError extends Error {
  constructor(
    public code: string,
    public message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
  }
}

class NotFoundError extends SeatSwapError {}
class BadRequestError extends SeatSwapError {}
class ForbiddenError extends SeatSwapError {}
class ConflictError extends SeatSwapError {}
class InternalError extends SeatSwapError {}
```

### Error Mapping

| Error Class     | HTTP Status | Error Code       | When Thrown                          |
| --------------- | ----------- | ---------------- | ------------------------------------ |
| NotFoundError   | 404         | EVENT_NOT_FOUND  | Event doesn't exist or is deleted    |
| NotFoundError   | 404         | TABLE_NOT_FOUND  | Table A or B not found in plan_data  |
| BadRequestError | 400         | INVALID_INPUT    | Zod validation fails                 |
| BadRequestError | 400         | INVALID_SEAT     | Seat number exceeds table capacity   |
| ForbiddenError  | 403         | FORBIDDEN        | User not owner and no valid lock     |
| ConflictError   | 409         | VERSION_CONFLICT | Optimistic lock failure              |
| InternalError   | 500         | INTERNAL_ERROR   | Database error, unexpected exception |

### Error Response Handler

```typescript
function handleError(error: unknown): Response {
  if (error instanceof SeatSwapError) {
    const statusMap: Record<string, number> = {
      EVENT_NOT_FOUND: 404,
      TABLE_NOT_FOUND: 404,
      INVALID_INPUT: 400,
      INVALID_SEAT: 400,
      FORBIDDEN: 403,
      VERSION_CONFLICT: 409,
      INTERNAL_ERROR: 500,
    };

    return new Response(
      JSON.stringify({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      } as ApiErrorDTO),
      {
        status: statusMap[error.code] ?? 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  // Unknown error
  console.error("Unexpected error in seat-swap:", error);
  return new Response(
    JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    } as ApiErrorDTO),
    { status: 500, headers: { "Content-Type": "application/json" } }
  );
}
```

### Logging Strategy

**Error Logging:**

```typescript
console.error(`[seat-swap] ${error.code}: ${error.message}`, {
  event_id: eventId,
  user_id: userId,
  details: error.details,
  timestamp: new Date().toISOString(),
});
```

**Success Logging (Optional):**

```typescript
console.info(`[seat-swap] Success`, {
  event_id: eventId,
  user_id: userId,
  autosave_version: newVersion,
  swap: { a: command.a, b: command.b },
});
```

## 8. Performance Considerations

### Database Optimization

**Query Performance:**

- Event fetch uses indexed `id` column (primary key)
- Soft delete filter uses indexed `deleted_at IS NULL`
- Optimistic locking uses composite index on `(id, autosave_version)`

**JSONB Performance:**

- Plan_data manipulation happens in-memory (JavaScript)
- Single JSONB update per request (atomic)
- No deep JSONB queries (full object loaded into memory)

**Recommended Indexes:**

```sql
-- Already exists (primary key)
CREATE INDEX events_pkey ON events(id);

-- Soft delete optimization
CREATE INDEX idx_events_not_deleted ON events(id) WHERE deleted_at IS NULL;

-- Optimistic locking optimization
CREATE INDEX idx_events_version ON events(id, autosave_version);
```

### Memory Considerations

**Plan Data Size:**

- Typical event: 20-50 tables, 100-300 guests (~50KB JSONB)
- Large event: 100 tables, 1000 guests (~200KB JSONB)
- Swap operation: O(n) where n = number of tables (find operations)

**Mitigation:**

- Limit event size via UI constraints
- Consider pagination if plan_data exceeds 1MB
- Use streaming JSONB updates for very large plans (future optimization)

### Concurrency Handling

**Optimistic Locking Benefits:**

- No table-level locks (high concurrency)
- Automatic retry on client side (409 response)
- No deadlock risk

**Lock Starvation Prevention:**

- Soft lock system limits concurrent editors
- Lock expiration ensures eventual availability

### Rate Limiting

**Recommended Limits:**

- 60 requests/minute per user per event
- 300 requests/hour per user across all events

**Implementation:**

```typescript
// Use existing rate limiting middleware (if available)
// Or implement per-user/per-event Redis counter
```

## 9. Implementation Steps

### Phase 1: Foundation (Setup & Validation)

#### Step 1: Define Zod Validation Schema

**File**: `src/lib/validation/seat-swap-schema.ts`

```typescript
import { z } from "zod";

export const seatRefSchema = z.object({
  table_id: z.string().min(1, "table_id is required"),
  seat_no: z.number().int().positive("seat_no must be a positive integer"),
});

export const seatSwapSchema = z.object({
  a: seatRefSchema,
  b: seatRefSchema,
});

export type SeatSwapInput = z.infer<typeof seatSwapSchema>;
```

**Validation:**

- Run `npm run lint` to check TypeScript
- Create unit test for schema validation

#### Step 2: Create Custom Error Classes

**File**: `src/lib/errors/index.ts` (extend existing or create new)

```typescript
export class NotFoundError extends Error {
  constructor(
    public code: string,
    public message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends Error {
  constructor(
    public code: string,
    public message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BadRequestError";
  }
}

export class ForbiddenError extends Error {
  constructor(
    public code: string,
    public message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends Error {
  constructor(
    public code: string,
    public message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ConflictError";
  }
}
```

### Phase 2: Service Layer Implementation

#### Step 3: Create Seat Swap Service

**File**: `src/lib/services/seat-swap.service.ts`

```typescript
import type { SupabaseClient } from "../../db/supabase.client";
import type { SeatSwapCommand, PlanDataDTO, TableDTO, UUID } from "../../types";
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from "../errors";

export interface SeatSwapResponseDTO {
  autosave_version: number;
  swapped: {
    seat_a: {
      table_id: string;
      seat_no: number;
      guest_id?: string;
    };
    seat_b: {
      table_id: string;
      seat_no: number;
      guest_id?: string;
    };
  };
}

export class SeatSwapService {
  /**
   * Swap two guests between seats
   */
  static async swapSeats(
    supabase: SupabaseClient,
    userId: UUID,
    eventId: UUID,
    command: SeatSwapCommand
  ): Promise<SeatSwapResponseDTO> {
    // 1. Fetch event
    const { data: event, error: fetchError } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .is("deleted_at", null)
      .single();

    if (fetchError || !event) {
      throw new NotFoundError("EVENT_NOT_FOUND", "Event not found", {
        event_id: eventId,
      });
    }

    // 2. Verify ownership or lock
    const hasValidLock =
      event.lock_held_by === userId && event.lock_expires_at && new Date(event.lock_expires_at) > new Date();

    if (event.owner_id !== userId && !hasValidLock) {
      throw new ForbiddenError("FORBIDDEN", "Permission denied");
    }

    // 3. Get plan data
    const planData = event.plan_data as PlanDataDTO;

    // 4. Find tables
    const tableA = planData.tables.find((t) => t.id === command.a.table_id);
    if (!tableA) {
      throw new NotFoundError("TABLE_NOT_FOUND", "Table not found", {
        table_id: command.a.table_id,
      });
    }

    const tableB = planData.tables.find((t) => t.id === command.b.table_id);
    if (!tableB) {
      throw new NotFoundError("TABLE_NOT_FOUND", "Table not found", {
        table_id: command.b.table_id,
      });
    }

    // 5. Validate seat numbers
    if (command.a.seat_no < 1 || command.a.seat_no > tableA.capacity) {
      throw new BadRequestError("INVALID_SEAT", "Seat number exceeds table capacity", {
        table_id: tableA.id,
        seat_no: command.a.seat_no,
        capacity: tableA.capacity,
      });
    }

    if (command.b.seat_no < 1 || command.b.seat_no > tableB.capacity) {
      throw new BadRequestError("INVALID_SEAT", "Seat number exceeds table capacity", {
        table_id: tableB.id,
        seat_no: command.b.seat_no,
        capacity: tableB.capacity,
      });
    }

    // 6. Get current guest IDs
    const seatAEntry = tableA.seats.find((s) => s.seat_no === command.a.seat_no);
    const seatBEntry = tableB.seats.find((s) => s.seat_no === command.b.seat_no);
    const guestIdAtA = seatAEntry?.guest_id;
    const guestIdAtB = seatBEntry?.guest_id;

    // 7. Perform swap
    this.swapGuestIds(tableA, command.a.seat_no, tableB, command.b.seat_no);

    // 8. Update database
    const newVersion = event.autosave_version + 1;
    const { error: updateError } = await supabase
      .from("events")
      .update({
        plan_data: planData,
        autosave_version: newVersion,
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .eq("autosave_version", event.autosave_version);

    if (updateError) {
      if (updateError.code === "23505" || updateError.message.includes("version")) {
        throw new ConflictError("VERSION_CONFLICT", "Event was modified by another user");
      }
      throw updateError;
    }

    // 9. Create audit log
    const guestNameA = guestIdAtA ? planData.guests.find((g) => g.id === guestIdAtA)?.name : null;
    const guestNameB = guestIdAtB ? planData.guests.find((g) => g.id === guestIdAtB)?.name : null;

    await supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "seat_swap",
      details: {
        seat_a: {
          table_id: command.a.table_id,
          seat_no: command.a.seat_no,
          guest_id: guestIdAtA ?? null,
          guest_name: guestNameA,
        },
        seat_b: {
          table_id: command.b.table_id,
          seat_no: command.b.seat_no,
          guest_id: guestIdAtB ?? null,
          guest_name: guestNameB,
        },
      },
    });

    // 10. Return response
    return {
      autosave_version: newVersion,
      swapped: {
        seat_a: {
          table_id: command.a.table_id,
          seat_no: command.a.seat_no,
          guest_id: guestIdAtB,
        },
        seat_b: {
          table_id: command.b.table_id,
          seat_no: command.b.seat_no,
          guest_id: guestIdAtA,
        },
      },
    };
  }

  /**
   * Swap guest IDs between two seats (ensures seat entries exist)
   */
  private static swapGuestIds(tableA: TableDTO, seatNoA: number, tableB: TableDTO, seatNoB: number): void {
    // Ensure seat entries exist
    this.ensureSeatExists(tableA, seatNoA);
    this.ensureSeatExists(tableB, seatNoB);

    // Find seat entries
    const seatA = tableA.seats.find((s) => s.seat_no === seatNoA)!;
    const seatB = tableB.seats.find((s) => s.seat_no === seatNoB)!;

    // Swap guest IDs
    const tempGuestId = seatA.guest_id;
    seatA.guest_id = seatB.guest_id;
    seatB.guest_id = tempGuestId;

    // Clean up empty seat entries (optional optimization)
    if (!seatA.guest_id) {
      delete seatA.guest_id;
    }
    if (!seatB.guest_id) {
      delete seatB.guest_id;
    }
  }

  /**
   * Ensure seat entry exists in table's seats array
   */
  private static ensureSeatExists(table: TableDTO, seatNo: number): void {
    const exists = table.seats.some((s) => s.seat_no === seatNo);
    if (!exists) {
      table.seats.push({ seat_no: seatNo });
      table.seats.sort((a, b) => a.seat_no - b.seat_no);
    }
  }
}
```

### Phase 3: API Route Handler

#### Step 4: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/plan/seat-swap.ts`

```typescript
import type { APIRoute } from "astro";
import { seatSwapSchema } from "../../../../../lib/validation/seat-swap-schema";
import { SeatSwapService } from "../../../../../lib/services/seat-swap.service";
import type { ApiErrorDTO, SeatSwapCommand } from "../../../../../types";
import { NotFoundError, BadRequestError, ForbiddenError, ConflictError } from "../../../../../lib/errors";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    // 1. Authentication
    const supabase = context.locals.supabase;
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

    // 2. Extract event_id from path
    const eventId = context.params.event_id;
    if (!eventId) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "event_id is required",
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Parse and validate request body
    const body = await context.request.json();
    const validation = seatSwapSchema.safeParse(body);

    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message: "Invalid request body",
            details: validation.error.flatten(),
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Call service layer
    const result = await SeatSwapService.swapSeats(supabase, user.id, eventId, validation.data as SeatSwapCommand);

    // 5. Return success response
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Error handling
    if (error instanceof NotFoundError) {
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        } as ApiErrorDTO),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error instanceof BadRequestError) {
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error instanceof ForbiddenError) {
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        } as ApiErrorDTO),
        { status: 403, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error instanceof ConflictError) {
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        } as ApiErrorDTO),
        { status: 409, headers: { "Content-Type": "application/json" } }
      );
    }

    // Unknown error
    console.error("[seat-swap] Unexpected error:", error);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Internal server error",
        },
      } as ApiErrorDTO),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
```

### Phase 4: Testing

#### Step 5: Add Unit Tests

**File**: `tests/services/seat-swap.service.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SeatSwapService } from "../../src/lib/services/seat-swap.service";
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from "../../src/lib/errors";
import type { PlanDataDTO } from "../../src/types";

describe("SeatSwapService", () => {
  describe("swapSeats", () => {
    it("should swap two guests successfully", async () => {
      // Mock Supabase and test successful swap
      // Implementation depends on your test setup
    });

    it("should handle one empty seat (move operation)", async () => {
      // Test moving guest to empty seat
    });

    it("should handle both empty seats (no-op)", async () => {
      // Test swapping two empty seats
    });

    it("should throw EVENT_NOT_FOUND when event does not exist", async () => {
      // Test implementation
    });

    it("should throw FORBIDDEN when user is not owner", async () => {
      // Test implementation
    });

    it("should throw TABLE_NOT_FOUND when table A not found", async () => {
      // Test implementation
    });

    it("should throw TABLE_NOT_FOUND when table B not found", async () => {
      // Test implementation
    });

    it("should throw INVALID_SEAT when seat A exceeds capacity", async () => {
      // Test implementation
    });

    it("should throw INVALID_SEAT when seat B exceeds capacity", async () => {
      // Test implementation
    });

    it("should increment autosave_version", async () => {
      // Test implementation
    });

    it("should create audit log entry", async () => {
      // Test implementation
    });

    it("should handle same-table swap", async () => {
      // Test swapping within same table
    });
  });

  describe("swapGuestIds", () => {
    it("should swap guest IDs correctly", () => {
      const tableA: TableDTO = {
        id: "t1",
        shape: "round",
        capacity: 5,
        start_index: 1,
        head_seat: 1,
        seats: [{ seat_no: 1, guest_id: "g1" }],
      };
      const tableB: TableDTO = {
        id: "t2",
        shape: "rectangular",
        capacity: 8,
        start_index: 1,
        head_seat: 1,
        seats: [{ seat_no: 3, guest_id: "g2" }],
      };

      SeatSwapService["swapGuestIds"](tableA, 1, tableB, 3);

      expect(tableA.seats.find((s) => s.seat_no === 1)?.guest_id).toBe("g2");
      expect(tableB.seats.find((s) => s.seat_no === 3)?.guest_id).toBe("g1");
    });

    it("should create seat entry if not exists", () => {
      const tableA: TableDTO = {
        id: "t1",
        shape: "round",
        capacity: 5,
        start_index: 1,
        head_seat: 1,
        seats: [],
      };
      const tableB: TableDTO = {
        id: "t2",
        shape: "rectangular",
        capacity: 8,
        start_index: 1,
        head_seat: 1,
        seats: [{ seat_no: 5, guest_id: "g2" }],
      };

      SeatSwapService["swapGuestIds"](tableA, 2, tableB, 5);

      expect(tableA.seats.length).toBe(1);
      expect(tableA.seats[0].seat_no).toBe(2);
      expect(tableA.seats[0].guest_id).toBe("g2");
    });
  });

  describe("ensureSeatExists", () => {
    it("should create seat if not exists", () => {
      const table: TableDTO = {
        id: "t1",
        shape: "round",
        capacity: 5,
        start_index: 1,
        head_seat: 1,
        seats: [],
      };

      SeatSwapService["ensureSeatExists"](table, 3);

      expect(table.seats.length).toBe(1);
      expect(table.seats[0].seat_no).toBe(3);
    });

    it("should not duplicate seat if exists", () => {
      const table: TableDTO = {
        id: "t1",
        shape: "round",
        capacity: 5,
        start_index: 1,
        head_seat: 1,
        seats: [{ seat_no: 3 }],
      };

      SeatSwapService["ensureSeatExists"](table, 3);

      expect(table.seats.length).toBe(1);
    });

    it("should keep seats sorted by seat_no", () => {
      const table: TableDTO = {
        id: "t1",
        shape: "round",
        capacity: 5,
        start_index: 1,
        head_seat: 1,
        seats: [{ seat_no: 5 }, { seat_no: 2 }],
      };

      SeatSwapService["ensureSeatExists"](table, 3);

      expect(table.seats.map((s) => s.seat_no)).toEqual([2, 3, 5]);
    });
  });
});
```

#### Step 6: Add Integration Tests

**File**: `tests/integration/seat-swap.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("POST /api/events/{event_id}/plan/seat-swap", () => {
  let authToken: string;
  let eventId: string;

  beforeAll(async () => {
    // Setup test user and event
  });

  afterAll(async () => {
    // Cleanup
  });

  it("should swap two guests successfully (200)", async () => {
    // Test implementation
  });

  it("should handle one empty seat", async () => {
    // Test implementation
  });

  it("should return 401 without auth", async () => {
    // Test implementation
  });

  it("should return 403 for non-owner", async () => {
    // Test implementation
  });

  it("should return 404 for invalid event", async () => {
    // Test implementation
  });

  it("should return 404 for invalid table", async () => {
    // Test implementation
  });

  it("should return 400 for invalid seat number", async () => {
    // Test implementation
  });

  it("should return 409 on version conflict", async () => {
    // Test implementation
  });
});
```

### Phase 5: Documentation & Deployment

#### Step 7: Update API Documentation

**File**: `.ai/api-plan.md` (update entry for seat-swap)

Add detailed response format and examples to the existing endpoint entry.

#### Step 8: Manual Testing Checklist

1. **Happy Path**
   - [ ] Swap two seated guests on different tables
   - [ ] Swap two seated guests on same table
   - [ ] Verify autosave_version incremented
   - [ ] Verify audit_log entry created
   - [ ] Verify response includes correct guest IDs

2. **Edge Cases**
   - [ ] Swap with one empty seat (move operation)
   - [ ] Swap with both seats empty (no-op)
   - [ ] Swap same seat (a === b) - should no-op
   - [ ] Swap when seat entry doesn't exist in seats array

3. **Error Scenarios**
   - [ ] Invalid event_id returns 404
   - [ ] Invalid table_id returns 404
   - [ ] Seat number exceeds capacity returns 400
   - [ ] Non-owner without lock returns 403
   - [ ] Invalid auth token returns 401
   - [ ] Concurrent edit returns 409

4. **Performance**
   - [ ] Large plan_data (100+ tables) completes in < 500ms
   - [ ] Optimistic locking prevents race conditions

#### Step 9: Deploy

1. Merge feature branch to main
2. Deploy to staging environment
3. Run integration tests on staging
4. Deploy to production
5. Monitor error logs for first 24 hours

---

## Summary

This implementation plan provides a complete blueprint for developing the `POST /api/events/{event_id}/plan/seat-swap` endpoint. The endpoint enables flexible seat swapping with proper validation, security, concurrency control, and audit logging. The service layer is cleanly separated from the API route handler, making the code testable and maintainable.

**Key Features:**

- Atomic seat swaps with optimistic locking
- Graceful handling of empty seats (move operations)
- Comprehensive error handling with specific status codes
- Full audit trail for compliance
- JSONB manipulation without deep queries (performance)
- Type-safe implementation with Zod validation
