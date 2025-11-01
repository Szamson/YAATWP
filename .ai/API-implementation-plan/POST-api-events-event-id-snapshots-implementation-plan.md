# API Endpoint Implementation Plan: POST /api/events/{event_id}/snapshots

## 1. Endpoint Overview

This endpoint allows authenticated users to create manual snapshots of their event's seating plan. A snapshot captures the complete `plan_data` state at a specific point in time, enabling users to preserve significant milestones (e.g., "Before guest import", "Final version approved") and restore them later if needed.

**Key Characteristics:**

- Creates manual snapshots (as opposed to automatic snapshots created by system operations)
- Links to previous snapshot to maintain version history chain
- Respects rate limiting (30 manual snapshots per hour per user)
- Supports idempotency to prevent duplicate snapshots on retry
- Records action in audit log for compliance

**Related Endpoints:**

- `GET /api/events/{event_id}/snapshots` - List snapshots
- `GET /api/events/{event_id}/snapshots/{snapshot_id}` - Get snapshot detail
- `POST /api/events/{event_id}/snapshots/{snapshot_id}/restore` - Restore snapshot

---

## 2. Request Details

### HTTP Method

`POST`

### URL Structure

```
POST /api/events/{event_id}/snapshots
```

### Path Parameters

| Parameter  | Type | Required | Validation           | Description           |
| ---------- | ---- | -------- | -------------------- | --------------------- |
| `event_id` | UUID | Yes      | Valid UUID v4 format | The event to snapshot |

### Headers

| Header            | Required | Description                                                       |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `Authorization`   | Yes      | `Bearer <Supabase JWT>` - Authenticated user token                |
| `Content-Type`    | Yes      | `application/json`                                                |
| `Idempotency-Key` | Optional | UUID v4 - Prevents duplicate snapshot creation on retry (24h TTL) |

### Request Body

**Type:** `CreateSnapshotCommand`

```typescript
interface CreateSnapshotCommand {
  label?: string; // Optional user-provided name (e.g., "Pre import", "Final version")
}
```

**Example Request:**

```json
{
  "label": "Before importing VIP guests"
}
```

**Example Request (Empty Label):**

```json
{
  "label": null
}
```

or

```json
{}
```

### Query Parameters

None.

---

## 3. Used Types

### Input Types

```typescript
import type { CreateSnapshotCommand, UUID } from "../../types";

// Zod validation schema
const createSnapshotSchema = z.object({
  label: z.string().max(150).optional().nullable(),
});
```

### Output Types

```typescript
import type { SnapshotDTO, ApiErrorDTO } from "../../types";

// Success Response (201)
type SnapshotDTO = Pick<
  DBSnapshotRow,
  "id" | "event_id" | "created_at" | "created_by" | "is_manual" | "label" | "previous_snapshot_id"
>;

// Error Response (4xx, 5xx)
interface ApiErrorDTO {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

### Internal Types

```typescript
interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
  reset_at: ISO8601Timestamp;
}

interface IdempotencyCheck {
  exists: boolean;
  snapshot_id?: UUID;
}
```

---

## 4. Response Details

### Success Response (201 Created)

**Headers:**

```
Content-Type: application/json
Location: /api/events/{event_id}/snapshots/{snapshot_id}
```

**Body:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "event_id": "123e4567-e89b-12d3-a456-426614174000",
  "created_at": "2025-11-01T14:32:10.123Z",
  "created_by": "789e0123-e45b-67c8-d901-234567890abc",
  "is_manual": true,
  "label": "Before importing VIP guests",
  "previous_snapshot_id": "660e9500-f30c-52e5-b827-557766551111"
}
```

### Success Response (200 OK - Idempotent)

When an idempotency key is provided and matches a recent snapshot (within 24h):

**Body:** Returns the existing `SnapshotDTO` created with that key

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "event_id": "123e4567-e89b-12d3-a456-426614174000",
  "created_at": "2025-11-01T14:30:00.000Z",
  "created_by": "789e0123-e45b-67c8-d901-234567890abc",
  "is_manual": true,
  "label": "Before importing VIP guests",
  "previous_snapshot_id": "660e9500-f30c-52e5-b827-557766551111"
}
```

### Error Responses

| Status | Error Code             | Scenario                            | Message Example                                                 |
| ------ | ---------------------- | ----------------------------------- | --------------------------------------------------------------- |
| 400    | `INVALID_EVENT_ID`     | Malformed event_id UUID             | "Invalid event ID format"                                       |
| 400    | `INVALID_LABEL`        | Label exceeds max length            | "Label must not exceed 150 characters"                          |
| 400    | `INVALID_REQUEST_BODY` | JSON parsing error                  | "Request body must be valid JSON"                               |
| 401    | `UNAUTHORIZED`         | Missing or invalid JWT              | "Authentication required"                                       |
| 403    | `FORBIDDEN`            | User doesn't own event              | "You do not have permission to create snapshots for this event" |
| 404    | `EVENT_NOT_FOUND`      | Event doesn't exist or soft-deleted | "Event not found"                                               |
| 429    | `RATE_LIMIT_EXCEEDED`  | Too many manual snapshots/hour      | "Manual snapshot rate limit exceeded. Try again in 15 minutes." |
| 500    | `INTERNAL_ERROR`       | Database or system error            | "An internal error occurred"                                    |

**Example Error Response:**

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Manual snapshot rate limit exceeded. Try again in 15 minutes.",
    "details": {
      "limit": 30,
      "window": "1 hour",
      "reset_at": "2025-11-01T15:00:00.000Z"
    }
  }
}
```

