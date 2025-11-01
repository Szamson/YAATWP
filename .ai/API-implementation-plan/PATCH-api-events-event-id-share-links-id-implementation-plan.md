# API Endpoint Implementation Plan: PATCH /api/events/{event_id}/share-links/{id}

## 1. Endpoint Overview

This endpoint allows authenticated users to update mutable fields of an existing share link for a specific event. The owner of the event can modify the password protection, expiration timestamp, and PII inclusion settings of the share link.

**Key Capabilities:**

- Rotate or set a new password for the share link
- Remove password protection by setting `password: ""`
- Update or remove the expiration timestamp
- Toggle whether PII (Personally Identifiable Information) is included in the shared view
- Partial updates supported (only changed fields need to be provided)

**Business Rules:**

- Only the event owner can update share links
- At least one field must be provided for update
- Cannot update revoked share links
- Password must be at least 8 characters when set (non-empty)
- Expiration timestamp must be in the future if provided
- All changes are audited in the audit log

## 2. Request Details

### HTTP Method

`PATCH`

### URL Structure

```
/api/events/{event_id}/share-links/{id}
```

### Path Parameters

- **event_id** (UUID, required): The unique identifier of the event
- **id** (UUID, required): The unique identifier of the share link to update

### Headers

- **Authorization**: Bearer token (required) - Supabase JWT token
- **Content-Type**: `application/json`

### Request Body

Partial update structure using `UpdateShareLinkCommand`:

```typescript
{
  password?: string;       // Optional: new password (min 8 chars), or "" to remove
  expires_at?: string | null;  // Optional: ISO8601 timestamp or null to remove expiration
  include_pii?: boolean;   // Optional: toggle PII inclusion
}
```

**Validation Rules:**

- At least one field must be present
- `password`:
  - If provided and non-empty: minimum 8 characters
  - If empty string (`""`): removes password protection
  - If omitted: password remains unchanged
- `expires_at`:
  - If provided as string: must be valid ISO8601 timestamp in the future
  - If provided as `null`: removes expiration
  - If omitted: expiration remains unchanged
- `include_pii`:
  - If provided: must be boolean
  - If omitted: PII setting remains unchanged

### Example Requests

**Rotate Password:**

```json
{
  "password": "newSecurePass123"
}
```

**Remove Password Protection:**

```json
{
  "password": ""
}
```

**Update Expiration:**

```json
{
  "expires_at": "2025-12-31T23:59:59.999Z"
}
```

**Remove Expiration:**

```json
{
  "expires_at": null
}
```

**Toggle PII Inclusion:**

```json
{
  "include_pii": true
}
```

**Combined Update:**

```json
{
  "password": "newPassword456",
  "expires_at": "2025-12-31T23:59:59.999Z",
  "include_pii": false
}
```

## 3. Used Types

### Input Types

- **UpdateShareLinkCommand** (from `src/types.ts`):
  ```typescript
  interface UpdateShareLinkCommand {
    password?: string;
    expires_at?: ISO8601Timestamp | null;
    include_pii?: boolean;
  }
  ```

### Output Types

- **ShareLinkDTO** (from `src/types.ts`):
  ```typescript
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
    url: string; // Computed: e.g., https://domain.com/share/{token}
  }
  ```

### Error Types

- **ApiErrorDTO** (from `src/types.ts`):
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

- **DBShareLinkRow** (from `Tables<'share_links'>`):
  - All columns from `share_links` table
  - Includes `password_hash` (never exposed in API responses)

### Utility Types

- `UUID` (string)
- `ISO8601Timestamp` (string)
- `SupabaseClient` (from `src/db/supabase.client.ts`)

## 4. Response Details

### Success Response (200 OK)

Returns the updated share link as `ShareLinkDTO`.

