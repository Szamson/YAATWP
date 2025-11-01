# API Endpoint Implementation Plan: POST /api/events/{event_id}/share-links

## 1. Endpoint Overview

This endpoint creates a new share link for a specific event, allowing the event owner to generate view-only access URLs. Share links can optionally be password-protected, have expiration dates, and control whether personally identifiable information (PII) is exposed. The endpoint generates a cryptographically secure token, hashes any provided password, and returns a complete share URL ready for distribution.

**Key Responsibilities:**

- Generate unique, secure share tokens
- Hash passwords using bcrypt/argon2 (never store plaintext)
- Validate ownership and authorization
- Create audit trail for compliance
- Construct public-facing share URL

## 2. Request Details

### HTTP Method

`POST`

### URL Structure

```
/api/events/{event_id}/share-links
```

### Path Parameters

| Parameter  | Type | Required | Description                        |
| ---------- | ---- | -------- | ---------------------------------- |
| `event_id` | UUID | Yes      | The unique identifier of the event |

### Request Headers

| Header          | Required | Description                                    |
| --------------- | -------- | ---------------------------------------------- |
| `Authorization` | Yes      | Supabase session token (handled by middleware) |
| `Content-Type`  | Yes      | Must be `application/json`                     |

### Request Body

Type: `CreateShareLinkCommand`

```typescript
{
  password?: string;           // Optional; min 8 chars if provided
  expires_at?: string | null;  // Optional; ISO8601 timestamp or null
  include_pii?: boolean;        // Optional; default false
}
```

**Validation Rules:**

- `password`: If provided, must be at least 8 characters
- `expires_at`: If provided as string, must be valid ISO8601 format and future timestamp
- `include_pii`: Boolean flag controlling PII exposure; defaults to `false`

### Example Request

```json
POST /api/events/a1b2c3d4-e5f6-7890-abcd-ef1234567890/share-links
Content-Type: application/json
Authorization: Bearer <session_token>

{
  "password": "SecurePass123",
  "expires_at": "2025-12-31T23:59:59Z",
  "include_pii": false
}
```

## 3. Used Types

### Command Models

```typescript
import type { CreateShareLinkCommand } from "../types";
```

### DTOs

```typescript
import type { ShareLinkDTO, ApiErrorDTO } from "../types";
```

### Database Types

```typescript
import type { Tables, Enums } from "../db/database.types";
import type { SupabaseClient } from "../db/supabase.client";
```

### Zod Schema for Validation

```typescript
import { z } from "zod";

const createShareLinkSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  expires_at: z
    .string()
    .datetime()
    .refine((val) => new Date(val) > new Date(), { message: "Expiration date must be in the future" })
    .nullable()
    .optional(),
  include_pii: z.boolean().default(false).optional(),
});
```

## 4. Response Details

### Success Response (201 Created)

**Body:** `ShareLinkDTO`

```typescript
{
  id: string; // UUID of created share link
  event_id: string; // UUID of associated event
  token: string; // Secure random token (e.g., nanoid)
  url: string; // Computed full URL: {origin}/share/{token}
  expires_at: string | null; // ISO8601 timestamp or null
  include_pii: boolean; // PII exposure flag
  revoked_at: string | null; // Always null for new links
  created_at: string; // ISO8601 timestamp
  created_by: string; // User UUID who created the link
  last_accessed_at: string | null; // Always null for new links
}
```

**Note:** The `password_hash` field is never returned to the client.

### Example Success Response

```json
HTTP/1.1 201 Created
Content-Type: application/json

{
  "id": "f1e2d3c4-b5a6-7890-1234-567890abcdef",
  "event_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "token": "Xy7pQr2kMn4vBz",
  "url": "https://example.com/share/Xy7pQr2kMn4vBz",
  "expires_at": "2025-12-31T23:59:59Z",
  "include_pii": false,
  "revoked_at": null,
  "created_at": "2025-11-01T14:30:00Z",
  "created_by": "u1s2e3r4-i5d6-7890-abcd-1234567890ab",
  "last_accessed_at": null
}
```