---

## 5. Data Flow

```
┌─────────────┐
│   Client    │
└──────┬──────┘
       │ POST /api/events/{event_id}/snapshots
       │ Headers: Authorization, Idempotency-Key (optional)
       │ Body: { label?: string }
       ▼
┌──────────────────────────────────────────────────────┐
│ Middleware (Astro)                                   │
│ - Authenticate JWT (extract user_id)                 │
│ - Attach Supabase client to context.locals           │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ API Route Handler                                    │
│ (src/pages/api/events/[event_id]/snapshots/index.ts) │
│                                                       │
│ 1. Validate path parameter (event_id format)         │
│ 2. Parse & validate request body (Zod)               │
│ 3. Sanitize label input                              │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ Idempotency Check                                    │
│ (src/lib/services/idempotency.service.ts)            │
│                                                       │
│ - If Idempotency-Key provided:                       │
│   - Hash key + user_id + "snapshot"                  │
│   - Check cache (Redis/in-memory, 24h TTL)           │
│   - If exists: return 200 + existing SnapshotDTO     │
│   - If not: continue to rate limit check             │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ Rate Limit Check                                     │
│ (src/lib/services/rate-limit.service.ts)             │
│                                                       │
│ - Check manual snapshots created in last hour        │
│ - Query: SELECT COUNT(*) FROM snapshots              │
│   WHERE created_by = user_id AND is_manual = true    │
│   AND created_at > NOW() - INTERVAL '1 hour'         │
│ - If count >= 30: return 429 error                   │
│ - Else: continue to service layer                    │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ Snapshot Service                                     │
│ (src/lib/services/snapshot.service.ts)               │
│                                                       │
│ - Call Supabase RPC: create_snapshot()               │
│   - Params: p_event_id, p_label, p_is_manual=true    │
│   - Function validates ownership (owner_id = uid)    │
│   - Fetches current plan_data from events table      │
│   - Finds previous snapshot (most recent)            │
│   - Inserts new snapshot row with chain link         │
│   - Returns snapshot_id                              │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ Post-Creation Tasks                                  │
│                                                       │
│ 1. Fetch created snapshot (by ID)                    │
│ 2. Store idempotency key mapping (if provided)       │
│ 3. Insert audit log entry:                           │
│    - action_type: 'snapshot_created'                 │
│    - details: { snapshot_id, label, is_manual }      │
│ 4. Optional: Emit analytics event                    │
└──────┬───────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────┐
│ Response                                             │
│ - Status: 201 Created                                │
│ - Header: Location: /api/events/.../snapshots/{id}   │
│ - Body: SnapshotDTO                                  │
└──────────────────────────────────────────────────────┘
```

### Database Function: `create_snapshot()`

The PostgreSQL function (already implemented in migration) handles:

```sql
CREATE FUNCTION create_snapshot(
  p_event_id uuid,
  p_label text DEFAULT NULL,
  p_is_manual boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_plan jsonb;
  v_id uuid := gen_random_uuid();
  v_prev uuid;
BEGIN
  -- Validate ownership
  SELECT plan_data INTO v_plan
  FROM events
  WHERE id = p_event_id AND owner_id = auth.uid();

  IF v_plan IS NULL THEN
    RAISE EXCEPTION 'event not found or not owned by user';
  END IF;

  -- Find previous snapshot
  SELECT id INTO v_prev
  FROM snapshots
  WHERE event_id = p_event_id
  ORDER BY created_at DESC
  LIMIT 1;

  -- Insert snapshot
  INSERT INTO snapshots(
    id, event_id, created_by, label, is_manual,
    plan_data, previous_snapshot_id
  )
  VALUES (
    v_id, p_event_id, auth.uid(), p_label,
    COALESCE(p_is_manual, false), v_plan, v_prev
  );

  RETURN v_id;
END;
$$;
```

---

## 6. Security Considerations

### Authentication & Authorization

| Check                   | Implementation                                         | Location       |
| ----------------------- | ------------------------------------------------------ | -------------- |
| **User Authentication** | Verify valid Supabase JWT in Authorization header      | Middleware     |
| **Event Ownership**     | DB function validates `owner_id = auth.uid()`          | PostgreSQL RPC |
| **RLS Policies**        | Snapshots table has RLS ensuring only owner can insert | Database       |

**Authorization Flow:**

1. Middleware extracts `user_id` from JWT
2. Supabase client configured with user context
3. Database function automatically validates ownership via `auth.uid()`
4. If not owner: function raises exception → 403 response

### Input Validation & Sanitization

```typescript
// Zod schema
const createSnapshotSchema = z.object({
  label: z
    .string()
    .max(150, "Label must not exceed 150 characters")
    .trim()
    .optional()
    .nullable()
    .transform((val) => (val === "" ? null : val)),
});

// Path validation
const eventIdSchema = z.string().uuid("Invalid event ID format");
```

