# API Endpoint Implementation Plan: PATCH /api/profiles/me

## 1. Endpoint Overview

This endpoint allows an authenticated user to update their profile information, specifically their display name and avatar URL. It supports partial updates, meaning clients can send only the fields they wish to modify. The endpoint enforces authentication (user must be logged in) and validates input according to database constraints and business rules.

**Purpose**: Update the current user's profile (display name and/or avatar URL)  
**Authentication**: Required (JWT/session via Supabase Auth)  
**Authorization**: User can only update their own profile (implicit via "me" pattern)

## 2. Request Details

- **HTTP Method**: PATCH
- **URL Structure**: `/api/profiles/me`
- **Content-Type**: `application/json`

### Parameters

#### Path Parameters

- None

#### Query Parameters

- None

#### Headers

- `Authorization`: Bearer token or session cookie (managed by Supabase Auth)
- `Content-Type`: `application/json`

#### Request Body

Structure defined by `UpdateProfileCommand`:

```typescript
{
  "display_name"?: string,  // Optional: 1-120 characters, non-empty if provided
  "avatar_url"?: string | null  // Optional: valid URL string or null to remove avatar
}
```

**Validation Rules**:

- Request body must be valid JSON
- If `display_name` is provided:
  - Must be a non-empty string (after trimming whitespace)
  - Length: 1-120 characters
- If `avatar_url` is provided:
  - Can be a valid URL string (http/https) or explicitly null
  - Recommended: validate URL format to prevent SSRF attacks
- At least one field should be provided (empty body is technically valid but results in no-op)

## 3. Used Types

### Command Models (Input)

```typescript
// From src/types.ts
interface UpdateProfileCommand {
  display_name?: string;
  avatar_url?: string | null;
}
```

### DTOs (Output)

```typescript
// From src/types.ts
type ProfileDTO = Pick<Tables<"profiles">, "user_id" | "display_name" | "avatar_url" | "created_at" | "updated_at">;
```

### Error Response

```typescript
// From src/types.ts
interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

## 4. Response Details

### Success Response (200 OK)

Returns the updated profile as `ProfileDTO`:

```json
{
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "display_name": "John Doe",
  "avatar_url": "https://example.com/avatar.jpg",
  "created_at": "2025-01-15T10:30:00.000Z",
  "updated_at": "2025-01-20T14:45:00.000Z"
}
```

**Status Code**: 200  
**Content-Type**: `application/json`

### Error Responses

#### 400 Bad Request - INVALID_PROFILE

```json
{
  "error": {
    "code": "INVALID_PROFILE",
    "message": "Invalid profile data provided",
    "details": {
      "display_name": "Display name must be between 1 and 120 characters"
    }
  }
}
```

**Scenarios**:

- `display_name` is empty string or only whitespace
- `display_name` exceeds 120 characters
- `avatar_url` has invalid URL format
- Request body has invalid JSON structure
- Invalid field types (e.g., display_name is number)

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

- No authentication token provided
- Invalid or expired token
- Session has been revoked

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
- Unexpected Supabase error
- Service layer exception

## 5. Data Flow

### Request Flow

1. **Request Reception**: Astro API route receives PATCH request at `/api/profiles/me`
2. **Authentication Check**: Extract Supabase client from `context.locals.supabase` and verify user session
3. **Input Validation**: Validate request body against Zod schema derived from `UpdateProfileCommand`
4. **Service Invocation**: Call `ProfileService.updateProfile(supabase, userId, updateData)`
5. **Database Update**: Service updates `profiles` table via Supabase client
6. **Response Assembly**: Format updated profile as `ProfileDTO`
7. **Response Return**: Send 200 OK with profile data

### Database Interaction

**Table**: `profiles`  
**Operation**: UPDATE

```sql
UPDATE profiles
SET
  display_name = COALESCE($1, display_name),
  avatar_url = COALESCE($2, avatar_url),
  updated_at = NOW()
