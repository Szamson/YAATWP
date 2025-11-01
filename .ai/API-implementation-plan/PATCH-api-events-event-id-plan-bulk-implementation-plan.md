# API Endpoint Implementation Plan: PATCH /api/events/{event_id}/plan/bulk

## 1. Endpoint Overview

The bulk plan operations endpoint enables atomic application of multiple plan modification operations in a single request. This endpoint is critical for implementing undo/redo functionality and allows efficient batch updates to the seating plan while maintaining data consistency through optimistic locking.

**Key Features:**

- Atomic execution of multiple operations (all succeed or all fail)
- Optimistic concurrency control using version numbers
- Support for 11 operation types covering all plan modification scenarios
- Automatic snapshot creation for structural changes
- Comprehensive audit logging of each operation
- Lock validation to prevent concurrent modifications

**Use Cases:**

- Undo/redo stack application (replay multiple operations)
- Batch imports or migrations
- Complex multi-step plan updates requiring atomicity

## 2. Request Details

### HTTP Method

`PATCH`

### URL Structure

```
/api/events/{event_id}/plan/bulk
```

### Path Parameters

- `event_id` (UUID, required): The unique identifier of the event whose plan is being modified

### Headers

- `Authorization`: `Bearer <JWT_token>` (required)
- `If-Match`: `<autosave_version>` (required) - Current autosave version for optimistic locking
- `Content-Type`: `application/json` (required)

### Request Body

```typescript
{
  "version": number,        // Must match If-Match header and current autosave_version
  "ops": PlanOperation[]    // Array of 1-100 operations to apply atomically
}
```

### Supported Operations

#### 1. add_table

```json
{
  "op": "add_table",
  "table": {
    "id": "string",
    "shape": "round" | "rectangular" | "long",
    "capacity": number,
    "label": "string",
    "start_index": number,
    "head_seat": number
  }
}
```

#### 2. update_table

```json
{
  "op": "update_table",
  "id": "string",
  "patch": {
    "shape": "round" | "rectangular" | "long",
    "capacity": number,
    "label": "string",
    "start_index": number,
    "head_seat": number
  }
}
```

#### 3. remove_table

```json
{
  "op": "remove_table",
  "id": "string"
}
```

#### 4. add_guest

```json
{
  "op": "add_guest",
  "guest": {
    "id": "string",
    "name": "string",
    "note": "string",
    "tag": "string",
    "rsvp": "string"
  }
}
```

#### 5. update_guest

```json
{
  "op": "update_guest",
  "id": "string",
  "patch": {
    "name": "string",
    "note": "string",
    "tag": "string",
    "rsvp": "string"
  }
}
```

#### 6. remove_guest

```json
{
  "op": "remove_guest",
  "id": "string"
}
```

#### 7. assign_guest_seat

```json
{
  "op": "assign_guest_seat",
  "guest_id": "string",
  "table_id": "string",
  "seat_no": number  // Optional: if omitted, assigns to first available seat
}
```

#### 8. swap_seats

```json
{
  "op": "swap_seats",
  "a": { "table_id": "string", "seat_no": number },
  "b": { "table_id": "string", "seat_no": number }
}
```

#### 9. move_guest_table

```json
{
  "op": "move_guest_table",
  "guest_id": "string",
  "to_table_id": "string",
  "seat_no": number  // Optional: if omitted, assigns to first available seat
}
```

#### 10. change_seat_order_settings

```json
{
  "op": "change_seat_order_settings",
  "table_id": "string",
  "start_index": number,
  "head_seat": number,
  "direction": "clockwise"  // Optional
}
```

### Validation Rules

**Request-Level:**

- `event_id`: Must be valid UUID format
- `If-Match` header: Must be present and contain valid integer
- `version`: Must match `If-Match` header value
- `ops`: Must be non-empty array with 1-100 operations

**Operation-Level:**

- Each operation must have valid `op` field matching supported types
- All required fields for each operation type must be present
- Field types must match expected types
- Business rules validation (see Data Flow section)

## 3. Used Types

### Command Models