**Sanitization Rules:**

- Trim whitespace from label
- Convert empty string to `null`
- Escape HTML entities to prevent XSS (if label rendered in UI)
- Reject label > 150 chars

### Rate Limiting

**Manual Snapshot Limit: 30 per hour per user**

**Implementation Strategy:**

```typescript
// Option 1: Database query (simpler, no external deps)
async function checkManualSnapshotRateLimit(supabase: SupabaseClient, userId: UUID): Promise<RateLimitCheck> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count, error } = await supabase
    .from("snapshots")
    .select("id", { count: "exact", head: true })
    .eq("created_by", userId)
    .eq("is_manual", true)
    .gte("created_at", oneHourAgo);

  if (error) throw error;

  const remaining = Math.max(0, 30 - (count ?? 0));
  const allowed = remaining > 0;

  return {
    allowed,
    remaining,
    reset_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

// Option 2: Redis sliding window (better performance at scale)
// Use Redis sorted sets with timestamps as scores
```

**Response Headers (Optional):**

```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 12
X-RateLimit-Reset: 1698854400
```

### Idempotency

**Goal:** Prevent duplicate snapshots if client retries request

**Implementation:**

```typescript
interface IdempotencyStore {
  key: string; // Hash of (user_id + idempotency_key + "snapshot")
  snapshot_id: UUID;
  created_at: ISO8601Timestamp;
  ttl: number; // 24 hours in seconds
}

async function checkIdempotency(userId: UUID, idempotencyKey: UUID | undefined): Promise<IdempotencyCheck> {
  if (!idempotencyKey) {
    return { exists: false };
  }

  // Hash to create storage key
  const key = `idempotency:snapshot:${userId}:${idempotencyKey}`;

  // Check Redis/in-memory cache
  const cached = await cache.get(key);

  if (cached) {
    return { exists: true, snapshot_id: cached.snapshot_id };
  }

  return { exists: false };
}

async function storeIdempotency(userId: UUID, idempotencyKey: UUID, snapshotId: UUID): Promise<void> {
  const key = `idempotency:snapshot:${userId}:${idempotencyKey}`;
  const ttl = 24 * 60 * 60; // 24 hours

  await cache.set(key, { snapshot_id: snapshotId }, ttl);
}
```

### Potential Security Threats

| Threat                                      | Impact                                                  | Mitigation                                              |
| ------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------- |
| **IDOR (Insecure Direct Object Reference)** | User creates snapshots for events they don't own        | DB function validates `owner_id = auth.uid()`           |
| **Rate Limit Bypass**                       | User spams snapshot creation to fill storage            | 30/hour limit enforced before DB call                   |
| **Storage Exhaustion**                      | Malicious user creates thousands of snapshots over time | Consider admin_flags.max_manual_snapshots cap (future)  |
| **XSS via Label**                           | Malicious script in label field rendered in UI          | Sanitize label, escape HTML when rendering              |
| **JWT Token Issues**                        | Expired/forged/stolen tokens                            | Supabase validates JWT signature & expiry               |
| **Idempotency Key Reuse**                   | Attacker reuses old keys to discover snapshot IDs       | 24h TTL limits exposure; keys are UUIDs (hard to guess) |
| **SQL Injection**                           | Malicious input in label                                | Supabase client uses parameterized queries              |
| **Plan Data Corruption**                    | Large/malformed plan_data                               | DB function fetches from trusted events table           |

### Additional Safeguards

1. **Snapshot Retention Policy (Future):**
   - Implement background job to clean up old manual snapshots (e.g., >1 year old)
   - Respect user preferences or admin flags

2. **Audit Logging:**
   - Log all snapshot creations to `audit_log` table
   - Include user_id, event_id, snapshot_id, label in details

3. **CORS:**
   - Lock down to app origin only
   - No public access to snapshot creation endpoint

---

## 7. Error Handling

### Error Categories

#### 1. Client Errors (4xx)

**400 Bad Request**

```typescript
// Invalid event_id format
{
  "error": {
    "code": "INVALID_EVENT_ID",
    "message": "Invalid event ID format",
    "details": { "event_id": "not-a-uuid" }
  }
}

// Invalid label
{
  "error": {
    "code": "INVALID_LABEL",
    "message": "Label must not exceed 150 characters",
    "details": { "max_length": 150, "provided_length": 200 }
  }
}

// Malformed JSON
{
  "error": {
    "code": "INVALID_REQUEST_BODY",
    "message": "Request body must be valid JSON",
    "details": { "parse_error": "Unexpected token..." }
  }
}
```

**401 Unauthorized**

```typescript
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required",
    "details": { "hint": "Provide a valid Bearer token in Authorization header" }
  }
}
```

**403 Forbidden**

```typescript
// Not event owner
{
  "error": {
    "code": "FORBIDDEN",
    "message": "You do not have permission to create snapshots for this event",
    "details": { "event_id": "123e4567-e89b-12d3-a456-426614174000" }
  }
}
```

**404 Not Found**

```typescript
{
  "error": {
    "code": "EVENT_NOT_FOUND",
    "message": "Event not found",
    "details": { "event_id": "123e4567-e89b-12d3-a456-426614174000" }
  }
}
```