**Example:**

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "event_id": "987fcdeb-51a2-43f7-9c8d-1234567890ab",
  "token": "abc123xyz789",
  "expires_at": "2025-12-31T23:59:59.999Z",
  "include_pii": false,
  "revoked_at": null,
  "created_at": "2025-10-01T10:00:00.000Z",
  "created_by": "456e7890-a12b-34c5-d678-901234567890",
  "last_accessed_at": "2025-10-15T14:30:00.000Z",
  "url": "https://yourdomain.com/share/abc123xyz789"
}
```

**Important:** The `password_hash` field is never included in the response.

### Error Responses

#### 400 Bad Request

Invalid input or business rule violation.

**Scenarios:**

- Empty request body (no fields to update)
- Password too short (< 8 characters when non-empty)
- `expires_at` is in the past
- Invalid UUID format for path parameters
- Invalid data types
- Attempting to update a revoked share link

**Example:**

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Password must be at least 8 characters long",
    "details": {
      "field": "password",
      "provided_length": 5
    }
  }
}
```

```json
{
  "error": {
    "code": "SHARE_LINK_REVOKED",
    "message": "Cannot update a revoked share link",
    "details": {
      "revoked_at": "2025-10-20T08:00:00.000Z"
    }
  }
}
```

#### 401 Unauthorized

Missing or invalid authentication token.

**Example:**

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required"
  }
}
```

#### 403 Forbidden

User is not the owner of the event.

**Example:**

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to update this share link"
  }
}
```

#### 404 Not Found

Event or share link does not exist.

**Example:**

```json
{
  "error": {
    "code": "SHARE_LINK_NOT_FOUND",
    "message": "Share link not found"
  }
}
```

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found"
  }
}
```

#### 500 Internal Server Error

Database errors, password hashing failures, or unexpected exceptions.

**Example:**

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred while updating the share link"
  }
}
```

## 5. Data Flow

### High-Level Flow

1. **Request Reception**: Astro API endpoint receives PATCH request
2. **Authentication**: Extract and verify Supabase JWT from Authorization header
3. **Input Validation**: Validate path parameters and request body using Zod schema
4. **Authorization**: Verify user owns the event
5. **Business Validation**: Check if share link is revoked, validate expiration date
6. **Password Processing**: Hash new password if provided (using bcrypt/argon2)
7. **Database Update**: Update `share_links` table with new values
8. **Audit Logging**: Create audit log entry documenting the changes
9. **Response Mapping**: Convert database row to ShareLinkDTO with computed URL
10. **Response**: Return 200 OK with updated share link

### Detailed Step-by-Step

```
┌─────────────────┐
│  Client Request │
│  PATCH /api/... │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Astro Middleware               │
│  - Extract Supabase client      │
│  - Attach to context.locals     │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  API Route Handler              │
│  /api/events/[event_id]/        │
│  share-links/[id].ts            │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  1. Authentication Check        │
│  - Get user from supabase.auth  │
│  - Return 401 if not authed     │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  2. Parse & Validate Input      │
│  - Validate path params (UUIDs) │
│  - Parse request body JSON      │
│  - Validate with Zod schema     │
│  - Return 400 if invalid        │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  3. Service Layer Call          │
│  ShareLinksService.update()     │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Service: Verify Ownership      │
│  - Query events table           │
│  - Check owner_id = user_id     │
│  - Return 404/403 if invalid    │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Service: Fetch Share Link      │
│  - Query share_links table      │
│  - Verify event_id matches      │
│  - Check if revoked             │
│  - Return 404/400 if invalid    │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Service: Prepare Update Data   │
│  - Hash password if provided    │
│  - Validate expires_at future   │
│  - Build update object          │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Service: Update Database       │
│  - UPDATE share_links SET ...   │
│  - WHERE id = ? AND event_id=?  │
│  - RETURNING *                  │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Service: Audit Logging         │
│  - INSERT INTO audit_log        │
│  - action_type: varies          │
│  - details: changed fields      │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Service: Map to DTO            │
│  - Convert DB row to DTO        │
│  - Compute URL field            │
│  - Exclude password_hash        │
└────────┬────────────────────────┘
         │
         ▼
┌─────────────────────────────────┐
│  Response: 200 OK               │
│  Body: ShareLinkDTO (JSON)      │
└─────────────────────────────────┘
```