```typescript
import type { BulkPlanOpsCommand, PlanOperation, SeatRefDTO } from "@/types";
```

### DTOs

```typescript
import type { EventDTO, PlanDataDTO, TableDTO, GuestDTO, SeatAssignmentDTO, ApiErrorDTO } from "@/types";
```

### Internal Types

```typescript
// For validation and operation processing
interface OperationContext {
  currentPlanData: PlanDataDTO;
  event: DBEventRow;
  userId: UUID;
}

interface OperationResult {
  updatedPlanData: PlanDataDTO;
  auditEntries: AuditLogEntry[];
  requiresSnapshot: boolean;
}

interface AuditLogEntry {
  action_type: Enums<"action_type_enum">;
  details: Record<string, unknown>;
}
```

### Zod Schemas (for validation)

```typescript
// Create comprehensive schemas for each operation type
const AddTableOpSchema = z.object({
  op: z.literal("add_table"),
  table: TableDTOSchema.omit({ seats: true }),
});

const UpdateTableOpSchema = z.object({
  op: z.literal("update_table"),
  id: z.string().min(1),
  patch: TableDTOSchema.omit({ id: true, seats: true }).partial(),
});

// ... similar schemas for all 11 operation types

const PlanOperationSchema = z.discriminatedUnion("op", [
  AddTableOpSchema,
  UpdateTableOpSchema,
  RemoveTableOpSchema,
  // ... all operation schemas
]);

const BulkPlanOpsRequestSchema = z.object({
  version: z.number().int().min(0),
  ops: z.array(PlanOperationSchema).min(1).max(100),
});
```

## 4. Response Details

### Success Response (200 OK)

```json
{
  "autosave_version": 4,
  "plan_data": {
    "tables": [
      /* full or partial table array */
    ],
    "guests": [
      /* full or partial guest array */
    ],
    "settings": {
      /* settings object */
    }
  },
  "applied_ops": 3
}
```

**Fields:**

- `autosave_version`: New version number after operations applied
- `plan_data`: Updated plan data (may return full or diff-only to optimize payload)
- `applied_ops`: Number of operations successfully applied

### Error Responses

#### 400 Bad Request

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Operation validation failed",
    "details": {
      "operation_index": 2,
      "operation_type": "assign_guest_seat",
      "field": "seat_no",
      "reason": "Seat number exceeds table capacity"
    }
  }
}
```

**Error Codes:**

- `INVALID_REQUEST_BODY`: Malformed JSON or missing required fields
- `EMPTY_OPERATIONS`: ops array is empty
- `TOO_MANY_OPERATIONS`: ops array exceeds 100 items
- `INVALID_OPERATION`: Operation type not recognized or malformed
- `VALIDATION_ERROR`: Operation failed business rules validation
- `TABLE_NOT_FOUND`: Referenced table does not exist
- `GUEST_NOT_FOUND`: Referenced guest does not exist
- `CAPACITY_EXCEEDED`: Operation would exceed table capacity
- `DUPLICATE_ID`: Attempting to add entity with existing ID
- `SEAT_OCCUPIED`: Attempting to assign to occupied seat
- `GUEST_NOT_SEATED`: Operation requires guest to be seated but isn't
- `TABLE_HAS_GUESTS`: Attempting to remove table with seated guests

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
    "message": "You do not have permission to modify this event"
  }
}
```

#### 404 Not Found

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found or has been deleted"
  }
}
```

#### 409 Conflict

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "Plan has been modified by another user. Please refresh and retry.",
    "details": {
      "current_version": 5,
      "provided_version": 3
    }
  }
}
```

#### 423 Locked

```json
{
  "error": {
    "code": "LOCKED",
    "message": "Plan is currently locked by another user",
    "details": {
      "locked_by": "uuid",
      "expires_at": "2025-11-01T15:30:00Z"
    }
  }
}
```

