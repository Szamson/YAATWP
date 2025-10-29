# REST API Plan

This plan defines REST endpoints for the Wedding Seating App backend (Astro server routes + Supabase). It maps PRD requirements and database schema to concrete resources, endpoints, payloads, validation, security, performance, and compliance considerations. JSON examples show canonical shapes; optional fields are marked as optional. All timestamps are ISO 8601 UTC.

## 1. Resources

| Resource                        | DB Table / Source                | Description                                                  |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| Profile                         | `profiles` (+ `auth.users`)      | Public user profile of an authenticated user.                |
| Event                           | `events`                         | Seating event metadata + embedded `plan_data`.               |
| Snapshot                        | `snapshots`                      | Versioned frozen copies of event `plan_data`.                |
| ShareLink                       | `share_links`                    | Tokenized view-only access record for an event.              |
| ShareLinkAccessLog              | `access_logs`                    | Access audit rows per share link.                            |
| AuditLog                        | `audit_log`                      | High-level actions (guests edited, tables created, etc.).    |
| ImportConsent                   | `import_consent`                 | GDPR/CCPA consent per import.                                |
| GuestImport                     | `guest_imports`                  | XLSX import audit + duplicate/validation trail.              |
| DataRequest                     | `data_requests`                  | DSAR export or deletion requests.                            |
| AnalyticsEvent                  | `analytics_events`               | Minimal, privacy-conscious tracking events.                  |
| AdminFlags                      | `admin_flags`                    | Per-user feature/rate limit flags.                           |
| Lock                            | virtual (functions on `events`)  | Soft single-editor lock (acquire/release).                   |
| Export                          | virtual (functions / processing) | PDF/PNG/XLSX/CSV export tasks.                               |
| Seat / Table / Guest (embedded) | `events.plan_data` JSONB         | In-MVP embedded model representing tables, seats and guests. |
| PublicEventView                 | RPC/view                         | Sanitized event projection for share link viewers.           |

Auxiliary enums map to validation: `action_type_enum`, `import_status_enum`, `data_request_type_enum`, `data_request_status_enum`, `analytics_event_type_enum`, `table_shape_enum`.

## 2. Endpoints

Conventions:

- Base path: `/api` (Astro server routes under `src/pages/api`).
- Versioning: Implicit v1; breaking changes require `/api/v2/...` later.
- Authentication: Supabase JWT (Bearer) except anonymous share link endpoints using token/password.
- Idempotency: Provide `Idempotency-Key` header for POST actions that create exports, imports, data requests, or snapshots to prevent duplicates on retry.
- Pagination: Cursor-based (`?limit=50&cursor=<opaque>`) for potentially large sets (snapshots, logs) else simple `?limit` + `?offset`. Default limit 20, max 100 (unless noted). Responses include `next_cursor` when more results exist.
- Filtering: Query parameters documented per endpoint. Multiple filters combine with logical AND.
- Sorting: `?sort=created_at&order=desc` default unless specified.
- Errors: JSON `{ "error": { "code": "<CODE>", "message": "human readable", "details": { ... } } }`.

### 2.1 Profiles

#### GET /api/profiles/me

Return current user profile.
Response 200:

```json
{ "user_id": "uuid", "display_name": "string", "avatar_url": "string|null", "created_at": "ts", "updated_at": "ts" }
```

Errors: 401 Unauthorized.

#### PATCH /api/profiles/me

Update display name / avatar.
Request:

```json
{ "display_name": "string", "avatar_url": "string|null" }
```

Validation: `display_name` non-empty <= 120 chars.
Response 200: updated profile.
Errors: 400 INVALID_PROFILE, 401.

### 2.2 Events

Event object (condensed):

```json
{
  "id": "uuid",
  "owner_id": "uuid",
  "name": "string",
  "event_date": "YYYY-MM-DD|null",
  "grid": { "rows": 20, "cols": 30 },
  "plan_data": {
    "tables": [
      {
        "id": "t1",
        "shape": "round",
        "capacity": 10,
        "label": "Table 1",
        "start_index": 1,
        "head_seat": 1,
        "seats": [{ "seat_no": 1, "guest_id": "g1" }]
      }
    ],
    "guests": [{ "id": "g1", "name": "Alice", "note": "Vegan", "tag": "Family", "rsvp": "Yes" }],
    "settings": { "color_palette": "default" }
  },
  "autosave_version": 3,
  "lock": { "held_by": "uuid|null", "expires_at": "ts|null" },
  "created_at": "ts",
  "updated_at": "ts"
}
```

