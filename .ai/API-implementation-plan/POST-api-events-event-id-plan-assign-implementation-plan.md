# API Endpoint Implementation Plan: POST /api/events/{event_id}/plan/assign

## 1. Endpoint Overview

The `POST /api/events/{event_id}/plan/assign` endpoint assigns a guest to a table using automatic random seat placement. This endpoint implements the core seating logic where the server selects an available seat based on canonical seat-order rules and randomization algorithms, ensuring fair and deterministic seat assignments while respecting table capacity constraints.

**Key Behaviors:**

- Validates guest and table existence within the event's plan_data
- Removes guest from any previous seat assignment (if already seated)
- Selects an empty seat using deterministic randomization based on event/guest hash
- Updates the event's plan_data with the new seat assignment
- Increments autosave_version for optimistic concurrency control
- Creates audit log entry for the assignment action
- Returns the assigned table_id and seat_no

## 2. Request Details

### HTTP Method

POST

### URL Structure

```
POST /api/events/{event_id}/plan/assign
```

### Path Parameters

| Parameter | Type | Required | Description                    | Validation                                                  |
| --------- | ---- | -------- | ------------------------------ | ----------------------------------------------------------- |
| event_id  | UUID | Yes      | Unique identifier of the event | Valid UUID format, event must exist and not be soft-deleted |

### Request Headers

| Header          | Required | Description                                                  |
| --------------- | -------- | ------------------------------------------------------------ |
| Authorization   | Yes      | Bearer token (Supabase JWT)                                  |
| Content-Type    | Yes      | Must be `application/json`                                   |
| Idempotency-Key | No       | Optional UUID for idempotent operations (future enhancement) |

### Request Body

```typescript
{
  "guest_id": "string",  // Required: ID of guest to assign
  "table_id": "string"   // Required: ID of target table
}
```

**Field Constraints:**

- `guest_id`: Non-empty string matching a guest ID in event.plan_data.guests
- `table_id`: Non-empty string matching a table ID in event.plan_data.tables

### Example Request

```json
POST /api/events/550e8400-e29b-41d4-a716-446655440000/plan/assign
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
Content-Type: application/json

{
  "guest_id": "g_a1b2c3d4",
  "table_id": "tbl_x7y8z9w0"
}
```

## 3. Used Types

### Input Types

**AssignGuestSeatCommand** (from types.ts):

```typescript
interface AssignGuestSeatCommand {
  guest_id: string;
  table_id: string;
}
```

### Output Types

**Success Response DTO**:

```typescript
interface AssignGuestSeatResponseDTO {
  table_id: string;
  seat_no: number;
  autosave_version: number; // New version after assignment
}
```

**Standard Types**:

- `ApiErrorDTO`: Standard error response envelope
- `PlanDataDTO`: Internal JSONB structure manipulation
- `TableDTO`: Table structure with seats array
- `GuestDTO`: Guest structure
- `SeatAssignmentDTO`: Individual seat assignment structure

### Internal Service Types

```typescript
interface SeatAssignmentResult {
  table_id: string;
  seat_no: number;
  previous_seat?: { table_id: string; seat_no: number }; // If guest was already seated
}

interface EmptySeat {
  seat_no: number;
  table_id: string;
}
```

## 4. Response Details

### Success Response (200 OK)

```json
{
  "table_id": "tbl_x7y8z9w0",
  "seat_no": 5,
  "autosave_version": 42
}
```

**Response Fields:**

- `table_id`: The table where the guest was assigned (echoes request)
- `seat_no`: The specific seat number chosen by the server (1-based index within table capacity)
- `autosave_version`: New autosave version after the assignment

### Error Responses

#### 400 Bad Request

**INVALID_REQUEST_BODY**: Malformed JSON or missing required fields

```json
{
  "error": {
    "code": "INVALID_REQUEST_BODY",
    "message": "Request body must include guest_id and table_id",
    "details": {
      "missing_fields": ["guest_id"]
    }
  }
}
```

**INVALID_GUEST_ID** / **INVALID_TABLE_ID**: Empty or invalid ID format

```json
{
  "error": {
    "code": "INVALID_GUEST_ID",
    "message": "guest_id cannot be empty"
  }
}
```