### Database Interactions

1. **Read Events**:

   ```sql
   SELECT id, owner_id FROM events
   WHERE id = $1 AND deleted_at IS NULL;
   ```

2. **Read Share Link**:

   ```sql
   SELECT * FROM share_links
   WHERE id = $1 AND event_id = $2;
   ```

3. **Update Share Link**:

   ```sql
   UPDATE share_links
   SET
     password_hash = $1,  -- conditionally included
     expires_at = $2,     -- conditionally included
     include_pii = $3     -- conditionally included
   WHERE id = $4 AND event_id = $5
   RETURNING *;
   ```

4. **Create Audit Log**:
   ```sql
   INSERT INTO audit_log (event_id, user_id, action_type, details, share_link_id)
   VALUES ($1, $2, $3, $4, $5);
   ```

### Password Hashing

- Use **bcrypt** or **argon2** for password hashing
- Hash only if password is provided and non-empty
- If password is empty string, set `password_hash` to `null` in database
- Never expose `password_hash` in API responses

## 6. Security Considerations

### Authentication & Authorization

1. **Authentication**:
   - Require valid Supabase JWT token in Authorization header
   - Extract user from `supabase.auth.getUser()`
   - Return 401 if authentication fails

2. **Authorization**:
   - Verify the authenticated user is the owner of the event
   - Query `events` table to check `owner_id = user.id`
   - Return 403 if user is not the owner
   - Prevent users from updating share links for events they don't own

3. **Resource Validation**:
   - Verify share link belongs to the specified event
   - Check `share_link.event_id = event_id` from path
   - Prevent manipulation of unrelated share links

### Input Validation & Sanitization

1. **Path Parameters**:
   - Validate `event_id` and `id` are valid UUIDs
   - Use Zod's `z.string().uuid()` validator

2. **Request Body**:
   - Validate all fields with Zod schema
   - Enforce minimum password length (8 characters)
   - Validate `expires_at` is valid ISO8601 and in the future
   - Ensure at least one field is provided for update

3. **SQL Injection Prevention**:
   - Use Supabase parameterized queries (automatic protection)
   - Never concatenate user input into SQL strings

### Password Security

1. **Hashing**:
   - Use bcrypt (cost factor 10-12) or argon2
   - Never store plaintext passwords
   - Hash on server-side only

2. **Timing Attack Prevention**:
   - Use constant-time comparison when validating passwords
   - Avoid revealing whether password exists through response timing

3. **Password in Transit**:
   - Ensure HTTPS is enforced (handled at infrastructure level)
   - Never log password values

### Privacy & GDPR Compliance

1. **PII Handling**:
   - `include_pii` flag controls guest data exposure
   - Toggling this flag has privacy implications
   - Consider logging PII setting changes prominently in audit log

2. **Audit Trail**:
   - Log all share link modifications in `audit_log`
   - Store what changed but exclude sensitive values (password hash)
   - Include timestamp and user_id for accountability

### Data Integrity

1. **Revoked Links**:
   - Prevent updates to revoked links (`revoked_at IS NOT NULL`)
   - Return 400 Bad Request with clear error message

2. **Soft-Deleted Events**:
   - Ensure parent event is not soft-deleted (`deleted_at IS NULL`)
   - Return 404 if event is deleted

3. **Race Conditions**:
   - Use database transactions if updating multiple related records
   - Supabase's single UPDATE is atomic by default

### Rate Limiting

- Consider implementing rate limiting per user (future enhancement)
- Use `admin_flags.rate_limit_exports_daily` pattern if needed
- Not critical for MVP but document for future implementation