**429 Too Many Requests**

```typescript
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Manual snapshot rate limit exceeded. Try again in 15 minutes.",
    "details": {
      "limit": 30,
      "window": "1 hour",
      "reset_at": "2025-11-01T15:00:00.000Z"
    }
  }
}
```

#### 2. Server Errors (5xx)

**500 Internal Server Error**

```typescript
// Database error
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An internal error occurred. Please try again later.",
    "details": {} // Omit sensitive error details in production
  }
}
```

### Error Handling Flow

```typescript
try {
  // 1. Validate input
  const { event_id } = eventIdSchema.parse(params);
  const body = await createSnapshotSchema.parseAsync(json);

  // 2. Check idempotency
  const idempotency = await checkIdempotency(userId, idempotencyKey);
  if (idempotency.exists) {
    const snapshot = await getSnapshot(idempotency.snapshot_id);
    return new Response(JSON.stringify(snapshot), { status: 200 });
  }

  // 3. Check rate limit
  const rateLimit = await checkManualSnapshotRateLimit(supabase, userId);
  if (!rateLimit.allowed) {
    return new Response(
      JSON.stringify({
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Manual snapshot rate limit exceeded. Try again later.",
          details: rateLimit,
        },
      }),
      { status: 429 }
    );
  }

  // 4. Create snapshot
  const snapshotId = await createSnapshot(supabase, event_id, body.label);

  // 5. Post-creation tasks
  await storeIdempotency(userId, idempotencyKey, snapshotId);
  await logAudit(supabase, event_id, userId, "snapshot_created", { snapshotId });

  // 6. Fetch & return snapshot
  const snapshot = await getSnapshot(snapshotId);
  return new Response(JSON.stringify(snapshot), {
    status: 201,
    headers: {
      Location: `/api/events/${event_id}/snapshots/${snapshotId}`,
    },
  });
} catch (error) {
  // Handle specific error types
  if (error instanceof z.ZodError) {
    return new Response(
      JSON.stringify({
        error: {
          code: "VALIDATION_ERROR",
          message: error.errors[0].message,
          details: error.errors,
        },
      }),
      { status: 400 }
    );
  }

  if (error.message.includes("event not found")) {
    return new Response(
      JSON.stringify({
        error: {
          code: "EVENT_NOT_FOUND",
          message: "Event not found",
        },
      }),
      { status: 404 }
    );
  }

  if (error.message.includes("not owned by user")) {
    return new Response(
      JSON.stringify({
        error: {
          code: "FORBIDDEN",
          message: "You do not have permission to create snapshots for this event",
        },
      }),
      { status: 403 }
    );
  }

  // Generic error
  console.error("Snapshot creation error:", error);
  return new Response(
    JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred",
      },
    }),
    { status: 500 }
  );
}
```

### Logging Strategy

**Application Logs:**

```typescript
// Success
logger.info("Manual snapshot created", {
  snapshot_id: snapshotId,
  event_id: eventId,
  user_id: userId,
  label: label,
  has_idempotency_key: !!idempotencyKey,
});

// Rate limit hit
logger.warn("Snapshot rate limit exceeded", {
  user_id: userId,
  count: rateLimit.count,
  reset_at: rateLimit.reset_at,
});

// Error
logger.error("Failed to create snapshot", {
  event_id: eventId,
  user_id: userId,
  error: error.message,
  stack: error.stack,
});
```

**Audit Log (Database):**

```typescript
await supabase.from("audit_log").insert({
  event_id: eventId,
  user_id: userId,
  action_type: "snapshot_created",
  details: {
    snapshot_id: snapshotId,
    label: label,
    is_manual: true,
    previous_snapshot_id: previousSnapshotId,
  },
});
```

---

## 8. Performance Considerations

### Potential Bottlenecks

1. **Rate Limit Query:**
   - Counting snapshots in last hour requires index scan
   - **Mitigation:** Index on `(created_by, is_manual, created_at)` exists or should be added

2. **Large plan_data:**
   - Copying entire plan_data JSONB could be expensive for events with 500+ tables/guests
   - **Mitigation:** PostgreSQL TOAST compression handles large JSONB efficiently; future: implement differential snapshots

3. **Idempotency Check Latency:**
   - Database query for idempotency check adds round-trip
   - **Mitigation:** Use Redis/in-memory cache for O(1) lookup

4. **Audit Log Insertion:**
   - Blocking on audit log insert could slow response
   - **Mitigation:** Make audit log insert asynchronous (background task)

### Optimization Strategies

#### 1. Database Indexes

**Existing (from migration):**

```sql
CREATE INDEX snapshots_event_id_idx ON snapshots(event_id);
CREATE INDEX snapshots_created_by_idx ON snapshots(created_by);
```

**Recommended Addition:**

```sql
-- Composite index for rate limit query
CREATE INDEX snapshots_created_by_manual_created_at_idx
ON snapshots(created_by, is_manual, created_at DESC)
WHERE is_manual = true;
```

#### 2. Caching Strategy

**Idempotency Cache (Redis/Upstash):**

```typescript
// Store in Redis with 24h TTL
const key = `idempotency:snapshot:${userId}:${idempotencyKey}`;
await redis.set(key, snapshotId, { ex: 86400 }); // 24 hours
```