### Error Responses

#### 400 Bad Request

Invalid input data.

```json
{
  "error": {
    "code": "INVALID_INPUT",
    "message": "Password must be at least 8 characters",
    "details": {
      "field": "password"
    }
  }
}
```

**Possible causes:**

- Invalid UUID format for `event_id`
- Password shorter than 8 characters
- `expires_at` in the past
- Malformed JSON body

#### 401 Unauthorized

No valid authentication session.

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

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to create share links for this event"
  }
}
```

#### 404 Not Found

Event does not exist or is soft-deleted.

```json
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found"
  }
}
```

#### 500 Internal Server Error

Server-side processing failure.

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Failed to create share link"
  }
}
```

## 5. Data Flow

### High-Level Flow

```
1. Client sends POST request with optional password, expires_at, include_pii
2. Astro middleware authenticates user via Supabase session
3. API endpoint handler validates path parameter and request body
4. Service layer checks event ownership
5. Service generates secure token and hashes password (if provided)
6. Database transaction: insert share_link + audit_log entry
7. Service constructs full share URL
8. Response mapper transforms DB row to ShareLinkDTO
9. Return 201 with ShareLinkDTO
```

### Detailed Step-by-Step

1. **Authentication (Middleware)**
   - Extract Supabase session from `context.locals.supabase`
   - If no session, middleware should return 401

2. **Parameter Validation**
   - Validate `event_id` is valid UUID format
   - Parse request body as JSON
   - Validate against Zod schema

3. **Authorization Check**
   - Query `events` table: `SELECT id, owner_id, deleted_at WHERE id = event_id`
   - If no result or `deleted_at IS NOT NULL`, return 404
   - If `owner_id != authenticated_user_id`, return 403

4. **Token Generation**
   - Generate cryptographically secure random token (16-20 chars, URL-safe)
   - Use `nanoid` or `crypto.randomBytes(16).toString('base64url')`
   - Check uniqueness against `share_links.token` (retry if collision)

5. **Password Hashing**
   - If `password` provided, hash using bcrypt with salt rounds 10-12
   - Store hash in `password_hash` column
   - If no password, set `password_hash` to `null`

6. **Database Transaction**

   ```typescript
   BEGIN TRANSACTION

   INSERT INTO share_links (
     event_id,
     created_by,
     token,
     password_hash,
     expires_at,
     include_pii
   ) VALUES (
     event_id,
     user_id,
     generated_token,
     hashed_password,
     expires_at,
     include_pii
   ) RETURNING *;

   INSERT INTO audit_log (
     event_id,
     user_id,
     action_type,
     share_link_id,
     details
   ) VALUES (
     event_id,
     user_id,
     'share_link_created',
     new_share_link.id,
     { "include_pii": include_pii, "has_password": !!password, "expires_at": expires_at }
   );

   COMMIT
   ```

7. **URL Construction**
   - Extract request origin from `context.request.url`
   - Construct URL: `${origin}/share/${token}`

8. **Response Mapping**
   - Transform DB row to `ShareLinkDTO`
   - Ensure `password_hash` is omitted
   - Add computed `url` field

## 6. Security Considerations

### Authentication & Authorization

- **Middleware Authentication**: Verify Supabase session exists before processing
- **Ownership Validation**: Enforce that only event owners can create share links
- **Soft-Delete Awareness**: Prevent share link creation for deleted events

### Password Security

- **Minimum Length**: Enforce 8-character minimum for passwords
- **Hashing Algorithm**: Use bcrypt with salt rounds 10-12 (or argon2id)
- **No Plaintext Storage**: Never store or log plaintext passwords
- **No Response Exposure**: Exclude `password_hash` from all API responses

### Token Security

- **Cryptographic Randomness**: Use `crypto.randomUUID()` or `nanoid` for unpredictable tokens
- **URL-Safe Characters**: Ensure tokens are URL-safe (no special encoding needed)
- **Uniqueness**: Enforce database unique constraint on `token` column
- **Length**: Minimum 16 characters for adequate entropy (128 bits recommended)