## 7. Error Handling

### Validation Errors (400 Bad Request)

| Scenario                  | Error Code            | Message                                          | Details                                                    |
| ------------------------- | --------------------- | ------------------------------------------------ | ---------------------------------------------------------- |
| No fields provided        | `EMPTY_UPDATE`        | "At least one field must be provided for update" | `{ "provided_fields": [] }`                                |
| Password too short        | `INVALID_PASSWORD`    | "Password must be at least 8 characters long"    | `{ "min_length": 8, "provided_length": X }`                |
| Invalid expires_at format | `INVALID_DATE_FORMAT` | "expires_at must be a valid ISO8601 timestamp"   | `{ "provided": "..." }`                                    |
| expires_at in the past    | `INVALID_EXPIRATION`  | "Expiration date must be in the future"          | `{ "provided": "...", "current_time": "..." }`             |
| Invalid UUID format       | `INVALID_UUID`        | "Invalid UUID format for {parameter}"            | `{ "parameter": "event_id", "value": "..." }`              |
| Share link revoked        | `SHARE_LINK_REVOKED`  | "Cannot update a revoked share link"             | `{ "revoked_at": "..." }`                                  |
| Invalid JSON              | `INVALID_JSON`        | "Request body must be valid JSON"                | -                                                          |
| Type mismatch             | `TYPE_ERROR`          | "Field {field} must be of type {expected_type}"  | `{ "field": "...", "expected": "...", "received": "..." }` |

### Authorization Errors

| Status Code | Error Code     | Message                                                | Scenario                |
| ----------- | -------------- | ------------------------------------------------------ | ----------------------- |
| 401         | `UNAUTHORIZED` | "Authentication required"                              | No or invalid JWT token |
| 403         | `FORBIDDEN`    | "You do not have permission to update this share link" | User is not event owner |

### Not Found Errors (404)

| Resource   | Error Code             | Message                |
| ---------- | ---------------------- | ---------------------- |
| Event      | `EVENT_NOT_FOUND`      | "Event not found"      |
| Share Link | `SHARE_LINK_NOT_FOUND` | "Share link not found" |

### Server Errors (500)

| Scenario                 | Error Code       | Message                                           | Logging                         |
| ------------------------ | ---------------- | ------------------------------------------------- | ------------------------------- |
| Database error           | `DATABASE_ERROR` | "An error occurred while updating the share link" | Log full error with stack trace |
| Password hashing failure | `HASHING_ERROR`  | "Failed to process password"                      | Log error details               |
| Unexpected exception     | `INTERNAL_ERROR` | "An unexpected error occurred"                    | Log full error with context     |

### Error Response Format

All errors follow `ApiErrorDTO` structure:

```typescript
{
  error: {
    code: string;        // Machine-readable code
    message: string;     // Human-readable message
    details?: Record<string, unknown>; // Optional structured data
  }
}
```

### Error Handling Strategy

1. **Input Validation**:
   - Use Zod's `.safeParse()` to catch validation errors early
   - Map Zod errors to user-friendly messages
   - Return 400 with specific error codes

2. **Database Errors**:
   - Wrap database calls in try-catch
   - Log full error server-side
   - Return sanitized error message to client
   - Return 500 for unexpected database errors
   - Return 404 for not found (check error code)

3. **Business Logic Errors**:
   - Check business rules explicitly (e.g., revoked status)
   - Return 400 with descriptive error codes
   - Provide actionable error messages

4. **Logging**:
   - Log all 500 errors with full stack traces
   - Log 400/403/404 errors with request context
   - Use structured logging (JSON format)
   - Include: timestamp, user_id, event_id, share_link_id, error details

## 8. Performance Considerations

### Database Query Optimization

1. **Index Usage**:
   - Ensure index on `share_links(id, event_id)` for fast lookup
   - Ensure index on `events(id, owner_id)` for ownership check
   - Existing indexes should cover these queries