**Rate Limit Cache (Optional):**

```typescript
// Cache rate limit count for 1 minute
const cacheKey = `rate:snapshot:${userId}`;
let count = await cache.get(cacheKey);

if (count === null) {
  const { count: dbCount } = await supabase
    .from("snapshots")
    .select("id", { count: "exact", head: true })
    .eq("created_by", userId)
    .eq("is_manual", true)
    .gte("created_at", oneHourAgo);

  count = dbCount ?? 0;
  await cache.set(cacheKey, count, { ex: 60 }); // 1 minute
}
```

#### 3. Asynchronous Tasks

**Non-blocking Audit Log:**

```typescript
// Fire and forget (or use message queue)
Promise.resolve()
  .then(() => logAudit(supabase, eventId, userId, "snapshot_created", { snapshotId }))
  .catch((error) => logger.error("Failed to log snapshot creation to audit", error));
```

#### 4. Response Optimization

**Selective Field Projection:**

```typescript
// Fetch only needed fields for SnapshotDTO (exclude plan_data)
const { data: snapshot } = await supabase
  .from("snapshots")
  .select("id, event_id, created_at, created_by, is_manual, label, previous_snapshot_id")
  .eq("id", snapshotId)
  .single();
```

### Performance Targets

| Metric                  | Target    | Notes                         |
| ----------------------- | --------- | ----------------------------- |
| **P50 Latency**         | < 200ms   | Typical case with cache hit   |
| **P95 Latency**         | < 500ms   | Includes DB round-trips       |
| **P99 Latency**         | < 1000ms  | Large plan_data or cold cache |
| **Throughput**          | 100 req/s | Per server instance           |
| **Rate Limit Overhead** | < 50ms    | With indexed query            |
| **Idempotency Check**   | < 10ms    | With Redis cache              |

### Monitoring & Alerts

**Key Metrics:**

```typescript
// Track in application metrics (e.g., Prometheus)
- snapshot_creation_duration_ms (histogram)
- snapshot_rate_limit_hits_total (counter)
- snapshot_creation_errors_total (counter by error_code)
- snapshot_idempotency_cache_hits_total (counter)
- snapshot_plan_data_size_bytes (histogram)
```

**Alert Conditions:**

- P95 latency > 1000ms for 5 minutes
- Error rate > 5% for 5 minutes
- Rate limit hit rate > 50% of users in 1 hour (indicates limit too low)

---

## 9. Implementation Steps

### Step 1: Create Service Directory Structure

**Task:** Set up service layer architecture

```bash
# Create services directory if it doesn't exist
mkdir -p src/lib/services

# Create service files
touch src/lib/services/snapshot.service.ts
touch src/lib/services/rate-limit.service.ts
touch src/lib/services/idempotency.service.ts
touch src/lib/services/audit.service.ts
```

### Step 2: Implement Rate Limit Service

**File:** `src/lib/services/rate-limit.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UUID, ISO8601Timestamp } from "../../types";

export interface RateLimitCheck {
  allowed: boolean;
  remaining: number;
  limit: number;
  reset_at: ISO8601Timestamp;
}

const MANUAL_SNAPSHOT_LIMIT = 30; // per hour
const WINDOW_SECONDS = 60 * 60; // 1 hour

/**
 * Check if user has exceeded manual snapshot rate limit
 */
export async function checkManualSnapshotRateLimit(supabase: SupabaseClient, userId: UUID): Promise<RateLimitCheck> {
  const oneHourAgo = new Date(Date.now() - WINDOW_SECONDS * 1000).toISOString();
  const resetAt = new Date(Date.now() + WINDOW_SECONDS * 1000).toISOString();

  const { count, error } = await supabase
    .from("snapshots")
    .select("id", { count: "exact", head: true })
    .eq("created_by", userId)
    .eq("is_manual", true)
    .gte("created_at", oneHourAgo);

  if (error) {
    console.error("Rate limit check error:", error);
    throw new Error("Failed to check rate limit");
  }

  const currentCount = count ?? 0;
  const remaining = Math.max(0, MANUAL_SNAPSHOT_LIMIT - currentCount);
  const allowed = remaining > 0;

  return {
    allowed,
    remaining,
    limit: MANUAL_SNAPSHOT_LIMIT,
    reset_at: resetAt,
  };
}
```

### Step 3: Implement Idempotency Service

**File:** `src/lib/services/idempotency.service.ts`