WHERE user_id = $3
RETURNING *;
```

**Notes**:

- Use Supabase `.update()` method with selective field updates
- `updated_at` should be automatically updated (trigger or explicit set)
- Return updated row to construct response DTO

### Service Layer Responsibilities

**File**: `src/lib/services/profile.service.ts`

Functions:

- `updateProfile(supabase: SupabaseClient, userId: UUID, data: UpdateProfileCommand): Promise<ProfileDTO>`
  - Validate that user exists (optional, can rely on FK constraint)
  - Build update payload with only provided fields
  - Execute database update
  - Transform database row to `ProfileDTO`
  - Handle database errors gracefully

## 6. Security Considerations

### Authentication

- **Mechanism**: Supabase Auth session via `context.locals.supabase.auth.getUser()`
- **Enforcement**: Return 401 if no valid session
- **Token Validation**: Handled automatically by Supabase client

### Authorization

- **Implicit Authorization**: The "me" endpoint pattern ensures users can only update their own profile
- **User ID Source**: Extract from authenticated session (`user.id`), never from request body
- **RLS (Row Level Security)**: If enabled on `profiles` table, provides additional layer
  - Recommended RLS policy: `user_id = auth.uid()` for UPDATE operations

### Input Sanitization

- **XSS Prevention**: Sanitize `display_name` before storage
  - Consider using a library like DOMPurify or built-in escaping
  - Store sanitized version, escape again on output if needed
- **URL Validation**: Validate `avatar_url` format
  - Use Zod's `.url()` validator
  - Consider allowlist for trusted domains (optional for MVP)
  - Prevent SSRF by restricting to https:// URLs only

### Data Validation

- **Type Safety**: Use Zod schema for runtime type checking
- **Length Limits**: Enforce max 120 chars for display_name
- **Null Handling**: Distinguish between `undefined` (field not updated) and `null` (field cleared)

### Rate Limiting (Future Enhancement)

- Consider implementing rate limiting for profile updates (e.g., max 10 updates/hour)
- Use `admin_flags` table or middleware-based rate limiter

## 7. Error Handling

### Error Scenarios and Responses

| Scenario                  | Status Code | Error Code      | Message                                     |
| ------------------------- | ----------- | --------------- | ------------------------------------------- |
| No authentication token   | 401         | UNAUTHORIZED    | Authentication required                     |
| Invalid/expired token     | 401         | UNAUTHORIZED    | Authentication required                     |
| display_name empty string | 400         | INVALID_PROFILE | Display name cannot be empty                |
| display_name > 120 chars  | 400         | INVALID_PROFILE | Display name must be 120 characters or less |
| avatar_url invalid format | 400         | INVALID_PROFILE | Avatar URL must be a valid URL              |
| Invalid JSON body         | 400         | INVALID_PROFILE | Invalid request body format                 |
| Database connection error | 500         | INTERNAL_ERROR  | An unexpected error occurred                |
| Unexpected service error  | 500         | INTERNAL_ERROR  | An unexpected error occurred                |

### Error Handling Strategy

1. **Validation Errors (400)**:
   - Catch Zod validation errors
   - Map to `INVALID_PROFILE` error code
   - Include field-specific details in `details` object
   - Return immediately without database call

2. **Authentication Errors (401)**:
   - Check session before processing request
   - Return early if no valid user
   - Use consistent error response format

3. **Database Errors (500)**:
   - Catch Supabase client errors
   - Log full error details server-side
   - Return sanitized error message to client
   - Avoid exposing database internals

4. **Logging**:
   - Log all errors to console with context (user_id, timestamp, error details)
   - For 500 errors, include stack trace in server logs
   - Consider structured logging (e.g., Pino, Winston)

### Error Response Format

All errors follow `ApiErrorDTO` structure:

```typescript
return new Response(
  JSON.stringify({
    error: {
      code: "ERROR_CODE",
      message: "Human-readable message",
      details: { field: "specific error" }, // Optional
    },
  }),
  {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  }
);
```

## 8. Performance Considerations

### Bottlenecks

- **Database Round-Trip**: Single UPDATE query with RETURNING clause
- **Validation Overhead**: Minimal (Zod schema validation is fast)
- **Sanitization**: DOMPurify or similar may add slight overhead for display_name

### Optimization Strategies

1. **Single Query**: Use UPDATE with RETURNING to avoid second SELECT
2. **Connection Pooling**: Supabase client handles connection pooling
3. **Indexing**: Ensure `profiles.user_id` is indexed (primary key, already indexed)
4. **Caching**: Profile data could be cached (future enhancement)
   - Cache key: `profile:${userId}`
   - Invalidate on update
   - TTL: 5-15 minutes

### Expected Performance

- **Latency**: < 100ms for typical update (network + database)
- **Throughput**: Limited by database write capacity and rate limiting
- **Concurrency**: Handle concurrent updates gracefully (last-write-wins model)

## 9. Implementation Steps

### Step 1: Create Profile Service

**File**: `src/lib/services/profile.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UUID, ProfileDTO, UpdateProfileCommand } from "../types";