2. **Query Efficiency**:
   - Use single SELECT for ownership verification
   - Use single UPDATE with RETURNING to get updated row
   - Minimize round-trips to database

3. **Transaction Management**:
   - Single UPDATE is atomic (no explicit transaction needed)
   - Consider transaction if audit log insert must be atomic with update

### Potential Bottlenecks

1. **Password Hashing**:
   - Bcrypt/argon2 hashing is CPU-intensive
   - Only hash when password is actually changed
   - Consider async hashing to avoid blocking
   - **Impact**: Minimal for single update, but consider for bulk operations

2. **Database Round-Trips**:
   - Current flow requires 3 queries:
     1. Verify ownership (events table)
     2. Update share link (share_links table)
     3. Insert audit log (audit_log table)
   - **Optimization**: Could combine ownership check with share link fetch using JOIN

3. **Audit Log Inserts**:
   - Audit log grows continuously
   - Consider partitioning by date (future enhancement)
   - Not a concern for MVP

### Optimization Strategies

1. **Reduce Database Queries**:

   ```sql
   -- Combined ownership + share link fetch
   SELECT sl.*, e.owner_id
   FROM share_links sl
   JOIN events e ON sl.event_id = e.id
   WHERE sl.id = $1 AND sl.event_id = $2 AND e.deleted_at IS NULL;
   ```

   Then check `owner_id = user.id` in application code.

2. **Conditional Updates**:
   - Only include changed fields in UPDATE statement
   - Build dynamic SQL based on provided fields
   - Reduces unnecessary column updates

3. **Async Audit Logging** (Future):
   - Consider queueing audit log writes
   - Decouple from critical path
   - Not recommended for MVP (adds complexity)

### Caching Considerations

- **Share links** are not frequently accessed by owners (mostly public access)
- No caching needed for this endpoint (updates are infrequent)
- Public access endpoint (`GET /share/{token}`) is more cache-friendly

### Scalability

- Endpoint is owner-only (authenticated users)
- Low traffic expected compared to public share access
- No specific scalability concerns for MVP
- Database connection pooling handled by Supabase

### Response Time Targets

- **Target**: < 200ms for typical update
- **Expected breakdown**:
  - Authentication: ~20ms
  - Validation: ~5ms
  - Database queries (3x): ~50ms
  - Password hashing: ~100ms (only when changing password)
  - Response serialization: ~5ms

## 9. Implementation Steps

### Step 1: Create Validation Schema

**File**: `src/lib/schemas/share-link.schema.ts`

- Create Zod schema for `UpdateShareLinkCommand`
- Validate password length (min 8 chars when non-empty)
- Validate `expires_at` is valid ISO8601 and future date
- Ensure at least one field is provided
- Export schema for use in API route and service

```typescript
import { z } from "zod";

export const updateShareLinkSchema = z
  .object({
    password: z.string().min(8).optional().or(z.literal("")),
    expires_at: z.string().datetime().nullable().optional(),
    include_pii: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" })
  .refine(
    (data) => {
      if (data.expires_at && data.expires_at !== null) {
        return new Date(data.expires_at) > new Date();
      }
      return true;
    },
    { message: "Expiration date must be in the future" }
  );

export const pathParamsSchema = z.object({
  event_id: z.string().uuid(),
  id: z.string().uuid(),
});
```

### Step 2: Create Share Links Service

**File**: `src/lib/services/share-links.service.ts`

Implement the following functions:

1. **`updateShareLink(supabase, eventId, linkId, userId, command)`**:
   - Verify event ownership
   - Fetch and validate share link
   - Hash password if provided
   - Update share_links table
   - Create audit log entry
   - Return updated ShareLinkDTO

2. **`verifyEventOwnership(supabase, eventId, userId)`**:
   - Query events table
   - Check owner_id matches userId
   - Return boolean or throw error