```typescript
import type { UUID } from "../../types";

export interface IdempotencyCheck {
  exists: boolean;
  snapshot_id?: UUID;
}

// In-memory cache for MVP (replace with Redis in production)
const idempotencyCache = new Map<string, { snapshot_id: UUID; expires_at: number }>();

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check if idempotency key has been used recently
 */
export async function checkIdempotency(userId: UUID, idempotencyKey: UUID | undefined): Promise<IdempotencyCheck> {
  if (!idempotencyKey) {
    return { exists: false };
  }

  const key = `snapshot:${userId}:${idempotencyKey}`;
  const cached = idempotencyCache.get(key);

  if (cached && cached.expires_at > Date.now()) {
    return { exists: true, snapshot_id: cached.snapshot_id };
  }

  // Clean up expired entry
  if (cached) {
    idempotencyCache.delete(key);
  }

  return { exists: false };
}

/**
 * Store idempotency key mapping
 */
export async function storeIdempotency(userId: UUID, idempotencyKey: UUID, snapshotId: UUID): Promise<void> {
  const key = `snapshot:${userId}:${idempotencyKey}`;
  const expiresAt = Date.now() + TTL_MS;

  idempotencyCache.set(key, { snapshot_id: snapshotId, expires_at: expiresAt });

  // Cleanup task: remove expired entries every hour
  // (In production, use Redis with automatic TTL)
}

/**
 * Clean up expired idempotency keys (background task)
 */
export function cleanupExpiredKeys(): void {
  const now = Date.now();
  for (const [key, value] of idempotencyCache.entries()) {
    if (value.expires_at <= now) {
      idempotencyCache.delete(key);
    }
  }
}

// Run cleanup every hour in background
if (typeof setInterval !== "undefined") {
  setInterval(cleanupExpiredKeys, 60 * 60 * 1000);
}
```

### Step 4: Implement Audit Service

**File:** `src/lib/services/audit.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UUID } from "../../types";
import type { Enums } from "../db/database.types";

/**
 * Log action to audit_log table
 */
export async function logAudit(
  supabase: SupabaseClient,
  eventId: UUID,
  userId: UUID,
  actionType: Enums<"action_type_enum">,
  details?: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.from("audit_log").insert({
    event_id: eventId,
    user_id: userId,
    action_type: actionType,
    details: details ?? null,
  });

  if (error) {
    console.error("Failed to log audit entry:", error);
    // Don't throw - audit logging shouldn't break main flow
  }
}
```

### Step 5: Implement Snapshot Service

**File:** `src/lib/services/snapshot.service.ts`

```typescript
import type { SupabaseClient } from "../db/supabase.client";
import type { UUID, SnapshotDTO } from "../../types";

/**
 * Create manual snapshot using database function
 */
export async function createManualSnapshot(
  supabase: SupabaseClient,
  eventId: UUID,
  label?: string | null
): Promise<UUID> {
  const { data, error } = await supabase.rpc("create_snapshot", {
    p_event_id: eventId,
    p_label: label ?? null,
    p_is_manual: true,
  });

  if (error) {
    // Parse database error messages
    if (error.message.includes("event not found")) {
      throw new SnapshotError("EVENT_NOT_FOUND", "Event not found", 404);
    }
    if (error.message.includes("not owned by user")) {
      throw new SnapshotError("FORBIDDEN", "You do not have permission to create snapshots for this event", 403);
    }
    throw new SnapshotError("INTERNAL_ERROR", "Failed to create snapshot", 500);
  }

  return data as UUID; // RPC returns snapshot ID
}

/**
 * Fetch snapshot by ID
 */
export async function getSnapshotById(supabase: SupabaseClient, snapshotId: UUID): Promise<SnapshotDTO> {
  const { data, error } = await supabase
    .from("snapshots")
    .select("id, event_id, created_at, created_by, is_manual, label, previous_snapshot_id")
    .eq("id", snapshotId)
    .single();

  if (error || !data) {
    throw new SnapshotError("SNAPSHOT_NOT_FOUND", "Snapshot not found", 404);
  }

  return data as SnapshotDTO;
}

/**
 * Custom error class for snapshot operations
 */
export class SnapshotError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "SnapshotError";
  }
}
```

### Step 6: Implement Input Validation Schemas

**File:** `src/lib/validation/snapshot.schemas.ts`

```typescript
import { z } from "zod";

export const createSnapshotSchema = z.object({
  label: z
    .string()
    .max(150, "Label must not exceed 150 characters")
    .trim()
    .optional()
    .nullable()
    .transform((val) => (val === "" ? null : val)),
});

export const eventIdSchema = z.string().uuid("Invalid event ID format");

export const idempotencyKeySchema = z.string().uuid("Invalid idempotency key format").optional();
```

### Step 7: Create API Route Handler

**File:** `src/pages/api/events/[event_id]/snapshots/index.ts`