#### 500 Internal Server Error

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred while processing operations"
  }
}
```

**Error Codes:**

- `TRANSACTION_FAILED`: Database transaction failed and rolled back
- `INTERNAL_ERROR`: Unexpected server error

## 5. Data Flow

### High-Level Flow

```
1. Authenticate user via JWT
2. Parse and validate request body with Zod
3. Begin database transaction
4. Fetch event with SELECT FOR UPDATE (row lock)
5. Validate event ownership and lock status
6. Check version match (optimistic locking)
7. Apply operations sequentially to plan_data clone
8. Validate final plan_data integrity
9. Update event with new plan_data and incremented version
10. Create audit log entries for each operation
11. Check if automatic snapshot needed
12. Commit transaction
13. Return success response with new version
```

### Detailed Service Architecture

#### 1. Route Handler (`src/pages/api/events/[event_id]/plan/bulk.ts`)

```typescript
export const prerender = false;

export async function PATCH(context: APIContext): Promise<Response> {
  const supabase = context.locals.supabase;
  const userId = await getUserIdFromAuth(supabase);

  if (!userId) {
    return jsonError(401, "UNAUTHORIZED", "Authentication required");
  }

  // Extract path params and headers
  const eventId = context.params.event_id;
  const ifMatch = context.request.headers.get("If-Match");

  // Parse and validate request body
  const body = await context.request.json();
  const validationResult = validateBulkPlanOpsRequest(body, ifMatch);

  if (!validationResult.success) {
    return jsonError(400, "INVALID_REQUEST_BODY", validationResult.error);
  }

  // Execute business logic via service
  const result = await PlanOperationsService.applyBulkOperations(supabase, eventId, userId, validationResult.data);

  if (result.error) {
    return jsonError(result.statusCode, result.error.code, result.error.message, result.error.details);
  }

  return new Response(JSON.stringify(result.data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
```

#### 2. PlanOperationsService (`src/lib/services/plan-operations.service.ts`)

**Main Method:**

```typescript
async applyBulkOperations(
  supabase: SupabaseClient,
  eventId: UUID,
  userId: UUID,
  command: BulkPlanOpsCommand
): Promise<ServiceResult<BulkPlanOpsResponse>>
```

**Transaction Flow:**

```typescript
1. Begin transaction
2. SELECT * FROM events
   WHERE id = eventId
   AND deleted_at IS NULL
   FOR UPDATE

3. Validate event exists
4. Validate ownership (owner_id = userId)
5. Validate lock (lock_held_by IS NULL OR lock_held_by = userId OR lock_expires_at < NOW())
6. Validate version (autosave_version = command.version)

7. Clone current plan_data
8. For each operation in command.ops:
   - Validate operation against current state
   - Apply operation to cloned plan_data
   - Generate audit log entry
   - Track if structural change occurred

9. Validate final plan_data integrity:
   - No orphaned guest references
   - All seat assignments within capacity
   - All IDs unique within their collections

10. UPDATE events SET
    plan_data = updatedPlanData,
    autosave_version = autosave_version + 1,
    updated_at = NOW()
    WHERE id = eventId

11. INSERT audit log entries (batch)

12. If structural changes detected:
    - Create automatic snapshot

13. Commit transaction
14. Return success with new version and plan_data
```

**Operation Validators (one per operation type):**

```typescript
validateAddTable(table: TableDTO, currentPlan: PlanDataDTO): ValidationResult
validateUpdateTable(id: string, patch: Partial<TableDTO>, currentPlan: PlanDataDTO): ValidationResult
validateRemoveTable(id: string, currentPlan: PlanDataDTO): ValidationResult
// ... for all 11 operation types
```

**Operation Appliers (pure functions):**

```typescript
applyAddTable(planData: PlanDataDTO, table: TableDTO): PlanDataDTO
applyUpdateTable(planData: PlanDataDTO, id: string, patch: Partial<TableDTO>): PlanDataDTO
applyRemoveTable(planData: PlanDataDTO, id: string): PlanDataDTO
// ... for all 11 operation types
```

#### 3. AuditService (`src/lib/services/audit.service.ts`)

```typescript
async logOperations(
  supabase: SupabaseClient,
  eventId: UUID,
  userId: UUID,
  operations: PlanOperation[]
): Promise<void>
```

Maps each operation type to corresponding `action_type_enum` and stores operation details in JSONB `details` column.

#### 4. SnapshotService (`src/lib/services/snapshot.service.ts`)

```typescript
async createAutomaticSnapshot(
  supabase: SupabaseClient,
  eventId: UUID,
  userId: UUID,
  planData: PlanDataDTO,
  reason: string
): Promise<void>
```

Creates snapshot when structural changes detected (table capacity change, grid resize, etc.).

### Operation Processing Details

#### Add Table

1. Validate table ID doesn't exist
2. Validate shape is valid enum value
3. Validate capacity > 0
4. Validate start_index >= 1
5. Validate head_seat between 1 and capacity
6. Initialize empty seats array
7. Add table to plan_data.tables

#### Update Table

1. Find table by ID (error if not found)
2. If capacity changed:
   - Check new capacity >= current seated count
   - Adjust seats array length if needed
3. Apply patch to table
4. Mark as structural change if capacity changed

#### Remove Table

1. Find table by ID (error if not found)
2. Check if any guests seated (error if yes)
3. Remove table from plan_data.tables

#### Add Guest

1. Validate guest ID doesn't exist
2. Validate name is 1-150 characters
3. Add guest to plan_data.guests

#### Update Guest

1. Find guest by ID (error if not found)
2. Apply patch to guest
3. If name changed, validate length

#### Remove Guest

1. Find guest by ID (error if not found)
2. Remove from all seat assignments across all tables
3. Remove from plan_data.guests

#### Assign Guest Seat

1. Validate guest exists
2. Validate table exists
3. If seat_no provided:
   - Validate within table capacity
   - Validate seat not occupied
   - Assign to specific seat
4. If seat_no not provided:
   - Find first available seat
   - Error if table full
5. Remove guest from any previous seat assignment
6. Add assignment to target seat

#### Swap Seats

1. Validate both seats exist and within capacity
2. Get guest_id from both seats (may be undefined)
3. Swap the guest_id values

#### Move Guest Table

1. Validate guest exists and is currently seated
2. Remove from current seat
3. Apply assign_guest_seat logic to target table

#### Change Seat Order Settings

1. Validate table exists
2. Validate start_index >= 1
3. Validate head_seat between 1 and capacity
4. Update table start_index and head_seat
5. If direction provided, validate enum value

## 6. Security Considerations

### Authentication

- **JWT Validation**: Verify Bearer token using Supabase auth
- **User Extraction**: Extract user_id from validated JWT
- **Session Validity**: Ensure token not expired

### Authorization

- **Ownership Check**: Verify `events.owner_id = userId`
- **Lock Validation**: Ensure plan not locked by another user
  - Check `lock_held_by IS NULL` OR
  - `lock_held_by = userId` OR
  - `lock_expires_at < NOW()`

### Concurrency Control

- **Optimistic Locking**: Use `If-Match` header with `autosave_version`
- **Row Locking**: Use `SELECT FOR UPDATE` to prevent concurrent modifications during transaction
- **Version Increment**: Atomically increment `autosave_version` on success
- **Conflict Detection**: Return 409 if version mismatch

### Input Validation

- **Schema Validation**: Use Zod schemas for type-safe validation
- **Sanitization**: Trim and sanitize text inputs (name, label, note)
- **Length Limits**: Enforce maximum lengths (name ≤150, etc.)
- **Enum Validation**: Ensure shape and other enums match allowed values
- **Range Validation**: capacity >0, seat_no within 1..capacity
- **ID Format**: Validate UUID format where applicable

### Rate Limiting

- **Operation Count**: Limit to 100 operations per request
- **Payload Size**: Enforce maximum request body size (e.g., 1MB)
- **Request Rate**: Consider implementing rate limiting per user/IP

### SQL Injection Prevention

- **Parameterized Queries**: Use Supabase client parameterized methods
- **No Raw SQL**: Avoid string concatenation in queries
- **JSONB Safety**: Use JSONB operators safely with parameterized values

### Data Integrity

- **Transaction Atomicity**: All operations succeed or all fail
- **Referential Integrity**: Validate guest/table references before operations
- **Orphan Prevention**: Check for seated guests before table deletion
- **Capacity Enforcement**: Prevent capacity overflow
- **Duplicate Prevention**: Check ID uniqueness on add operations

### GDPR/CCPA Compliance

- **Audit Trail**: Log all modifications for compliance
- **PII Handling**: Treat guest names and notes as PII
- **Data Minimization**: Only log necessary operation details
- **Right to Erasure**: Ensure remove_guest operations are auditable

## 7. Error Handling

### Error Response Structure

All errors follow `ApiErrorDTO` format:

```typescript
{
  error: {
    code: string,
    message: string,
    details?: Record<string, unknown>
  }
}
```

### Error Scenarios

#### Client Errors (4xx)

| Status | Code                 | Trigger                             | Response Action                           |
| ------ | -------------------- | ----------------------------------- | ----------------------------------------- |
| 400    | INVALID_REQUEST_BODY | Malformed JSON, missing fields      | Return Zod validation errors              |
| 400    | EMPTY_OPERATIONS     | ops array is empty                  | Return clear message                      |
| 400    | TOO_MANY_OPERATIONS  | ops.length > 100                    | Return limit info                         |
| 400    | INVALID_OPERATION    | Unknown op type or malformed        | Return operation index and details        |
| 400    | VALIDATION_ERROR     | Business rule violation             | Return operation index, field, and reason |
| 400    | TABLE_NOT_FOUND      | Referenced table doesn't exist      | Return table_id                           |
| 400    | GUEST_NOT_FOUND      | Referenced guest doesn't exist      | Return guest_id                           |
| 400    | CAPACITY_EXCEEDED    | Assignment exceeds capacity         | Return table_id and current/max capacity  |
| 400    | DUPLICATE_ID         | ID already exists                   | Return duplicate ID                       |
| 400    | SEAT_OCCUPIED        | Seat already has guest              | Return table_id and seat_no               |
| 400    | GUEST_NOT_SEATED     | Guest must be seated for operation  | Return guest_id                           |
| 400    | TABLE_HAS_GUESTS     | Cannot remove table with guests     | Return table_id and guest count           |
| 401    | UNAUTHORIZED         | Missing/invalid JWT                 | Return auth error                         |
| 403    | FORBIDDEN            | Not event owner                     | Return ownership message                  |
| 404    | EVENT_NOT_FOUND      | Event doesn't exist or soft-deleted | Return generic not found                  |
| 409    | VERSION_CONFLICT     | autosave_version mismatch           | Return current and provided versions      |
| 423    | LOCKED               | Lock held by another user           | Return lock holder and expiry             |

#### Server Errors (5xx)

| Status | Code               | Trigger                    | Response Action                                    |
| ------ | ------------------ | -------------------------- | -------------------------------------------------- |
| 500    | TRANSACTION_FAILED | Database transaction error | Log error, rollback, return generic message        |
| 500    | INTERNAL_ERROR     | Unexpected error           | Log error with stack trace, return generic message |

### Error Logging Strategy

**Client Errors (4xx):**

- Log to application logs with INFO level
- Include user_id, event_id, operation details
- Do NOT log sensitive PII

**Server Errors (5xx):**

- Log to application logs with ERROR level
- Include full stack trace
- Include request context (user_id, event_id)
- Alert monitoring system for 500 errors

**Audit Trail:**

- Log successful operations to audit_log table
- For failed transactions, consider logging failed attempt with reason

### Rollback Strategy

- All operations within single database transaction
- On any validation failure: ROLLBACK entire transaction
- On database error: ROLLBACK and return 500
- No partial application of operations

## 8. Performance Considerations

### Database Performance

**Transaction Duration:**

- Keep transaction time minimal
- Complete all validations before starting transaction where possible
- Use single UPDATE statement for event modification

**Indexing Requirements:**

- Index on `events.id` (primary key)
- Index on `events.owner_id` for ownership checks
- Index on `events.autosave_version` for optimistic locking queries
- Consider GIN index on `plan_data` JSONB for complex queries (future)

**Query Optimization:**

- Use `SELECT FOR UPDATE` only on necessary row
- Fetch only required columns if possible
- Batch INSERT for audit log entries

### JSONB Performance

**Operations on plan_data:**

- Clone plan_data in memory for modifications (avoid multiple JSONB updates)
- Single JSONB replacement on final UPDATE
- Consider JSONB size limits (avoid extremely large plans)

**Optimization Strategies:**

- For very large plans (>1000 guests/tables), consider pagination warnings
- Stream JSONB parsing for large payloads
- Consider response compression for large plan_data returns

### Memory Management

**Large Operation Batches:**

- 100 operation limit prevents excessive memory usage
- Clone plan_data once, modify in place
- Release references after transaction

**Audit Log Batching:**

- Batch INSERT audit entries (single query with multiple rows)
- Limit details JSONB size per entry

### Response Optimization

**Payload Reduction:**

- Option 1: Return full plan_data (simpler, consistent)
- Option 2: Return diff only (complex, reduces bandwidth)
- Recommendation: Start with full plan_data, add diff option later if needed

**Caching Considerations:**

- Response not cacheable due to mutation
- Consider ETags based on autosave_version for conditional requests

### Concurrency Performance

**Lock Contention:**

- `SELECT FOR UPDATE` blocks concurrent modifications
- Keep transaction short to minimize blocking
- Consider lock timeout (PostgreSQL statement_timeout)

**Optimistic Locking Benefits:**

- Allows multiple readers during modifications
- Only blocks on actual UPDATE
- Client handles retries on version conflicts

### Monitoring Metrics

**Track:**

- Average transaction duration
- Operation count distribution
- Version conflict rate
- Lock timeout rate
- Error rate by error code
- Response payload size distribution

## 9. Implementation Steps

### Phase 1: Setup and Scaffolding

1. **Create Zod Validation Schemas** (`src/lib/validation/plan-operations.schema.ts`)
   - Define schemas for all 11 operation types
   - Create discriminated union schema for PlanOperation
   - Create BulkPlanOpsRequestSchema
   - Export validation helper function

2. **Create Service Files**
   - Create `src/lib/services/plan-operations.service.ts`
   - Create `src/lib/services/audit.service.ts` (if not exists)
   - Create `src/lib/services/snapshot.service.ts` (if not exists)
   - Create `src/lib/helpers/error-response.ts` for error utilities

3. **Define Internal Types** (`src/lib/types/internal.ts`)
   - OperationContext
   - OperationResult
   - ValidationResult
   - ServiceResult generic type
   - AuditLogEntry

### Phase 2: Core Service Implementation

4. **Implement Operation Validators** (`src/lib/services/plan-operations/validators.ts`)
   - `validateAddTable()`
   - `validateUpdateTable()`
   - `validateRemoveTable()`
   - `validateAddGuest()`
   - `validateUpdateGuest()`
   - `validateRemoveGuest()`
   - `validateAssignGuestSeat()`
   - `validateSwapSeats()`
   - `validateMoveGuestTable()`
   - `validateChangeSeatOrderSettings()`
   - `validatePlanDataIntegrity()` - final consistency check

5. **Implement Operation Appliers** (`src/lib/services/plan-operations/appliers.ts`)
   - Implement pure functions for each operation type
   - Ensure immutable operations (return new plan_data)
   - Handle edge cases (e.g., removing guest from all seats)

6. **Implement PlanOperationsService.applyBulkOperations()**
   - Set up transaction handling
   - Implement event fetching with SELECT FOR UPDATE
   - Implement ownership and lock validation
   - Implement version checking
   - Implement operation loop with validation and application
   - Implement final integrity check
   - Implement event update with version increment

### Phase 3: Audit and Snapshot Integration

7. **Implement AuditService.logOperations()**
   - Map operation types to action_type_enum values
   - Create batch INSERT for audit log entries
   - Handle transaction participation

8. **Implement Snapshot Detection Logic**
   - Define structural change detection rules
   - Integrate SnapshotService.createAutomaticSnapshot()
   - Determine snapshot trigger criteria

### Phase 4: API Route Implementation

9. **Create Route Handler** (`src/pages/api/events/[event_id]/plan/bulk.ts`)
   - Set up prerender = false
   - Implement PATCH handler
   - Add authentication via context.locals.supabase
   - Add request parsing and validation
   - Call PlanOperationsService
   - Handle success/error responses
   - Add proper Content-Type headers

10. **Implement Error Response Helpers**
    - Create `jsonError()` utility
    - Map service errors to HTTP status codes
    - Format ApiErrorDTO responses

### Phase 5: Testing and Validation

11. **Unit Tests for Validators**
    - Test each validator with valid and invalid inputs
    - Test boundary conditions (capacity limits, etc.)
    - Test cross-validation (e.g., guest references)

12. **Unit Tests for Appliers**
    - Test each applier produces correct plan_data
    - Test immutability
    - Test edge cases (empty seats, etc.)

13. **Integration Tests for Service**
    - Test successful operation application
    - Test version conflict detection
    - Test lock validation
    - Test transaction rollback on errors
    - Test audit log creation
    - Test snapshot triggering

14. **End-to-End Tests for Route**
    - Test full request/response cycle
    - Test authentication/authorization
    - Test all error scenarios
    - Test concurrent request handling
    - Test large operation batches

### Phase 6: Performance and Security Review

15. **Performance Testing**
    - Load test with varying operation counts
    - Measure transaction duration
    - Test with large plan_data sizes
    - Optimize slow queries

16. **Security Audit**
    - Review all validation logic
    - Test SQL injection attempts
    - Test authorization bypass attempts
    - Test rate limiting effectiveness
    - Review audit logging coverage

### Phase 7: Documentation and Deployment

17. **API Documentation**
    - Document all operation types with examples
    - Document error codes and scenarios
    - Add integration examples for frontend
    - Document versioning and conflict resolution

18. **Monitoring Setup**
    - Add performance metrics collection
    - Set up error rate alerts
    - Configure transaction duration monitoring
    - Add version conflict rate tracking

19. **Deployment**
    - Deploy to staging environment
    - Run smoke tests
    - Monitor initial usage
    - Deploy to production
    - Monitor performance and errors

### Implementation Order Rationale

The implementation follows a bottom-up approach:

1. Start with pure validation and application logic (testable in isolation)
2. Build service layer integrating validators and appliers
3. Add cross-cutting concerns (audit, snapshots)
4. Implement API route handler
5. Comprehensive testing at each layer
6. Performance optimization and security hardening
7. Documentation and deployment

This order allows early detection of logic errors, easier debugging, and incremental integration testing.

---

## Appendix: Operation-to-Audit-Type Mapping

| Operation Type             | Audit action_type_enum       |
| -------------------------- | ---------------------------- |
| add_table                  | table_create                 |
| update_table               | table_update                 |
| remove_table               | table_update (deletion flag) |
| add_guest                  | guest_add                    |
| update_guest               | guest_edit                   |
| remove_guest               | guest_delete                 |
| assign_guest_seat          | seat_swap (or new type)      |
| swap_seats                 | seat_swap                    |
| move_guest_table           | seat_swap                    |
| change_seat_order_settings | seat_order_changed           |

**Note:** May need to extend `action_type_enum` to include more granular types if needed.

---

## Appendix: Structural Change Detection Rules

Operations that trigger automatic snapshot creation:

- `update_table` with `capacity` change
- Grid size changes (requires separate endpoint, not in bulk ops)
- Any operation that causes cascading changes (e.g., table removal unseating multiple guests)

Operations that do NOT trigger snapshots:

- Guest name/note edits
- Seat assignments/swaps (unless crossing capacity boundary)
- Table label changes
- Seat order setting changes (cosmetic)

**Recommendation:** Implement configurable snapshot policy (e.g., snapshot every N operations or every M minutes of activity).