3. **`hashPassword(password)`**:
   - Use bcrypt or argon2
   - Return hashed password
   - Handle hashing errors

4. **`mapShareLinkToDTO(row, origin)`**:
   - Convert database row to ShareLinkDTO
   - Compute URL field
   - Exclude password_hash

5. **Error handling utilities**:
   - Custom error classes for business logic errors
   - Error mappers for consistent error responses

### Step 3: Create API Route Handler

**File**: `src/pages/api/events/[event_id]/share-links/[id].ts`

```typescript
export const prerender = false;

import type { APIRoute } from "astro";
import { updateShareLinkSchema, pathParamsSchema } from "@/lib/schemas/share-link.schema";
import { updateShareLink } from "@/lib/services/share-links.service";

export const PATCH: APIRoute = async (context) => {
  // 1. Get Supabase client from context.locals
  const supabase = context.locals.supabase;

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
          message: "Authentication required",
        },
      }),
      { status: 401 }
    );
  }

  // 3. Validate path parameters
  const pathParseResult = pathParamsSchema.safeParse(context.params);
  if (!pathParseResult.success) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_UUID",
          message: "Invalid UUID format",
          details: pathParseResult.error.flatten(),
        },
      }),
      { status: 400 }
    );
  }
  const { event_id, id } = pathParseResult.data;

  // 4. Parse and validate request body
  let body;
  try {
    body = await context.request.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_JSON",
          message: "Request body must be valid JSON",
        },
      }),
      { status: 400 }
    );
  }

  const parseResult = updateShareLinkSchema.safeParse(body);
  if (!parseResult.success) {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_INPUT",
          message: "Validation failed",
          details: parseResult.error.flatten(),
        },
      }),
      { status: 400 }
    );
  }

  // 5. Call service layer
  try {
    const updatedLink = await updateShareLink(supabase, event_id, id, user.id, parseResult.data, context.url.origin);

    return new Response(JSON.stringify(updatedLink), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    // Handle service-layer errors
    // Map to appropriate status codes and error responses
    // (See error handling section)
  }
};
```

### Step 4: Implement Service Functions

**File**: `src/lib/services/share-links.service.ts`

Detailed implementation:

```typescript
import type { SupabaseClient } from "@/db/supabase.client";
import type { UpdateShareLinkCommand, ShareLinkDTO } from "@/types";
import bcrypt from "bcryptjs";

export async function updateShareLink(
  supabase: SupabaseClient,
  eventId: string,
  linkId: string,
  userId: string,
  command: UpdateShareLinkCommand,
  origin: string
): Promise<ShareLinkDTO> {
  // 1. Verify event ownership
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, owner_id")
    .eq("id", eventId)
    .is("deleted_at", null)
    .single();

  if (eventError || !event) {
    throw new NotFoundError("EVENT_NOT_FOUND", "Event not found");
  }

  if (event.owner_id !== userId) {
    throw new ForbiddenError("FORBIDDEN", "You do not have permission to update this share link");
  }

  // 2. Fetch share link
  const { data: shareLink, error: linkError } = await supabase
    .from("share_links")
    .select("*")
    .eq("id", linkId)
    .eq("event_id", eventId)
    .single();

  if (linkError || !shareLink) {
    throw new NotFoundError("SHARE_LINK_NOT_FOUND", "Share link not found");
  }

  // 3. Check if revoked
  if (shareLink.revoked_at) {
    throw new BadRequestError("SHARE_LINK_REVOKED", "Cannot update a revoked share link", {
      revoked_at: shareLink.revoked_at,
    });
  }

  // 4. Prepare update data
  const updateData: any = {};
  const changedFields: string[] = [];

  if (command.password !== undefined) {
    if (command.password === "") {
      updateData.password_hash = null;
      changedFields.push("password_removed");
    } else {
      updateData.password_hash = await hashPassword(command.password);
      changedFields.push("password_updated");
    }
  }

  if (command.expires_at !== undefined) {
    updateData.expires_at = command.expires_at;
    changedFields.push("expires_at");
  }

  if (command.include_pii !== undefined) {
    updateData.include_pii = command.include_pii;
    changedFields.push("include_pii");
  }

  // 5. Update database
  const { data: updated, error: updateError } = await supabase
    .from("share_links")
    .update(updateData)
    .eq("id", linkId)
    .eq("event_id", eventId)
    .select("*")
    .single();

  if (updateError || !updated) {
    throw new DatabaseError("DATABASE_ERROR", "Failed to update share link");
  }

  // 6. Create audit log (determine action_type based on changes)
  let actionType = "share_link_updated"; // Note: verify this exists in enum

  await supabase.from("audit_log").insert({
    event_id: eventId,
    user_id: userId,
    action_type: actionType,
    share_link_id: linkId,
    details: { changed_fields: changedFields },
  });

  // 7. Map to DTO
  return mapShareLinkToDTO(updated, origin);
}

async function hashPassword(password: string): Promise<string> {
  try {
    return await bcrypt.hash(password, 12);
  } catch (error) {
    throw new InternalError("HASHING_ERROR", "Failed to process password");
  }
}

function mapShareLinkToDTO(row: any, origin: string): ShareLinkDTO {
  return {
    id: row.id,
    event_id: row.event_id,
    token: row.token,
    expires_at: row.expires_at,
    include_pii: row.include_pii,
    revoked_at: row.revoked_at,
    created_at: row.created_at,
    created_by: row.created_by,
    last_accessed_at: row.last_accessed_at,
    url: `${origin}/share/${row.token}`,
  };
}

// Custom error classes
export class NotFoundError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class BadRequestError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BadRequestError";
  }
}

export class DatabaseError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class InternalError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "InternalError";
  }
}
```

### Step 5: Add Error Handling to Route

**File**: `src/pages/api/events/[event_id]/share-links/[id].ts`

Enhance the catch block in PATCH handler:

```typescript
} catch (error) {
  if (error instanceof NotFoundError) {
    return new Response(JSON.stringify({
      error: {
        code: error.code,
        message: error.message
      }
    }), { status: 404 });
  }

  if (error instanceof ForbiddenError) {
    return new Response(JSON.stringify({
      error: {
        code: error.code,
        message: error.message
      }
    }), { status: 403 });
  }

  if (error instanceof BadRequestError) {
    return new Response(JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        details: error.details
      }
    }), { status: 400 });
  }

  // Log unexpected errors
  console.error('Unexpected error updating share link:', error);

  return new Response(JSON.stringify({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred while updating the share link'
    }
  }), { status: 500 });
}
```

### Step 6: Install Dependencies

Ensure required packages are installed:

```bash
npm install bcryptjs
npm install --save-dev @types/bcryptjs
```

Or use argon2:

```bash
npm install argon2
```

### Step 7: Update Database Enums (if needed)

**File**: `supabase/migrations/[timestamp]_add_share_link_updated_action.sql`

Check if `action_type_enum` includes a value for share link updates. If not, add migration:

```sql
-- Add 'share_link_updated' to action_type_enum if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'share_link_updated'
    AND enumtypid = 'action_type_enum'::regtype
  ) THEN
    ALTER TYPE action_type_enum ADD VALUE 'share_link_updated';
  END IF;
END $$;
```

Alternatively, use existing action types like 'share_link_created' for updates if appropriate.

### Step 8: Add Database Indexes (if missing)

**File**: `supabase/migrations/[timestamp]_add_share_links_indexes.sql`

Ensure indexes exist for performance:

```sql
-- Index for share_links lookup by id and event_id
CREATE INDEX IF NOT EXISTS idx_share_links_id_event_id
ON share_links(id, event_id);

-- Index for events ownership check
CREATE INDEX IF NOT EXISTS idx_events_id_owner_id
ON events(id, owner_id);
```