```typescript
import type { APIRoute } from "astro";
import { z } from "zod";
import { createManualSnapshot, getSnapshotById, SnapshotError } from "../../../../../lib/services/snapshot.service";
import { checkManualSnapshotRateLimit } from "../../../../../lib/services/rate-limit.service";
import { checkIdempotency, storeIdempotency } from "../../../../../lib/services/idempotency.service";
import { logAudit } from "../../../../../lib/services/audit.service";
import {
  createSnapshotSchema,
  eventIdSchema,
  idempotencyKeySchema,
} from "../../../../../lib/validation/snapshot.schemas";
import type { ApiErrorDTO, SnapshotDTO } from "../../../../../types";

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
  const supabase = locals.supabase;
  const userId = locals.user?.id;

  // 1. Authentication check
  if (!userId) {
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

  try {
    // 2. Validate event_id
    const { event_id } = eventIdSchema.parse(params.event_id);

    // 3. Parse and validate request body
    const body = await request.json();
    const { label } = await createSnapshotSchema.parseAsync(body);

    // 4. Extract and validate idempotency key
    const idempotencyKey = request.headers.get("Idempotency-Key");
    const validatedKey = idempotencyKey ? idempotencyKeySchema.parse(idempotencyKey) : undefined;

    // 5. Check idempotency
    const idempotency = await checkIdempotency(userId, validatedKey);
    if (idempotency.exists && idempotency.snapshot_id) {
      const snapshot = await getSnapshotById(supabase, idempotency.snapshot_id);
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 6. Check rate limit
    const rateLimit = await checkManualSnapshotRateLimit(supabase, userId);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Manual snapshot rate limit exceeded. Try again later.",
            details: {
              limit: rateLimit.limit,
              window: "1 hour",
              reset_at: rateLimit.reset_at,
            },
          },
        } as ApiErrorDTO),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "X-RateLimit-Limit": rateLimit.limit.toString(),
            "X-RateLimit-Remaining": rateLimit.remaining.toString(),
            "X-RateLimit-Reset": new Date(rateLimit.reset_at).getTime().toString(),
          },
        }
      );
    }

    // 7. Create snapshot
    const snapshotId = await createManualSnapshot(supabase, event_id, label);

    // 8. Store idempotency mapping
    if (validatedKey) {
      await storeIdempotency(userId, validatedKey, snapshotId);
    }

    // 9. Log audit entry (non-blocking)
    logAudit(supabase, event_id, userId, "snapshot_created", {
      snapshot_id: snapshotId,
      label,
      is_manual: true,
    }).catch((error) => console.error("Audit log failed:", error));

    // 10. Fetch and return snapshot
    const snapshot = await getSnapshotById(supabase, snapshotId);

    return new Response(JSON.stringify(snapshot), {
      status: 201,
      headers: {
        "Content-Type": "application/json",
        Location: `/api/events/${event_id}/snapshots/${snapshotId}`,
        "X-RateLimit-Limit": rateLimit.limit.toString(),
        "X-RateLimit-Remaining": Math.max(0, rateLimit.remaining - 1).toString(),
      },
    });
  } catch (error) {
    // Error handling
    if (error instanceof z.ZodError) {
      return new Response(
        JSON.stringify({
          error: {
            code: "VALIDATION_ERROR",
            message: error.errors[0].message,
            details: error.errors,
          },
        } as ApiErrorDTO),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    if (error instanceof SnapshotError) {
      return new Response(
        JSON.stringify({
          error: {
            code: error.code,
            message: error.message,
          },
        } as ApiErrorDTO),
        { status: error.status, headers: { "Content-Type": "application/json" } }
      );
    }

    // Generic error
    console.error("Snapshot creation error:", error);
    return new Response(
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "An internal error occurred",
        },
      } as ApiErrorDTO),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
```

### Step 8: Update Database Migration (if needed)

**File:** `supabase/migrations/20251028230901_initial_schema.sql`

Verify that the composite index exists for efficient rate limit queries:

```sql
-- Add if not already present
CREATE INDEX IF NOT EXISTS snapshots_created_by_manual_created_at_idx
ON snapshots(created_by, is_manual, created_at DESC)
WHERE is_manual = true;
```

### Step 9: Implement Tests

**File:** `src/lib/services/snapshot.service.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createManualSnapshot, getSnapshotById, SnapshotError } from "./snapshot.service";

describe("Snapshot Service", () => {
  let mockSupabase: any;

  beforeEach(() => {
    mockSupabase = {
      rpc: vi.fn(),
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn(),
          })),
        })),
      })),
    };
  });

  describe("createManualSnapshot", () => {
    it("should create snapshot successfully", async () => {
      const snapshotId = "550e8400-e29b-41d4-a716-446655440000";
      mockSupabase.rpc.mockResolvedValue({ data: snapshotId, error: null });

      const result = await createManualSnapshot(mockSupabase, "event-123", "Test snapshot");

      expect(result).toBe(snapshotId);
      expect(mockSupabase.rpc).toHaveBeenCalledWith("create_snapshot", {
        p_event_id: "event-123",
        p_label: "Test snapshot",
        p_is_manual: true,
      });
    });

    it("should throw EVENT_NOT_FOUND for missing event", async () => {
      mockSupabase.rpc.mockResolvedValue({
        data: null,
        error: { message: "event not found or not owned by user" },
      });

      await expect(createManualSnapshot(mockSupabase, "event-999", null)).rejects.toThrow(SnapshotError);
    });

    it("should throw FORBIDDEN for unauthorized access", async () => {
      mockSupabase.rpc.mockResolvedValue({
        data: null,
        error: { message: "not owned by user" },
      });

      await expect(createManualSnapshot(mockSupabase, "event-123", null)).rejects.toThrow(SnapshotError);
    });
  });

  describe("getSnapshotById", () => {
    it("should fetch snapshot successfully", async () => {
      const snapshot = {
        id: "snap-123",
        event_id: "event-123",
        created_at: "2025-11-01T12:00:00Z",
        created_by: "user-123",
        is_manual: true,
        label: "Test",
        previous_snapshot_id: null,
      };

      mockSupabase.from().select().eq().single.mockResolvedValue({ data: snapshot, error: null });

      const result = await getSnapshotById(mockSupabase, "snap-123");

      expect(result).toEqual(snapshot);
    });

    it("should throw SNAPSHOT_NOT_FOUND for missing snapshot", async () => {
      mockSupabase
        .from()
        .select()
        .eq()
        .single.mockResolvedValue({
          data: null,
          error: { message: "not found" },
        });

      await expect(getSnapshotById(mockSupabase, "snap-999")).rejects.toThrow(SnapshotError);
    });
  });
});
```