### Data Privacy (PII)

- **Explicit Consent**: `include_pii` defaults to `false`, requiring explicit opt-in
- **Audit Trail**: Log PII exposure decisions in `audit_log.details`
- **Future Enforcement**: The flag will be honored when share links are accessed

### Input Validation

- **UUID Format**: Validate `event_id` matches UUID v4 pattern
- **Timestamp Validation**: Ensure `expires_at` is valid ISO8601 and future date
- **SQL Injection**: Use parameterized queries (Supabase client handles this)
- **XSS Prevention**: Sanitize any user-provided input (though minimal in this endpoint)

### Rate Limiting (Future Enhancement)

- Consider implementing rate limits on share link creation per user
- Check `admin_flags.rate_limit_exports_daily` if applicable (or add dedicated limit)

## 7. Error Handling

### Validation Errors (400)

| Scenario                  | Code               | Message                                   |
| ------------------------- | ------------------ | ----------------------------------------- |
| Invalid UUID format       | `INVALID_EVENT_ID` | "Invalid event ID format"                 |
| Password too short        | `INVALID_INPUT`    | "Password must be at least 8 characters"  |
| Past expiration date      | `INVALID_INPUT`    | "Expiration date must be in the future"   |
| Malformed JSON            | `INVALID_INPUT`    | "Invalid request body"                    |
| Invalid expires_at format | `INVALID_INPUT`    | "Invalid timestamp format for expires_at" |

### Authorization Errors

| Status | Code           | Message                                                           | Scenario   |
| ------ | -------------- | ----------------------------------------------------------------- | ---------- |
| 401    | `UNAUTHORIZED` | "Authentication required"                                         | No session |
| 403    | `FORBIDDEN`    | "You do not have permission to create share links for this event" | Non-owner  |

### Resource Errors (404)

| Code              | Message           | Scenario                            |
| ----------------- | ----------------- | ----------------------------------- |
| `EVENT_NOT_FOUND` | "Event not found" | Event doesn't exist or soft-deleted |

### Server Errors (500)

| Code                      | Message                           | Scenario                      |
| ------------------------- | --------------------------------- | ----------------------------- |
| `TOKEN_GENERATION_FAILED` | "Failed to generate secure token" | Crypto failure                |
| `PASSWORD_HASH_FAILED`    | "Failed to hash password"         | Bcrypt failure                |
| `DATABASE_ERROR`          | "Failed to create share link"     | DB insert/transaction failure |

### Error Handling Best Practices

1. **Early Returns**: Validate and fail fast at the top of handler
2. **Detailed Logging**: Log full error stack traces server-side (not in response)
3. **Generic Messages**: Don't expose internal details to client
4. **Structured Errors**: Use consistent `ApiErrorDTO` format
5. **Transaction Rollback**: Ensure database transaction rollback on any failure
6. **Retry Logic**: Implement retry for token uniqueness collision (max 3 attempts)

### Example Error Handling Flow

```typescript
try {
  // Validation
  const body = await createShareLinkSchema.parseAsync(requestBody);

  // Authorization
  const event = await checkEventOwnership(supabase, event_id, user_id);
  if (!event) return error404("EVENT_NOT_FOUND");

  // Business logic
  const shareLink = await createShareLink(supabase, event_id, user_id, body);

  return success201(shareLink);
} catch (err) {
  if (err instanceof z.ZodError) {
    return error400("INVALID_INPUT", err.errors[0].message);
  }
  console.error("Failed to create share link:", err);
  return error500("DATABASE_ERROR", "Failed to create share link");
}
```

## 8. Performance Considerations

### Database Optimization

- **Indexes**: Ensure indexes exist on:
  - `events.id` (primary key, already indexed)
  - `events.owner_id` (should be indexed for ownership queries)
  - `share_links.token` (unique constraint, already indexed)
  - `share_links.event_id` (foreign key, already indexed)