### Step 9: Write Unit Tests

**File**: `src/lib/services/share-links.service.test.ts`

Test cases:

- ✅ Successfully update password
- ✅ Successfully remove password protection
- ✅ Successfully update expiration
- ✅ Successfully remove expiration
- ✅ Successfully toggle include_pii
- ✅ Return 403 when user is not owner
- ✅ Return 404 when event not found
- ✅ Return 404 when share link not found
- ✅ Return 400 when share link is revoked
- ✅ Return 400 when expires_at is in the past
- ✅ Return 400 when password is too short
- ✅ Handle database errors gracefully

### Step 10: Write Integration Tests

**File**: `tests/integration/share-links.test.ts`

End-to-end tests:

- ✅ PATCH request with valid data returns 200
- ✅ PATCH request without auth returns 401
- ✅ PATCH request by non-owner returns 403
- ✅ PATCH request with invalid UUID returns 400
- ✅ PATCH request with empty body returns 400
- ✅ PATCH request for non-existent link returns 404
- ✅ PATCH request for revoked link returns 400
- ✅ Verify audit log is created after update

### Step 11: Manual Testing

Create test checklist:

1. **Happy Path**:
   - [ ] Update password successfully
   - [ ] Remove password protection
   - [ ] Update expiration date
   - [ ] Remove expiration
   - [ ] Toggle PII inclusion
   - [ ] Update multiple fields at once

2. **Error Cases**:
   - [ ] Update without authentication
   - [ ] Update by non-owner
   - [ ] Update non-existent share link
   - [ ] Update revoked share link
   - [ ] Provide password < 8 chars
   - [ ] Provide past expiration date
   - [ ] Empty request body

3. **Edge Cases**:
   - [ ] Update with exactly 8 char password
   - [ ] Update with very long password (>100 chars)
   - [ ] Update with special characters in password
   - [ ] Update expires_at to far future date
   - [ ] Concurrent updates (race conditions)

### Step 12: Documentation

**Files to update**:

- `README.md`: Add endpoint to API documentation
- `.ai/api-plan.md`: Mark endpoint as implemented
- OpenAPI/Swagger spec (if exists): Add endpoint definition

Include:

- Endpoint URL and method
- Request/response examples
- Error codes and scenarios
- Security considerations
- Rate limiting (if applicable)

### Step 13: Code Review Checklist

Before marking complete:

- [ ] Code follows project style guide
- [ ] All error scenarios are handled
- [ ] Input validation is comprehensive
- [ ] Database queries are optimized
- [ ] Sensitive data (password_hash) is never exposed
- [ ] Audit logging is implemented
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing completed
- [ ] Documentation updated
- [ ] ESLint/Prettier passes
- [ ] TypeScript compiles without errors
- [ ] No console.log() statements in production code
- [ ] Error messages are user-friendly
- [ ] Security review completed

### Step 14: Deployment Checklist

- [ ] Merge to main branch
- [ ] Run database migrations
- [ ] Verify environment variables (if any)
- [ ] Deploy to staging environment
- [ ] Run smoke tests in staging
- [ ] Monitor error logs
- [ ] Deploy to production
- [ ] Monitor production metrics

---

## Summary

This implementation plan provides a comprehensive guide for implementing the `PATCH /api/events/{event_id}/share-links/{id}` endpoint. The plan prioritizes:

1. **Security**: Authentication, authorization, input validation, password hashing
2. **Error Handling**: Comprehensive error scenarios with appropriate status codes
3. **Audit Trail**: All updates logged for accountability
4. **Privacy**: GDPR-compliant PII handling
5. **Performance**: Optimized database queries and minimal round-trips
6. **Maintainability**: Clean service layer separation, type safety, testability

The implementation follows the project's established patterns (Astro API routes, Supabase backend, Zod validation, TypeScript types) and adheres to the coding guidelines specified in the project documentation.