export async function updateProfile(
  supabase: SupabaseClient,
  userId: UUID,
  data: UpdateProfileCommand
): Promise<ProfileDTO> {
  // Build update payload with only provided fields
  const updatePayload: Record<string, any> = {
    updated_at: new Date().toISOString(),
  };

  if (data.display_name !== undefined) {
    updatePayload.display_name = data.display_name;
  }

  if (data.avatar_url !== undefined) {
    updatePayload.avatar_url = data.avatar_url;
  }

  // Execute update
  const { data: profile, error } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to update profile: ${error.message}`);
  }

  if (!profile) {
    throw new Error("Profile not found after update");
  }

  return profile as ProfileDTO;
}
```

### Step 2: Create Zod Validation Schema

**File**: `src/lib/schemas/profile.schema.ts`

```typescript
import { z } from "zod";

export const updateProfileSchema = z
  .object({
    display_name: z
      .string()
      .trim()
      .min(1, "Display name cannot be empty")
      .max(120, "Display name must be 120 characters or less")
      .optional(),
    avatar_url: z.union([z.string().url("Avatar URL must be a valid URL"), z.null()]).optional(),
  })
  .strict(); // Reject unknown fields
```

### Step 3: Create API Route

**File**: `src/pages/api/profiles/me.ts`

```typescript
import type { APIRoute } from "astro";
import { updateProfileSchema } from "../../../lib/schemas/profile.schema";
import { updateProfile } from "../../../lib/services/profile.service";
import type { ApiErrorDTO, ProfileDTO } from "../../../types";

export const prerender = false;

export const PATCH: APIRoute = async (context) => {
  // Step 1: Authenticate user
  const {
    data: { user },
    error: authError,
  } = await context.locals.supabase.auth.getUser();

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

  // Step 2: Parse and validate request body
  let requestBody;
  try {
    requestBody = await context.request.json();
  } catch {
    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_PROFILE",
          message: "Invalid JSON in request body",
        },
      } as ApiErrorDTO),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const validation = updateProfileSchema.safeParse(requestBody);

  if (!validation.success) {
    const details: Record<string, string> = {};
    validation.error.errors.forEach((err) => {
      details[err.path.join(".")] = err.message;
    });

    return new Response(
      JSON.stringify({
        error: {
          code: "INVALID_PROFILE",
          message: "Invalid profile data provided",
          details,
        },
      } as ApiErrorDTO),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Step 3: Update profile via service
  try {
    const updatedProfile = await updateProfile(context.locals.supabase, user.id, validation.data);

    return new Response(JSON.stringify(updatedProfile as ProfileDTO), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Profile update error:", error);

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

### Step 4: Add Display Name Sanitization (Optional but Recommended)

**File**: `src/lib/utils/sanitize.ts`

```typescript
/**
 * Sanitize display name to prevent XSS attacks
 * Removes HTML tags and potentially dangerous characters
 */
export function sanitizeDisplayName(input: string): string {
  return input
    .replace(/[<>]/g, "") // Remove < and >
    .trim();
}
```

Update service to use sanitization:

```typescript
if (data.display_name !== undefined) {
  updatePayload.display_name = sanitizeDisplayName(data.display_name);
}
```

### Step 5: Test the Endpoint

#### Unit Tests

**File**: `src/lib/services/profile.service.test.ts`

Test scenarios:

- Update display name only
- Update avatar URL only
- Update both fields
- Update with null avatar_url
- Handle database errors

#### Integration Tests

**File**: `tests/api/profiles/me.test.ts`

Test scenarios:

- Successful update (200)
- Unauthenticated request (401)
- Invalid display name - empty (400)
- Invalid display name - too long (400)
- Invalid avatar URL format (400)
- Invalid JSON body (400)

### Step 6: Update Middleware (if needed)

**File**: `src/middleware/index.ts`

Ensure Supabase client is properly initialized and attached to `context.locals.supabase`.

### Step 7: Documentation

- Update API documentation with endpoint details
- Add example request/response to developer docs
- Document error codes and their meanings

### Step 8: Deployment Checklist

- [ ] Verify RLS policies on `profiles` table
- [ ] Ensure `updated_at` trigger exists on `profiles` table (or handle in application)
- [ ] Test with production-like Supabase instance
- [ ] Verify CORS settings if API called from different origin
- [ ] Set up monitoring/alerting for 500 errors
- [ ] Load test with expected concurrent users

## 10. Additional Considerations

### Future Enhancements

1. **Avatar Upload**: Add separate endpoint for uploading avatar images to Supabase Storage
2. **Profile Completeness**: Add field to track profile completion percentage
3. **Avatar Validation**: Validate image dimensions/file size if uploaded directly
4. **Rate Limiting**: Implement rate limiting to prevent abuse
5. **Audit Trail**: Consider logging profile updates to analytics_events table
6. **Optimistic Locking**: Add version field to prevent lost updates in race conditions

### Database Triggers (Recommended)

Create a trigger to automatically update `updated_at`:

```sql
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_profiles_updated_at
BEFORE UPDATE ON profiles
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
```

This ensures `updated_at` is always current, even if forgotten in application code.