- **Transaction Scope**: Keep transaction minimal (insert share_link + audit_log only)
- **Connection Pooling**: Rely on Supabase client connection pooling

### Computational Overhead

- **Password Hashing**: Bcrypt is CPU-intensive
  - Use async `bcrypt.hash()` to avoid blocking event loop
  - Salt rounds: 10-12 (balance security vs. performance)
  - Consider rate limiting to prevent abuse

- **Token Generation**: Minimal overhead with `crypto.randomBytes()` or `nanoid`

### Caching Considerations

- **Not Cacheable**: This is a POST endpoint creating unique resources
- **No CDN**: Share link creation is authenticated and non-idempotent

### Potential Bottlenecks

1. **Password Hashing**: Can take 50-200ms per hash
   - Mitigation: Accept as unavoidable cost; rate limit creation
2. **Database Write Latency**: Network round-trip to Supabase
   - Mitigation: Use nearest region; single transaction
3. **Token Collision Retry**: Unlikely but possible
   - Mitigation: Max 3 retry attempts before failing

## 9. Implementation Steps

### Step 1: Create Share Link Service

**File:** `src/lib/services/share-link.service.ts`

```typescript
import { nanoid } from "nanoid";
import bcrypt from "bcryptjs";
import type { SupabaseClient } from "../../db/supabase.client";
import type { CreateShareLinkCommand, ShareLinkDTO } from "../../types";

export class ShareLinkService {
  constructor(private supabase: SupabaseClient) {}

  async generateToken(): Promise<string> {
    // Generate 16-character URL-safe token
    return nanoid(16);
  }

  async hashPassword(password: string): Promise<string> {
    const saltRounds = 10;
    return bcrypt.hash(password, saltRounds);
  }

  async checkEventOwnership(eventId: string, userId: string): Promise<{ id: string; owner_id: string } | null> {
    const { data, error } = await this.supabase
      .from("events")
      .select("id, owner_id")
      .eq("id", eventId)
      .is("deleted_at", null)
      .single();

    if (error || !data) return null;
    if (data.owner_id !== userId) return null;

    return data;
  }

  async createShareLink(
    eventId: string,
    userId: string,
    command: CreateShareLinkCommand,
    origin: string
  ): Promise<ShareLinkDTO> {
    const token = await this.generateToken();
    const passwordHash = command.password ? await this.hashPassword(command.password) : null;

    // Insert share link
    const { data: shareLink, error: shareLinkError } = await this.supabase
      .from("share_links")
      .insert({
        event_id: eventId,
        created_by: userId,
        token,
        password_hash: passwordHash,
        expires_at: command.expires_at || null,
        include_pii: command.include_pii ?? false,
      })
      .select()
      .single();

    if (shareLinkError || !shareLink) {
      throw new Error("Failed to create share link");
    }

    // Create audit log entry
    const { error: auditError } = await this.supabase.from("audit_log").insert({
      event_id: eventId,
      user_id: userId,
      action_type: "share_link_created",
      share_link_id: shareLink.id,
      details: {
        include_pii: command.include_pii ?? false,
        has_password: !!command.password,
        expires_at: command.expires_at || null,
      },
    });

    if (auditError) {
      console.error("Failed to create audit log:", auditError);
      // Don't fail the request, but log the error
    }

    // Map to DTO
    return {
      id: shareLink.id,
      event_id: shareLink.event_id,
      token: shareLink.token,
      url: `${origin}/share/${shareLink.token}`,
      expires_at: shareLink.expires_at,
      include_pii: shareLink.include_pii,
      revoked_at: shareLink.revoked_at,
      created_at: shareLink.created_at,
      created_by: shareLink.created_by,
      last_accessed_at: shareLink.last_accessed_at,
    };
  }
}
```

### Step 2: Create Validation Schema

**File:** `src/lib/validation/share-link.schemas.ts`