**File:** `src/lib/services/rate-limit.service.test.ts`

```typescript
import { describe, it, expect, beforeEach, vi } from "vitest";
import { checkManualSnapshotRateLimit } from "./rate-limit.service";

describe("Rate Limit Service", () => {
  let mockSupabase: any;

  beforeEach(() => {
    mockSupabase = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            gte: vi.fn(() => ({
              count: 0,
              error: null,
            })),
          })),
        })),
      })),
    };
  });

  it("should allow request when under limit", async () => {
    mockSupabase.from().select().eq().gte.mockResolvedValue({ count: 10, error: null });

    const result = await checkManualSnapshotRateLimit(mockSupabase, "user-123");

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(20);
    expect(result.limit).toBe(30);
  });

  it("should deny request when at limit", async () => {
    mockSupabase.from().select().eq().gte.mockResolvedValue({ count: 30, error: null });

    const result = await checkManualSnapshotRateLimit(mockSupabase, "user-123");

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("should deny request when over limit", async () => {
    mockSupabase.from().select().eq().gte.mockResolvedValue({ count: 35, error: null });

    const result = await checkManualSnapshotRateLimit(mockSupabase, "user-123");

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});
```

### Step 10: Update Middleware (if needed)

**File:** `src/middleware/index.ts`

Ensure the middleware extracts user information and attaches Supabase client:

```typescript
import type { MiddlewareHandler } from "astro";
import { createSupabaseClient } from "../db/supabase.client";

export const onRequest: MiddlewareHandler = async ({ request, locals }, next) => {
  // Create Supabase client
  const supabase = createSupabaseClient(request.headers.get("Authorization"));
  locals.supabase = supabase;

  // Extract user from JWT
  const {
    data: { user },
  } = await supabase.auth.getUser();
  locals.user = user;

  return next();
};
```

### Step 11: Documentation

**File:** `.ai/api-docs/POST-events-event-id-snapshots.md`

Create API documentation for the endpoint (example structure):

```markdown
# POST /api/events/{event_id}/snapshots

Create a manual snapshot of the event's current seating plan state.

## Authentication

Required. Bearer token in `Authorization` header.

## Request

...
```

### Step 12: Integration Testing

**File:** `tests/integration/snapshots.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { createClient } from "@supabase/supabase-js";

describe("POST /api/events/:event_id/snapshots", () => {
  const baseUrl = "http://localhost:4321";
  const supabase = createClient(/* test credentials */);

  it("should create snapshot successfully", async () => {
    // 1. Create test event
    // 2. POST to snapshots endpoint
    // 3. Verify response status 201
    // 4. Verify snapshot exists in database
    // 5. Verify audit log entry created
  });

  it("should respect rate limits", async () => {
    // Create 30 snapshots in quick succession
    // Verify 31st request returns 429
  });

  it("should handle idempotency", async () => {
    // POST with Idempotency-Key
    // POST again with same key
    // Verify same snapshot returned
  });
});
```

---

## Summary Checklist

- [ ] Step 1: Create service directory structure
- [ ] Step 2: Implement rate limit service
- [ ] Step 3: Implement idempotency service
- [ ] Step 4: Implement audit service
- [ ] Step 5: Implement snapshot service
- [ ] Step 6: Implement validation schemas
- [ ] Step 7: Create API route handler
- [ ] Step 8: Verify database indexes
- [ ] Step 9: Write unit tests
- [ ] Step 10: Update middleware (if needed)
- [ ] Step 11: Create API documentation
- [ ] Step 12: Write integration tests
- [ ] Verify error handling for all scenarios
- [ ] Test rate limiting behavior
- [ ] Test idempotency key handling
- [ ] Verify audit log entries created
- [ ] Performance test with large plan_data
- [ ] Security review (IDOR, XSS, rate limits)

---

## Future Enhancements

1. **Redis Integration:**
   - Replace in-memory cache with Redis for distributed rate limiting
   - Use Redis sorted sets for sliding window rate limits

2. **Differential Snapshots:**
   - Store only changes (diffs) for large events to reduce storage
   - Compute full snapshot on demand by applying diffs

3. **Admin Flags Integration:**
   - Respect `admin_flags.max_manual_snapshots` per-user limit
   - Add UI to display remaining snapshot quota

4. **Snapshot Metadata:**
   - Add `diff_summary` computation between snapshots
   - Display change preview in version browser UI

5. **Background Cleanup:**
   - Implement retention policy for old snapshots
   - Auto-delete manual snapshots older than X months (user configurable)

6. **Advanced Rate Limiting:**
   - Implement tiered rate limits based on user plan
   - Add burst allowance (e.g., 5 snapshots immediate, then 30/hour)

7. **Webhook Notifications:**
   - Notify user when snapshot created (optional)
   - Send email for critical snapshots

---