#### 401 Unauthorized

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Valid authentication required"
  }
}
```

#### 403 Forbidden

**FORBIDDEN**: User is not the event owner and doesn't hold a valid lock

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to modify this event"
  }
}
```

**LOCK_HELD_BY_OTHER**: Another user currently holds the edit lock

```json
{
  "error": {
    "code": "LOCK_HELD_BY_OTHER",
    "message": "Event is currently locked by another user",
    "details": {
      "held_by": "user_uuid",
      "expires_at": "2025-11-01T14:30:00Z"
    }
  }
}
```

#### 404 Not Found

**EVENT_NOT_FOUND**: Event doesn't exist or is soft-deleted

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found"
  }
}
```

**GUEST_NOT_FOUND**: Guest ID not in plan_data.guests array

```json
{
  "error": {
    "code": "GUEST_NOT_FOUND",
    "message": "Guest not found in seating plan",
    "details": {
      "guest_id": "g_invalid"
    }
  }
}
```

**TABLE_NOT_FOUND**: Table ID not in plan_data.tables array

```json
{
  "error": {
    "code": "TABLE_NOT_FOUND",
    "message": "Table not found in seating plan",
    "details": {
      "table_id": "tbl_invalid"
    }
  }
}
```

#### 409 Conflict

**TABLE_FULL**: No empty seats available in the target table

```json
{
  "error": {
    "code": "TABLE_FULL",
    "message": "Table has no available seats",
    "details": {
      "table_id": "tbl_x7y8z9w0",
      "capacity": 10,
      "assigned_seats": 10
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

1. **Authentication & Authorization**
   - Extract user_id from JWT bearer token
   - Fetch event from database
   - Verify user is owner OR holds valid lock
   - Return 401/403 if unauthorized

2. **Input Validation**
   - Validate request body schema using Zod
   - Return 400 if validation fails

3. **Business Logic Validation**
   - Verify guest exists in plan_data.guests
   - Verify table exists in plan_data.tables
   - Check table has available seats
   - Return 404/409 if validation fails

4. **Seat Assignment Logic**
   - Find all empty seats in target table
   - Select seat using deterministic randomization
   - Remove guest from previous seat (if any)
   - Assign guest to chosen seat
   - Update plan_data immutably

5. **Database Update**
   - Update events table with new plan_data
   - Increment autosave_version
   - Insert audit_log entry
   - Commit transaction

6. **Response**
   - Return table_id, seat_no, and new autosave_version

### Detailed Service Layer Flow

```typescript
// Pseudocode for assignGuestToTable service function

async function assignGuestToTable(
  supabase: SupabaseClient,
  userId: UUID,
  eventId: UUID,
  command: AssignGuestSeatCommand
): Promise<AssignGuestSeatResponseDTO> {
  // 1. Fetch event with authorization check
  const event = await fetchEventWithAuth(supabase, eventId, userId);
  if (!event) throw new NotFoundError("EVENT_NOT_FOUND");
  if (event.deleted_at) throw new NotFoundError("EVENT_NOT_FOUND");

  // 2. Authorization: owner OR valid lock holder
  const isOwner = event.owner_id === userId;
  const hasLock = event.lock_held_by === userId && new Date(event.lock_expires_at!) > new Date();

  if (!isOwner && !hasLock) {
    if (event.lock_held_by) {
      throw new ForbiddenError("LOCK_HELD_BY_OTHER", {
        held_by: event.lock_held_by,
        expires_at: event.lock_expires_at,
      });
    }
    throw new ForbiddenError("FORBIDDEN");
  }

  // 3. Validate guest exists
  const planData = event.plan_data as PlanDataDTO;
  const guest = planData.guests.find((g) => g.id === command.guest_id);
  if (!guest) {
    throw new NotFoundError("GUEST_NOT_FOUND", { guest_id: command.guest_id });
  }

  // 4. Validate table exists
  const table = planData.tables.find((t) => t.id === command.table_id);
  if (!table) {
    throw new NotFoundError("TABLE_NOT_FOUND", { table_id: command.table_id });
  }

  // 5. Find empty seats
  const emptySeats = findEmptySeats(table);
  if (emptySeats.length === 0) {
    throw new ConflictError("TABLE_FULL", {
      table_id: table.id,
      capacity: table.capacity,
      assigned_seats: table.capacity,
    });
  }

  // 6. Select random seat using deterministic algorithm
  const selectedSeat = selectRandomSeat(emptySeats, eventId, command.guest_id);

  // 7. Remove guest from previous seat (if any)
  const previousSeat = removeGuestFromAllSeats(planData, command.guest_id);

  // 8. Assign guest to selected seat
  assignGuestToSeat(table, selectedSeat, command.guest_id);

  // 9. Update database (transaction)
  const newVersion = event.autosave_version + 1;
  await supabase
    .from("events")
    .update({
      plan_data: planData,
      autosave_version: newVersion,
      updated_at: new Date().toISOString(),
    })
    .eq("id", eventId)
    .eq("autosave_version", event.autosave_version); // Optimistic locking

  // 10. Create audit log entry
  await createAuditLog(supabase, {
    event_id: eventId,
    user_id: userId,
    action_type: "seat_swap", // Closest existing enum value
    details: {
      guest_id: command.guest_id,
      guest_name: guest.name,
      table_id: command.table_id,
      seat_no: selectedSeat,
      previous_seat: previousSeat,
      action: "assign",
    },
  });

  // 11. Return response
  return {
    table_id: command.table_id,
    seat_no: selectedSeat,
    autosave_version: newVersion,
  };
}
```

### Random Seat Selection Algorithm

The algorithm implements deterministic randomization based on event and guest identifiers:

```typescript
function selectRandomSeat(emptySeats: number[], eventId: UUID, guestId: string): number {
  // Use a deterministic hash based on event ID and guest ID
  // This ensures the same guest assigned to same table gets same seat
  // across retries, but appears random

  const seed = createHash(eventId + guestId);
  const index = seed % emptySeats.length;
  return emptySeats[index];
}

function createHash(input: string): number {
  // Simple hash function (could use crypto.subtle for production)
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

function findEmptySeats(table: TableDTO): number[] {
  const emptySeats: number[] = [];

  // Build set of occupied seat numbers
  const occupiedSeats = new Set(table.seats.filter((s) => s.guest_id !== undefined).map((s) => s.seat_no));

  // Find all seat numbers from 1 to capacity that aren't occupied
  for (let seatNo = 1; seatNo <= table.capacity; seatNo++) {
    if (!occupiedSeats.has(seatNo)) {
      emptySeats.push(seatNo);
    }
  }

  return emptySeats;
}
```

### JSONB Manipulation Strategy

Since plan_data is stored as JSONB in PostgreSQL, we need to:

1. **Fetch**: Retrieve entire plan_data as JSON object
2. **Parse**: TypeScript automatically deserializes to object
3. **Modify**: Update in-memory structure immutably
4. **Persist**: Send updated JSON back to database

**Immutability Pattern:**

```typescript
function assignGuestToSeat(table: TableDTO, seatNo: number, guestId: string): void {
  // Find existing seat assignment or create new
  const existingSeatIndex = table.seats.findIndex((s) => s.seat_no === seatNo);

  if (existingSeatIndex >= 0) {
    // Update existing seat
    table.seats[existingSeatIndex] = { seat_no: seatNo, guest_id: guestId };
  } else {
    // Add new seat assignment
    table.seats.push({ seat_no: seatNo, guest_id: guestId });
  }

  // Sort seats by seat_no for consistent ordering
  table.seats.sort((a, b) => a.seat_no - b.seat_no);
}

function removeGuestFromAllSeats(
  planData: PlanDataDTO,
  guestId: string
): { table_id: string; seat_no: number } | undefined {
  let previousSeat: { table_id: string; seat_no: number } | undefined;

  for (const table of planData.tables) {
    const seatIndex = table.seats.findIndex((s) => s.guest_id === guestId);
    if (seatIndex >= 0) {
      previousSeat = {
        table_id: table.id,
        seat_no: table.seats[seatIndex].seat_no,
      };
      // Remove guest_id from seat (keep seat in array for capacity tracking)
      table.seats[seatIndex] = {
        seat_no: table.seats[seatIndex].seat_no,
      };
    }
  }

  return previousSeat;
}
```

## 6. Security Considerations

### Authentication

- **Requirement**: Valid Supabase JWT token in Authorization header
- **Validation**: Use `supabase.auth.getUser()` to extract user_id from token
- **Error**: Return 401 Unauthorized if token missing, invalid, or expired

### Authorization

- **Owner Check**: User must own the event (`event.owner_id === user_id`)
- **Lock Check**: OR user must hold valid lock (`lock_held_by === user_id` AND `lock_expires_at > now()`)
- **Error**: Return 403 Forbidden if neither condition met
- **Lock Conflict**: Return 403 with LOCK_HELD_BY_OTHER if lock held by another user

### Input Validation

- **Schema Validation**: Use Zod to validate request body structure
- **ID Validation**:
  - Ensure guest_id and table_id are non-empty strings
  - Validate they exist in current plan_data (prevents injection)
- **UUID Validation**: Validate event_id is properly formatted UUID
- **Sanitization**: No user input is directly executed; all IDs validated against database

### Data Integrity

- **Optimistic Locking**: Use `autosave_version` in WHERE clause to prevent race conditions
- **Transaction Safety**: Database updates should be atomic
- **Audit Trail**: All assignments logged to audit_log table

### Rate Limiting

- **General API Rate Limits**: Apply standard rate limiting per user/IP
- **No Special Limits**: This endpoint doesn't create resources, only modifies existing plan_data

### Potential Threats & Mitigations

| Threat                                                     | Mitigation                                                |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| **Race Condition**: Two users assign guest simultaneously  | Use optimistic locking via autosave_version match         |
| **Invalid References**: Assigning non-existent guest/table | Validate IDs exist in plan_data before assignment         |
| **Lock Bypass**: Circumvent edit lock protection           | Verify lock_expires_at > current time                     |
| **PII Exposure**: Guest data in logs                       | Audit logs restricted to event owner; acceptable exposure |
| **Double Assignment**: Guest assigned to multiple seats    | Remove from all seats before new assignment               |
| **Capacity Bypass**: Exceed table capacity                 | Validate empty seats exist before assignment              |

## 7. Performance Considerations

### Database Operations

- **Single Query Fetch**: One SELECT to retrieve event with plan_data
- **Single Update**: One UPDATE with JSONB modification
- **Single Audit Insert**: One INSERT to audit_log
- **Transaction**: Wrap update + audit in transaction for consistency

**Estimated Latency**: 50-150ms depending on plan_data size

### JSONB Performance

- **Plan Size Impact**: Large plan_data (>1000 tables/guests) may slow JSONB parsing
- **Indexing**: Consider GIN index on plan_data for future query optimization
- **Mitigation**: For MVP, JSONB is acceptable; future optimization could use relational tables

### Optimization Strategies

1. **Caching**: Consider caching event metadata (not plan_data) in Redis
2. **Partial Updates**: PostgreSQL supports JSONB partial updates via `jsonb_set`, but Supabase client doesn't expose this easily
3. **Connection Pooling**: Ensure Supabase client uses connection pooling
4. **Audit Batching**: Could batch audit logs if performance critical (not recommended for consistency)

### Scalability Limits

- **Plan Data Size**: JSONB limited to 1GB per row (PostgreSQL limit)
- **Concurrent Users**: Optimistic locking handles concurrency; high contention may cause retry loops
- **Table Capacity**: Algorithm is O(n) where n = table capacity; acceptable for typical event sizes (capacity < 100)

## 8. Implementation Steps

### Step 1: Define Zod Validation Schema

**File**: `src/lib/validation/assign-seat-schema.ts`

```typescript
import { z } from "zod";

export const assignGuestSeatSchema = z.object({
  guest_id: z.string().min(1, "guest_id is required"),
  table_id: z.string().min(1, "table_id is required"),
});

export type AssignGuestSeatInput = z.infer<typeof assignGuestSeatSchema>;
```

### Step 2: Create Seat Assignment Service

**File**: `src/lib/services/seat-assignment.service.ts`

```typescript
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AssignGuestSeatCommand, PlanDataDTO, TableDTO, UUID } from "../../types";
import { NotFoundError, ForbiddenError, ConflictError } from "../errors";

export interface AssignGuestSeatResponseDTO {
  table_id: string;
  seat_no: number;
  autosave_version: number;
}

export class SeatAssignmentService {
  /**
   * Assign guest to table with random seat selection
   */
  static async assignGuestToTable(
    supabase: SupabaseClient,
    userId: UUID,
    eventId: UUID,
    command: AssignGuestSeatCommand
  ): Promise<AssignGuestSeatResponseDTO> {
    // 1. Fetch event
    const { data: event, error } = await supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .is("deleted_at", null)
      .single();

    if (error || !event) {
      throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");
    }

    // 2. Authorization check
    const isOwner = event.owner_id === userId;
    const hasLock =
      event.lock_held_by === userId && event.lock_expires_at && new Date(event.lock_expires_at) > new Date();

    if (!isOwner && !hasLock) {
      if (event.lock_held_by) {
        throw new ForbiddenError("LOCK_HELD_BY_OTHER", "Event locked by another user", {
          held_by: event.lock_held_by,
          expires_at: event.lock_expires_at,
        });
      }
      throw new ForbiddenError("FORBIDDEN", "Permission denied");
    }

    // 3. Validate guest exists
    const planData = event.plan_data as PlanDataDTO;
    const guest = planData.guests.find((g) => g.id === command.guest_id);
    if (!guest) {
      throw new NotFoundError("GUEST_NOT_FOUND", "Guest not found", {
        guest_id: command.guest_id,
      });
    }

    // 4. Validate table exists
    const table = planData.tables.find((t) => t.id === command.table_id);
    if (!table) {
      throw new NotFoundError("TABLE_NOT_FOUND", "Table not found", {
        table_id: command.table_id,
      });
    }

    // 5. Find empty seats
    const emptySeats = this.findEmptySeats(table);
    if (emptySeats.length === 0) {
      throw new ConflictError("TABLE_FULL", "Table has no available seats", {
        table_id: table.id,
        capacity: table.capacity,
        assigned_seats: table.capacity,
      });
    }

    // 6. Select seat using deterministic random
    const selectedSeat = this.selectRandomSeat(emptySeats, eventId, command.guest_id);

    // 7. Remove guest from previous seats
    const previousSeat = this.removeGuestFromAllSeats(planData, command.guest_id);

    // 8. Assign guest to selected seat
    this.assignGuestToSeat(table, selectedSeat, command.guest_id);

    // 9. Update database
    const newVersion = event.autosave_version + 1;
    const { error: updateError } = await supabase
      .from("events")
      .update({
        plan_data: planData,
        autosave_version: newVersion,
        updated_at: new Date().toISOString(),
      })
      .eq("id", eventId)
      .eq("autosave_version", event.autosave_version); // Optimistic locking

    if (updateError) {
      // Check if version conflict
      if (updateError.code === "23505" || updateError.message.includes("version")) {
        throw new ConflictError("VERSION_CONFLICT", "Event was modified by another user");
      }
      throw updateError;
    }

    // 10. Create audit log
    await supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "seat_swap",
      details: {
        guest_id: command.guest_id,
        guest_name: guest.name,
        table_id: command.table_id,
        seat_no: selectedSeat,
        previous_seat: previousSeat,
        action: "assign",
      },
    });

    // 11. Return response
    return {
      table_id: command.table_id,
      seat_no: selectedSeat,
      autosave_version: newVersion,
    };
  }

  /**
   * Find all empty seat numbers in a table
   */
  private static findEmptySeats(table: TableDTO): number[] {
    const emptySeats: number[] = [];
    const occupiedSeats = new Set(table.seats.filter((s) => s.guest_id).map((s) => s.seat_no));

    for (let seatNo = 1; seatNo <= table.capacity; seatNo++) {
      if (!occupiedSeats.has(seatNo)) {
        emptySeats.push(seatNo);
      }
    }

    return emptySeats;
  }

  /**
   * Select random seat using deterministic hash
   */
  private static selectRandomSeat(emptySeats: number[], eventId: UUID, guestId: string): number {
    const seed = this.createHash(eventId + guestId);
    const index = seed % emptySeats.length;
    return emptySeats[index];
  }

  /**
   * Create numeric hash from string
   */
  private static createHash(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash);
  }

  /**
   * Remove guest from all seat assignments
   */
  private static removeGuestFromAllSeats(
    planData: PlanDataDTO,
    guestId: string
  ): { table_id: string; seat_no: number } | undefined {
    let previousSeat: { table_id: string; seat_no: number } | undefined;

    for (const table of planData.tables) {
      const seatIndex = table.seats.findIndex((s) => s.guest_id === guestId);
      if (seatIndex >= 0) {
        previousSeat = {
          table_id: table.id,
          seat_no: table.seats[seatIndex].seat_no,
        };
        // Remove guest_id, keep seat structure
        table.seats[seatIndex] = {
          seat_no: table.seats[seatIndex].seat_no,
        };
      }
    }

    return previousSeat;
  }

  /**
   * Assign guest to specific seat
   */
  private static assignGuestToSeat(table: TableDTO, seatNo: number, guestId: string): void {
    const existingSeatIndex = table.seats.findIndex((s) => s.seat_no === seatNo);

    if (existingSeatIndex >= 0) {
      table.seats[existingSeatIndex] = { seat_no: seatNo, guest_id: guestId };
    } else {
      table.seats.push({ seat_no: seatNo, guest_id: guestId });
    }

    // Keep seats sorted by seat_no
    table.seats.sort((a, b) => a.seat_no - b.seat_no);
  }
}
```

### Step 3: Create Custom Error Classes

**File**: `src/lib/errors.ts` (extend if not exists)

```typescript
export class NotFoundError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "NotFoundError";
    this.code = code;
    this.details = details;
  }
}

export class ForbiddenError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ForbiddenError";
    this.code = code;
    this.details = details;
  }
}

export class ConflictError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ConflictError";
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.details = details;
  }
}
```

### Step 4: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/plan/assign.ts`

```typescript
import type { APIRoute } from "astro";
import { assignGuestSeatSchema } from "../../../../../lib/validation/assign-seat-schema";
import { SeatAssignmentService } from "../../../../../lib/services/seat-assignment.service";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "../../../../../lib/errors";
import type { ApiErrorDTO } from "../../../../../types";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  try {
    // 1. Get Supabase client from locals
    const supabase = locals.supabase;
    if (!supabase) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            message: "Database client not available",
          },
        } as ApiErrorDTO),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Authenticate user
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(
        JSON.stringify({
          error: {
            code: "UNAUTHORIZED",
            message: "Valid authentication required",
          },
        } as ApiErrorDTO),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. Extract event_id from params
    const eventId = params.event_id;
    if (!eventId) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_REQUEST",
            message: "event_id is required",
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Parse and validate request body
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_REQUEST_BODY",
            message: "Invalid JSON in request body",
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const validation = assignGuestSeatSchema.safeParse(body);
    if (!validation.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_REQUEST_BODY",
            message: "Request validation failed",
            details: validation.error.flatten(),
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Call service layer
    const result = await SeatAssignmentService.assignGuestToTable(supabase, user.id, eventId, validation.data);

    // 6. Return success response
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

    if (error instanceof ValidationError) {
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

    // Generic server error
    console.error("Unexpected error in assign endpoint:", error);
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

### Step 5: Add Unit Tests

**File**: `tests/services/seat-assignment.service.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { SeatAssignmentService } from "../../src/lib/services/seat-assignment.service";
import { NotFoundError, ForbiddenError, ConflictError } from "../../src/lib/errors";
import type { PlanDataDTO, TableDTO } from "../../src/types";

describe("SeatAssignmentService", () => {
  describe("assignGuestToTable", () => {
    it("should assign guest to random empty seat", async () => {
      // Mock Supabase and test successful assignment
      // Implementation depends on your test setup
    });

    it("should throw EVENT_NOT_FOUND when event does not exist", async () => {
      // Test implementation
    });

    it("should throw FORBIDDEN when user is not owner", async () => {
      // Test implementation
    });

    it("should throw GUEST_NOT_FOUND when guest does not exist", async () => {
      // Test implementation
    });

    it("should throw TABLE_NOT_FOUND when table does not exist", async () => {
      // Test implementation
    });

    it("should throw TABLE_FULL when no seats available", async () => {
      // Test implementation
    });

    it("should remove guest from previous seat before assignment", async () => {
      // Test implementation
    });

    it("should increment autosave_version", async () => {
      // Test implementation
    });

    it("should create audit log entry", async () => {
      // Test implementation
    });
  });

  describe("findEmptySeats", () => {
    it("should return all seat numbers when table is empty", () => {
      const table: TableDTO = {
        id: "t1",
        shape: "round",
        capacity: 5,
        start_index: 1,
        head_seat: 1,
        seats: [],
      };

      const emptySeats = SeatAssignmentService["findEmptySeats"](table);
      expect(emptySeats).toEqual([1, 2, 3, 4, 5]);
    });

    it("should return only unoccupied seat numbers", () => {
      const table: TableDTO = {
        id: "t1",
        shape: "round",
        capacity: 5,
        start_index: 1,
        head_seat: 1,
        seats: [
          { seat_no: 1, guest_id: "g1" },
          { seat_no: 3, guest_id: "g2" },
        ],
      };

      const emptySeats = SeatAssignmentService["findEmptySeats"](table);
      expect(emptySeats).toEqual([2, 4, 5]);
    });

    it("should return empty array when table is full", () => {
      const table: TableDTO = {
        id: "t1",
        shape: "round",
        capacity: 3,
        start_index: 1,
        head_seat: 1,
        seats: [
          { seat_no: 1, guest_id: "g1" },
          { seat_no: 2, guest_id: "g2" },
          { seat_no: 3, guest_id: "g3" },
        ],
      };

      const emptySeats = SeatAssignmentService["findEmptySeats"](table);
      expect(emptySeats).toEqual([]);
    });
  });

  describe("selectRandomSeat", () => {
    it("should return deterministic result for same inputs", () => {
      const emptySeats = [1, 2, 3, 4, 5];
      const eventId = "event-123";
      const guestId = "guest-456";

      const seat1 = SeatAssignmentService["selectRandomSeat"](emptySeats, eventId, guestId);
      const seat2 = SeatAssignmentService["selectRandomSeat"](emptySeats, eventId, guestId);

      expect(seat1).toBe(seat2);
    });

    it("should return different seats for different guests", () => {
      const emptySeats = [1, 2, 3, 4, 5];
      const eventId = "event-123";

      const seat1 = SeatAssignmentService["selectRandomSeat"](emptySeats, eventId, "guest-1");
      const seat2 = SeatAssignmentService["selectRandomSeat"](emptySeats, eventId, "guest-2");

      // High probability of being different (not guaranteed due to hash collision)
      // In practice, different inputs should produce different results
    });
  });

  describe("removeGuestFromAllSeats", () => {
    it("should remove guest from all tables", () => {
      const planData: PlanDataDTO = {
        tables: [
          {
            id: "t1",
            shape: "round",
            capacity: 5,
            start_index: 1,
            head_seat: 1,
            seats: [{ seat_no: 2, guest_id: "g1" }],
          },
          {
            id: "t2",
            shape: "rectangular",
            capacity: 8,
            start_index: 1,
            head_seat: 1,
            seats: [{ seat_no: 5, guest_id: "g2" }],
          },
        ],
        guests: [],
        settings: { color_palette: "default" },
      };

      const previous = SeatAssignmentService["removeGuestFromAllSeats"](planData, "g1");

      expect(previous).toEqual({ table_id: "t1", seat_no: 2 });
      expect(planData.tables[0].seats[0].guest_id).toBeUndefined();
    });

    it("should return undefined if guest not seated", () => {
      const planData: PlanDataDTO = {
        tables: [
          {
            id: "t1",
            shape: "round",
            capacity: 5,
            start_index: 1,
            head_seat: 1,
            seats: [],
          },
        ],
        guests: [],
        settings: { color_palette: "default" },
      };

      const previous = SeatAssignmentService["removeGuestFromAllSeats"](planData, "g1");

      expect(previous).toBeUndefined();
    });
  });
});
```

### Step 6: Integration Testing

**File**: `tests/integration/assign-seat.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createSupabaseClient } from "../../src/db/supabase.client";

describe("POST /api/events/{event_id}/plan/assign", () => {
  let authToken: string;
  let eventId: string;

  beforeAll(async () => {
    // Set up test user, event, table, and guest
    // Implementation depends on your test infrastructure
  });

  afterAll(async () => {
    // Clean up test data
  });

  it("should assign guest to table successfully", async () => {
    const response = await fetch(`/api/events/${eventId}/plan/assign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        guest_id: "g1",
        table_id: "t1",
      }),
    });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty("table_id", "t1");
    expect(data).toHaveProperty("seat_no");
    expect(data).toHaveProperty("autosave_version");
    expect(data.seat_no).toBeGreaterThanOrEqual(1);
  });

  it("should return 404 when guest not found", async () => {
    const response = await fetch(`/api/events/${eventId}/plan/assign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        guest_id: "invalid-guest",
        table_id: "t1",
      }),
    });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error.code).toBe("GUEST_NOT_FOUND");
  });

  it("should return 409 when table is full", async () => {
    // Pre-fill table to capacity
    // Then attempt assignment

    const response = await fetch(`/api/events/${eventId}/plan/assign`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        guest_id: "g2",
        table_id: "t1",
      }),
    });

    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.error.code).toBe("TABLE_FULL");
  });

  it("should return 401 when not authenticated", async () => {
    const response = await fetch(`/api/events/${eventId}/plan/assign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        guest_id: "g1",
        table_id: "t1",
      }),
    });

    expect(response.status).toBe(401);
  });
});
```

### Step 7: Update API Documentation

**File**: `.ai/api-plan.md` (ensure endpoint documented accurately)

Verify the endpoint specification matches implementation:

- Request/response formats
- Error codes
- Business logic description

### Step 8: Manual Testing Checklist

1. **Happy Path**
   - [ ] Assign unseated guest to empty table
   - [ ] Verify seat_no returned is valid (1 ≤ seat_no ≤ capacity)
   - [ ] Verify autosave_version incremented
   - [ ] Verify audit_log entry created

2. **Guest Previously Seated**
   - [ ] Assign already-seated guest to different table
   - [ ] Verify guest removed from previous seat
   - [ ] Verify only one seat assignment exists for guest

3. **Edge Cases**
   - [ ] Assign to table with 1 remaining seat
   - [ ] Verify deterministic randomization (same guest+event = same seat)
   - [ ] Assign multiple guests to same table sequentially

4. **Error Scenarios**
   - [ ] Invalid event_id returns 404
   - [ ] Invalid guest_id returns 404
   - [ ] Invalid table_id returns 404
   - [ ] Full table returns 409
   - [ ] Non-owner without lock returns 403
   - [ ] Expired lock returns 403

5. **Performance**
   - [ ] Test with large plan_data (100+ tables, 1000+ guests)
   - [ ] Measure response time < 200ms for typical event

### Step 9: Deployment Preparation

1. **Environment Variables**: Ensure Supabase URL and anon key configured
2. **Database Migrations**: Verify events, audit_log tables exist with correct schema
3. **Permissions**: Verify RLS policies allow authenticated users to update own events
4. **Monitoring**: Set up logging for errors and performance metrics
5. **Rate Limiting**: Configure API rate limits at infrastructure level

---

## Summary

This implementation plan provides a complete blueprint for the `POST /api/events/{event_id}/plan/assign` endpoint. The key features include:

- **Deterministic Randomization**: Uses hash-based seat selection for consistent results
- **Comprehensive Validation**: Multi-layer validation from schema to business logic
- **Robust Error Handling**: Detailed error responses with appropriate HTTP status codes
- **Audit Trail**: All assignments logged for accountability
- **Optimistic Locking**: Prevents race conditions via autosave_version
- **Security**: Proper authentication and authorization checks

The service layer is decoupled from the API route for testability, and the implementation follows the project's coding standards for clean, maintainable code.