#### POST /api/events

Create new event.
Request:

```json
{ "name": "My Wedding", "event_date": "2026-06-15", "grid_rows": 20, "grid_cols": 30 }
```

Rules: `grid_rows, grid_cols > 0`, name 1..150 chars.
Response 201: Event.
Errors: 400 INVALID_EVENT_INPUT.

#### GET /api/events

List owned events.
Query: `limit, cursor, search (name ILIKE), date_from, date_to, include_deleted=false`.
Response 200:

```json
{ "items": [EventSummary...], "next_cursor": "opaque|null" }
```

`EventSummary` excludes `plan_data` heavy fields unless `include_plan=false` (default false). Use separate fetch.

#### GET /api/events/{event_id}

Fetch single event (full plan_data). Query: `plan=false` to omit plan data for metadata-only view.
Errors: 404 EVENT_NOT_FOUND.

#### PATCH /api/events/{event_id}

Update metadata + grid size (not plan_data). Request any subset: `{ "name":..., "event_date":..., "grid_rows":..., "grid_cols":... }`.
Side effects: creates snapshot if structural change to grid.

#### DELETE /api/events/{event_id}

Soft delete (set `deleted_at`). Response 204.

#### POST /api/events/{event_id}/restore

Restore soft-deleted event. 409 if not deleted.

### 2.3 Event Plan Operations (Embedded Guests/Tables)

Given MVP uses embedded JSON, plan modifications occur via targeted patch endpoints to minimize race conditions and allow audit logging.

Common response: updated `plan_data` fragment plus new `autosave_version`.
Concurrency: Client sends `If-Match: <autosave_version>`; server rejects with 409 VERSION_CONFLICT if mismatch (client refresh required). Server increments on success.

#### PATCH /api/events/{event_id}/plan/bulk

Apply a batch of operations (for undo/redo). Request:

```json
{ "version": 3, "ops": [ { "op":"add_table", "table": { ... } }, { "op":"update_table", "id":"t1", "patch": {"capacity":12} }, { "op":"add_guest", "guest": {"id":"g2","name":"Bob"} } ] }
```

Supported `op` values: `add_table`, `update_table`, `remove_table`, `add_guest`, `update_guest`, `remove_guest`, `assign_guest_seat`, `swap_seats`, `move_guest_table`, `change_seat_order_settings`.
Validation: operations applied atomically (transaction); any failure aborts.
Response 200: `{ "autosave_version":4, "plan_data": {"tables":[...],"guests":[...]}, "applied_ops": <count> }` (optionally return diff only to reduce payload).

#### POST /api/events/{event_id}/plan/tables

Create a table (shortcut single op). Request: `{ "shape":"round","capacity":10,"label":"Table 1","start_index":1,"head_seat":1 }` Response 201 with table object.

#### PATCH /api/events/{event_id}/plan/tables/{table_id}

Update table fields (capacity change triggers overflow validation). Request subset.
Overflow rule: if reducing capacity below assigned seats return 409 TABLE_CAPACITY_OVERFLOW with list of affected guest_ids.

#### DELETE /api/events/{event_id}/plan/tables/{table_id}

Removes table; guests become unseated (stay in guest list). Response 204.

#### POST /api/events/{event_id}/plan/guests

Add guest: `{ "name":"Alice","note":"Vegan","tag":"Family","rsvp":"Yes" }`. Response 201 guest.
Name required non-empty <= 150 chars.

#### PATCH /api/events/{event_id}/plan/guests/{guest_id}

Update guest (fields optional). Response 200 guest.

#### DELETE /api/events/{event_id}/plan/guests/{guest_id}

Remove guest; unassign from any seat. Response 204.

#### POST /api/events/{event_id}/plan/assign

Assign guest to table (random seat placement). Request: `{ "guest_id":"g1", "table_id":"t1" }`
Logic: server chooses empty seat per canonical ordering & randomization rules; returns updated seat assignment.
Response 200 `{ "table_id":"t1","seat_no":5 }`.
Errors: 409 TABLE_FULL.

#### POST /api/events/{event_id}/plan/seat-swap

Swap two seated guests. Request: `{ "a": {"table_id":"t1","seat_no":1}, "b": {"table_id":"t2","seat_no":3} }`.
Validation: both seats exist; if one empty treat as move.

#### POST /api/events/{event_id}/plan/seat-order