```typescript
import { z } from "zod";

export const createShareLinkSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  expires_at: z
    .string()
    .datetime({ message: "Invalid timestamp format" })
    .refine((val) => new Date(val) > new Date(), { message: "Expiration date must be in the future" })
    .nullable()
    .optional(),
  include_pii: z.boolean().default(false).optional(),
});

export const eventIdParamSchema = z.string().uuid("Invalid event ID format");
```

### Step 3: Create API Endpoint Handler

**File:** `src/pages/api/events/[event_id]/share-links.ts`

```typescript
import type { APIRoute } from "astro";
import { ShareLinkService } from "../../../../lib/services/share-link.service";
import { createShareLinkSchema, eventIdParamSchema } from "../../../../lib/validation/share-link.schemas";
import type { CreateShareLinkCommand, ShareLinkDTO, ApiErrorDTO } from "../../../../types";

export const prerender = false;

export const POST: APIRoute = async (context) => {
  try {
    // 1. Get authenticated user
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
        } satisfies ApiErrorDTO),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Validate event_id parameter
    const eventIdResult = eventIdParamSchema.safeParse(context.params.event_id);
    if (!eventIdResult.success) {
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_EVENT_ID",
            message: "Invalid event ID format",
          },
        } satisfies ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    const eventId = eventIdResult.data;

    // 3. Parse and validate request body
    let body: CreateShareLinkCommand;
    try {
      const rawBody = await context.request.json();
      body = await createShareLinkSchema.parseAsync(rawBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid request body";
      return new Response(
        JSON.stringify({
          error: {
            code: "INVALID_INPUT",
            message,
          },
        } satisfies ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. Check event ownership
    const service = new ShareLinkService(supabase);
    const event = await service.checkEventOwnership(eventId, user.id);

    if (!event) {
      return new Response(
        JSON.stringify({
          error: {
            code: "EVENT_NOT_FOUND",
            message: "Event not found",
          },
        } satisfies ApiErrorDTO),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    // 5. Create share link
    const origin = new URL(context.request.url).origin;
    const shareLink: ShareLinkDTO = await service.createShareLink(eventId, user.id, body, origin);

    // 6. Return success response
    return new Response(JSON.stringify(shareLink), { status: 201, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("Error creating share link:", err);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to create share link",
        },
      } satisfies ApiErrorDTO),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
```

### Step 4: Install Required Dependencies

```bash
npm install nanoid bcryptjs
npm install -D @types/bcryptjs
```

### Step 5: Update Middleware (if needed)

Ensure `src/middleware/index.ts` properly initializes Supabase client in `context.locals.supabase`.

### Step 6: Add Integration Tests

**File:** `src/pages/api/events/[event_id]/share-links.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
// Test cases:
// - Successful share link creation
// - Invalid event ID format
// - Event not found
// - Unauthorized user (not owner)
// - Password too short
// - Expired timestamp in the past
// - Missing authentication
```

### Step 7: Database Verification

Verify the following database constraints are in place:

- Unique constraint on `share_links.token`
- Foreign key constraints on `share_links.event_id` and `share_links.created_by`
- Check constraint on events.deleted_at (implicit via query filter)

### Step 8: Manual Testing Checklist

- [ ] Create share link without password
- [ ] Create share link with password (8+ chars)
- [ ] Create share link with expiration date
- [ ] Create share link with include_pii = true
- [ ] Attempt to create for non-existent event (404)
- [ ] Attempt to create for someone else's event (403)
- [ ] Attempt with invalid event_id format (400)
- [ ] Attempt with password < 8 chars (400)
- [ ] Attempt with past expires_at (400)
- [ ] Verify password_hash is NOT in response
- [ ] Verify audit_log entry created
- [ ] Verify URL is correctly formatted

### Step 9: Documentation Updates

- Update API documentation with this endpoint
- Add example cURL requests
- Document error codes and responses

### Step 10: Deployment Checklist

- [ ] Environment variables configured (if any)
- [ ] Database migrations applied
- [ ] Indexes verified
- [ ] Rate limiting configured (optional)
- [ ] Monitoring/logging enabled
- [ ] CORS settings verified