Change seat order settings per table. Request: `{ "table_id":"t1","start_index":1,"head_seat":1, "direction":"clockwise" }` direction currently implicit (only clockwise now) but reserved for future.
Response 200 updated table metadata.
Audit action: `seat_order_changed`.

### 2.4 Locking

#### POST /api/events/{event_id}/lock/acquire

Request optional `{ "minutes": 10 }`. Response 200 `{ "acquired": true, "expires_at": "ts" }` or 409 `{ "acquired": false, "held_by": "user_id", "expires_at": "ts" }`.

#### POST /api/events/{event_id}/lock/release

Releases if caller holds it. Response 200 `{ "released": true }` else 409 NOT_LOCK_OWNER.

#### GET /api/events/{event_id}/lock

Current lock status.

### 2.5 Autosave & Versioning

Autosave happens implicitly via plan endpoints; explicit manual snapshot endpoints:

#### POST /api/events/{event_id}/snapshots

Create manual snapshot. Request: `{ "label": "Pre import" }`.
Rate limit manual snapshots (e.g., 30/hour). Response 201 snapshot metadata.

#### GET /api/events/{event_id}/snapshots

List snapshots. Query: `limit,cursor,manual_only`.
Response items: `{ "id","label","is_manual", "created_at", "created_by", "previous_snapshot_id" }`.

#### GET /api/events/{event_id}/snapshots/{snapshot_id}

Full snapshot including `plan_data` (may be large). Query `plan=false` to omit.

#### POST /api/events/{event_id}/snapshots/{snapshot_id}/restore

Restore snapshot (creates new snapshot with `snapshot_restored` audit entry). Response 202 with new autosave_version after apply.

### 2.6 Share Links & Public Access

#### POST /api/events/{event_id}/share-links

Create share link. Request: `{ "password": "optional", "expires_at": "ts|null", "include_pii": false }`.
Response 201: `{ "id","token","url":"<computed>","expires_at","include_pii" }`.
Password hashed server-side (never returned).

#### GET /api/events/{event_id}/share-links

List active + revoked share links. Filters: `active=true|false`.

#### PATCH /api/events/{event_id}/share-links/{id}

Update mutable fields (password (rotate), expires_at, include_pii). Setting `password":""` removes protection.

#### POST /api/events/{event_id}/share-links/{id}/revoke

Marks revoked_at. Response 200.

#### GET /api/public/events/{token}

Unauthenticated share link access. Query: `pii=false` (ignored unless link includes PII). If password protected must send `Authorization: Bearer <derived JWT>` alternative or request body? Simpler design: POST with password if required.

#### POST /api/public/events/{token}/auth

Request: `{ "password":"..." }` obtains temporary session token (JWT with limited scope) to call GET endpoint. Response 200 `{ "access_token":"...","expires_in":3600 }`.

### 2.7 Share Link Access Logs

#### GET /api/events/{event_id}/share-links/{id}/access-logs

Owner-only. Filters: `from`, `to`, `pii_exposed`, `country`, pagination.

### 2.8 Audit Log

#### GET /api/events/{event_id}/audit-log

Filters: `action_type`, `from`, `to`, `user_id`. Paginated.
Response: list of `{ id, action_type, details, user_id, created_at }`.

### 2.9 Imports (XLSX Guest Import Flow)

#### GET /api/imports/template

Returns downloadable XLSX sample (binary). Query: `format=xlsx` default.

#### POST /api/events/{event_id}/imports/upload

Multipart/form-data: file field `file`, required consent fields: `consent_text` boolean ack.
Response 202: `{ "import_id":"uuid","status":"started" }` (async validation job begins).

#### GET /api/events/{event_id}/imports/{import_id}

Status + counts: `{ "id","status","row_count","duplicate_count","error_count","audit_trail":{...partial}}`.

#### POST /api/events/{event_id}/imports/{import_id}/resolve-duplicates

Request: `{ "decisions": [ { "group_id":"g123","action":"merge"|"reject","keep_id":"guestId?" } ] }`.
Response 200 updated status; transitions to `validated` when all ambiguous resolved.

#### POST /api/events/{event_id}/imports/{import_id}/finalize

Applies validated guests into `plan_data` (batched plan ops) and sets status `completed`, creates snapshot, audit entries `import_completed` + analytics events.
Errors: 409 IMPORT_NOT_VALIDATED.

#### GET /api/events/{event_id}/imports/{import_id}/errors

Download CSV/XLSX of row-level errors (binary) with columns row_number, field, error.

### 2.10 Guests (Flattened View)

Optionally expose convenience list separate from raw plan JSON for search.

#### GET /api/events/{event_id}/guests

Query filters: `search` (name ILIKE), `tag`, `rsvp`, `unseated=true`, `table_id`. Returns list derived from `plan_data` projection.

### 2.11 Exports

#### POST /api/events/{event_id}/exports

Create export. Request: `{ "type":"pdf"|"png"|"xlsx"|"csv", "include_notes": false, "orientation": "landscape" }`.
Response 202: `{ "export_id":"uuid","status":"pending" }`.

#### GET /api/events/{event_id}/exports/{export_id}

Status: `{ "status":"pending"|"completed"|"failed","download_url":"..." }`.

### 2.12 Data Requests (DSAR)

#### POST /api/data-requests

Request: `{ "type":"export"|"deletion", "event_id":"uuid|null" }`.
Response 202 data request row.

#### GET /api/data-requests

List caller’s data requests. Filters: `status`, `type`.

#### GET /api/data-requests/{id}

Single row + result_url when complete.

### 2.13 Analytics Events

#### POST /api/analytics

Request: `{ "events": [ { "event_type":"event_created", "event_id":"uuid|null", "metadata": {"source":"ui"} } ] }`.
Server validates allowed types; strips PII.
Response 202 accepted count.

### 2.14 Admin Flags

#### GET /api/admin/flags/me

Return current flags. Used to display limits (e.g., manual snapshot cap).

### 2.15 Health & Misc

#### GET /api/health

Return `{ "status":"ok","time":"ts" }` plus optional build info.

## 3. Authentication and Authorization

1. Primary auth: Supabase JWT (email/password, Google OAuth). Provided via `Authorization: Bearer <token>`; server (Astro route) uses Supabase client with the JWT to respect RLS.
2. Share link public access: token-based; optional password flow issues a short-lived scoped JWT (custom claim `share_event_id`). RLS bypass for public view served via RPC with service role (server-side); endpoint enforces token validity & password.
3. Service role operations (imports processing, export generation) executed in background tasks using service key, bypassing RLS where necessary (write to audit, analytics, logs). Background tasks isolated from user-triggered endpoints.
4. Authorization matrix:
   - Event owner: full CRUD on their events, snapshots, share links, audit logs, imports, exports, data requests referencing their event.
   - Share link viewer: read-only sanitized event data; cannot access raw endpoints (enforced by not exposing JWT with standard scopes).
   - Admin (future): flagged by custom claim; allowed extra management endpoints (not in MVP).
5. Locking: Acquire/Release endpoints validate ownership before calling DB function.
6. Rate limits (enforced via edge middleware / redis):
   - Autosave plan modifications: 10 req / 5s sliding window per event.
   - Snapshot creation: 30/hour per user (manual only).
   - Exports: default 10/day (use `admin_flags.rate_limit_exports_daily`).
   - Share link access (public): 60/min per token (to mitigate scraping).
   - Analytics ingest: 100/min per user.
7. Idempotency: Accept `Idempotency-Key` header for POST endpoints that create resources (snapshots, exports, data requests) storing key hash against user + type for 24h.
8. CORS: Lock down to app origin; public share endpoints allow GET from any origin with limited data & cache (short max-age). Password auth remains POST only.

## 4. Validation and Business Logic

### 4.1 Core Validation Rules

- `events.name`: required, length 1..150.
- `events.grid_rows`,`events.grid_cols`: integer >0 (DB check constraint).
- Table: `shape` in enum (`round|rectangular|long`), `capacity` >0, `start_index` >=1, `head_seat` between 1 and capacity.
- Guest: `name` required; length <=150; optional `tag`,`note` <= 300/500 characters (UI enforced, server max 1000 fallback).
- Seat assignment: must target existing table & empty seat; for random assign seat chosen among empties; for swap both seats must belong to existing tables.
- Seat order change: new indices valid within capacity; if capacity changed seats array trimmed at end preserving existing assignments until overflow check.
- Imports: file must be XLSX single-sheet; mandatory Name column mapping; duplicates resolved before finalize; cannot finalize with unresolved validation errors.
- Share link: password min length 8 if provided; expiration > now; cannot set both `revoked_at` and future expiration (revoked takes precedence).
- Data request: one pending deletion per event per user at a time; export & deletion concurrency limited (queue).
- Lock: only owner may acquire; existing non-expired lock by another user returns 409.
- Idempotency-Key: must be UUID v4 string; duplicate key returns previous response payload.

### 4.2 Business Logic Mapping

- Autosave & versioning: plan modifications increment `autosave_version`; periodic automatic snapshot (e.g., every N significant ops or every 5 minutes) executed server-side (not an endpoint) using service role + `create_snapshot` function (with is_manual=false).
- Undo/redo (client-side) uses `plan/bulk` endpoint to reapply operations; server stores audit entries for each underlying semantic action (batched details array). Undo stack not persisted across sessions per PRD.
- Random seat placement: shuffle available seats list seeded (e.g., crypto or event ID + guest ID hash) for fairness; canonical order ensures consistent numbering in exports.
- Seat numbering export alignment: rely on `start_index` and `head_seat` stored per table; export flatten function uses rule to output seat numbers; seat order changes logged (`seat_order_changed`).
- Soft edit lock: Acquire sets `lock_held_by` & `lock_expires_at`; background task clears expired locks; endpoints check and refresh expiration if same user re-acquires.
- Import duplicate detection: stored in `guest_imports.audit_trail` with groups and similarity scores; resolution decisions persisted; finalize merges or discards groups accordingly before applying added/updated guests to plan.
- Share link access logging: each public GET logs entry (async) capturing IP, user agent, derived geo, `pii_exposed` flag (mirrors include_pii at time of access).
- Data privacy: deletion request triggers asynchronous process anonymizing or removing PII fields in `plan_data` and associated logs except those required for legal retention (details out-of-scope for endpoint but audit logged).
- Analytics events ingestion sanitizes `metadata` (removes keys containing `name`, `note`, etc.).
- Rate limit exceedances return 429 with `Retry-After` header.

### 4.3 Error Codes (Representative)

- AUTH_REQUIRED (401)
- FORBIDDEN (403)
- EVENT_NOT_FOUND (404)
- VERSION_CONFLICT (409)
- TABLE_FULL (409)
- TABLE_CAPACITY_OVERFLOW (409)
- INVALID_EVENT_INPUT (400)
- INVALID_OPERATION (400)
- IMPORT_NOT_VALIDATED (409)
- IMPORT_ALREADY_FINALIZED (409)
- SHARE_LINK_NOT_FOUND (404)
- SHARE_LINK_REVOKED (410)
- PASSWORD_REQUIRED (401)
- PASSWORD_INVALID (401)
- RATE_LIMIT_EXCEEDED (429)
- NOT_LOCK_OWNER (409)
- DUPLICATE_IDEMPOTENCY_KEY (409)
- DATA_REQUEST_CONFLICT (409)

### 4.4 Response Minimization & Performance

- Large JSON (`plan_data`) can exceed mobile budget; support selective projection via `?tables=true&guests=true&settings=true` flags.
- ETag header: for GET event or snapshot returns hash of `updated_at` + `autosave_version`; clients use conditional GET (`If-None-Match`) to reduce bandwidth (304).
- Compression: enable gzip/br (Astro adapter). JSON trimmed of nulls.
- Cursor tokens: opaque base64 JSON { last_id, created_at } signed (HMAC) to prevent tampering.

### 4.5 Security Controls

- Input validation via zod schemas per endpoint; reject unknown fields (`stripUnknown`).
- All mutations require lock (optional strict mode). Option: server warns but allows if no lock held (MVP enforces lock for plan mutations to avoid race conditions).
- Password hashing for share links using Argon2id.
- Export download URLs are pre-signed (time-limited) object storage links; not directly served by API after generation.
- Audit logging: Each mutation endpoint writes an audit row with action_type + details (e.g., changed fields, counts) using service role.
- Sensitive endpoints (imports finalize, snapshot restore, share link revoke) require recent re-auth (optionally enforce by checking `auth_time` claim age < 1 hour—future enhancement).

### 4.6 Logging & Observability

- Structured logs (JSON) include request id, user id, event id, latency, error code.
- Correlation id header `X-Request-Id` echoed back; clients may supply else generated.
- Metrics: counts of endpoint hits, latency histograms, error codes for alerting.

### 4.7 Assumptions

- Background job system (e.g., Deno/Node worker or external queue) exists for async tasks (imports processing, exports generation, data request fulfillment) – not covered by endpoints but referenced.
- Public share token endpoints operate outside Supabase RLS by invoking service role on restricted RPC that returns sanitized plan data (server ensures no PII unless permitted).
- Export generation uses current snapshot (implicit auto-snapshot right before processing to ensure deterministic state).

---

This API plan provides the foundation for implementing Astro server routes with Supabase-backed persistence, satisfying MVP functional, compliance, performance, and security requirements.
