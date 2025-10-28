# Wedding Seating App Database Schema (PostgreSQL / Supabase)

## 1. Tables

### 1.1 profiles

Holds public user profile data separate from `auth.users`.
| Column | Type | Constraints |
|--------|------|------------|
| user_id | uuid | primary key, references auth.users(id) on delete cascade |
| display_name | text | not null |
| avatar_url | text | null |
| created_at | timestamptz | default now() not null |
| updated_at | timestamptz | default now() not null |

### 1.2 events

Central entity representing a seating plan (plan state stored as JSONB for MVP).
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | primary key (default gen_random_uuid()) |
| owner_id | uuid | not null references auth.users(id) on delete cascade |
| name | text | not null |
| event_date | date | null |
| grid_rows | int | not null check (grid_rows > 0) |
| grid_cols | int | not null check (grid_cols > 0) |
| plan_data | jsonb | not null default '{}'::jsonb |
| autosave_version | int | not null default 0 |
| lock_held_by | uuid | null references auth.users(id) on delete set null |
| lock_expires_at | timestamptz | null |
| deleted_at | timestamptz | null (soft delete) |
| created_at | timestamptz | default now() not null |
| updated_at | timestamptz | default now() not null |

`plan_data` JSONB suggested structure (not enforced): {
"tables": [ { "id": "t1", "shape": "round", "capacity": 10, "label": "Table 1", "start_index": 1, "head_seat": 1, "seats": [ { "seat_no": 1, "guest_id": "g1" }, ... ] } ],
"guests": [ { "id": "g1", "name": "Alice Smith", "note": "Vegan", "tag": "Family", "rsvp": "Yes" } ],
"settings": { "color_palette": "default" }
}

### 1.3 snapshots

Version history for events; stores full copies of `plan_data`.
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | primary key default gen_random_uuid() |
| event_id | uuid | not null references events(id) on delete cascade |
| created_by | uuid | not null references auth.users(id) on delete set null |
| label | text | null (user-provided name) |
| is_manual | boolean | not null default false |
| plan_data | jsonb | not null |
| diff_summary | jsonb | null (summary of changes vs previous snapshot) |
| previous_snapshot_id | uuid | null references snapshots(id) on delete set null |
| created_at | timestamptz | default now() not null |

### 1.4 share_links

View-only share links for events.
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | primary key default gen_random_uuid() |
| event_id | uuid | not null references events(id) on delete cascade |
| created_by | uuid | not null references auth.users(id) on delete set null |
| token | text | not null unique (e.g. nanoid) |
| password_hash | text | null (bcrypt/argon2) |
| expires_at | timestamptz | null |
| revoked_at | timestamptz | null |
| revoked_by | uuid | null references auth.users(id) on delete set null |
| include_pii | boolean | not null default false |
| last_accessed_at | timestamptz | null |
| created_at | timestamptz | default now() not null |

### 1.5 access_logs

Logs each access to a share link.
| Column | Type | Constraints |
|--------|------|------------|
| id | bigserial | primary key |
| share_link_id | uuid | not null references share_links(id) on delete cascade |
| event_id | uuid | not null references events(id) on delete cascade |
| accessed_at | timestamptz | default now() not null |
| ip | inet | null |
| user_agent | text | null |
| geo_country | text | null |
| pii_exposed | boolean | not null default false |

### 1.6 audit_log

High-level audit trail of meaningful actions.
| Column | Type | Constraints |
|--------|------|------------|
| id | bigserial | primary key |
| event_id | uuid | not null references events(id) on delete cascade |
| user_id | uuid | null references auth.users(id) on delete set null |
| action_type | action_type_enum | not null |
| details | jsonb | null |
| share_link_id | uuid | null references share_links(id) on delete set null |
| created_at | timestamptz | default now() not null |

### 1.7 import_consent

Stores GDPR/CCPA consent at time of import.
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | primary key default gen_random_uuid() |
| event_id | uuid | not null references events(id) on delete cascade |
| user_id | uuid | not null references auth.users(id) on delete cascade |
| ip | inet | null |
| consent_text | text | not null |
| created_at | timestamptz | default now() not null |

### 1.8 guest_imports

Metadata & audit for XLSX imports.
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | primary key default gen_random_uuid() |
| event_id | uuid | not null references events(id) on delete cascade |
| user_id | uuid | not null references auth.users(id) on delete cascade |
| original_filename | text | null |
| row_count | int | not null default 0 |
| duplicate_count | int | not null default 0 |
| error_count | int | not null default 0 |
| status | import_status_enum | not null |
| audit_trail | jsonb | null |
| started_at | timestamptz | default now() not null |
| completed_at | timestamptz | null |

### 1.9 data_requests

Data export / deletion (DSAR) requests.
| Column | Type | Constraints |
|--------|------|------------|
| id | uuid | primary key default gen_random_uuid() |
| user_id | uuid | not null references auth.users(id) on delete cascade |
| event_id | uuid | null references events(id) on delete cascade |
| type | data_request_type_enum | not null |
| status | data_request_status_enum | not null default 'pending' |
| result_url | text | null |
| requested_at | timestamptz | default now() not null |
| processed_at | timestamptz | null |

### 1.10 analytics_events (minimal, privacy-conscious)

Instrumentation of core actions without PII.
| Column | Type | Constraints |
|--------|------|------------|
| id | bigserial | primary key |
| event_type | analytics_event_type_enum | not null |
| event_id | uuid | null references events(id) on delete cascade |
| user_id | uuid | null references auth.users(id) on delete set null |
| metadata | jsonb | null |
| created_at | timestamptz | default now() not null |

### 1.11 admin_flags (optional future-proofing)

Feature flags or limits per user (for rate limits, manual snapshot caps).
| Column | Type | Constraints |
|--------|------|------------|
| user_id | uuid | primary key references auth.users(id) on delete cascade |
| max_manual_snapshots | int | not null default 0 |
| rate_limit_exports_daily | int | not null default 10 |
| created_at | timestamptz | default now() not null |
| updated_at | timestamptz | default now() not null |

## 2. Enumerated Types

```sql
CREATE TYPE table_shape_enum AS ENUM ('round', 'rectangular', 'long');
CREATE TYPE action_type_enum AS ENUM (
  'guest_add','guest_edit','guest_delete','table_create','table_update','seat_swap',
  'import_started','import_completed','share_link_created','share_link_revoked',
  'export_generated','lock_acquired','lock_released','snapshot_created','snapshot_restored',
  'data_request_created','seat_order_changed'
);
CREATE TYPE import_status_enum AS ENUM ('started','validated','completed','failed');
CREATE TYPE data_request_type_enum AS ENUM ('export','deletion');
CREATE TYPE data_request_status_enum AS ENUM ('pending','processing','completed','rejected');
CREATE TYPE analytics_event_type_enum AS ENUM (
  'event_created','import_started','import_completed','import_errors','first_save',
  'share_link_created','share_link_clicked','export_generated','feedback_submitted'
);
```

## 3. Relationships

- profiles 1:1 auth.users
- events M:1 auth.users (owner_id)
- events (lock_held_by) optional M:1 auth.users
- snapshots M:1 events; snapshots M:1 auth.users (created_by); self reference previous_snapshot_id
- share_links M:1 events; share_links M:1 auth.users (created_by)
- access_logs M:1 share_links; access_logs M:1 events
- audit_log M:1 events; M:1 auth.users (user_id); optional M:1 share_links
- import_consent M:1 events; M:1 auth.users
- guest_imports M:1 events; M:1 auth.users
- data_requests M:1 auth.users; optional M:1 events
- analytics_events optional M:1 events; optional M:1 auth.users
- admin_flags 1:1 auth.users

Cardinalities: All foreign keys are many-to-one referencing parent tables; no direct many-to-many relationships required in MVP due to JSONB seat/guest embedding.

## 4. Indexes

```sql
-- events
CREATE INDEX events_owner_id_idx ON events(owner_id);
CREATE INDEX events_lock_expires_at_idx ON events(lock_expires_at);
CREATE INDEX events_deleted_at_idx ON events(deleted_at) WHERE deleted_at IS NOT NULL;
-- Optional GIN for plan_data queries
CREATE INDEX events_plan_data_gin_idx ON events USING GIN (plan_data);

-- snapshots
CREATE INDEX snapshots_event_created_idx ON snapshots(event_id, created_at DESC);

-- share_links
CREATE UNIQUE INDEX share_links_token_key ON share_links(token);
CREATE INDEX share_links_event_idx ON share_links(event_id);
CREATE INDEX share_links_active_idx ON share_links(event_id) WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

-- access_logs
CREATE INDEX access_logs_share_link_idx ON access_logs(share_link_id, accessed_at DESC);
CREATE INDEX access_logs_event_idx ON access_logs(event_id);

-- audit_log
CREATE INDEX audit_log_event_created_idx ON audit_log(event_id, created_at DESC);
CREATE INDEX audit_log_action_type_idx ON audit_log(action_type);

-- import_consent
CREATE INDEX import_consent_event_idx ON import_consent(event_id);

-- guest_imports
CREATE INDEX guest_imports_event_idx ON guest_imports(event_id);
CREATE INDEX guest_imports_status_idx ON guest_imports(status);

-- data_requests
CREATE INDEX data_requests_user_status_idx ON data_requests(user_id, status);

-- analytics_events
CREATE INDEX analytics_events_type_time_idx ON analytics_events(event_type, created_at DESC);
CREATE INDEX analytics_events_event_idx ON analytics_events(event_id);

-- admin_flags none needed beyond PK; add if querying limits frequently
```

## 5. Row-Level Security (RLS) Policies

Enable RLS on all custom tables (Supabase default disabled until explicitly enabled).

### 5.1 profiles

```sql
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY profiles_select_self ON profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY profiles_select_public ON profiles FOR SELECT USING (true) WITH CHECK (true) -- if limited public fields via view;
CREATE POLICY profiles_insert_self ON profiles FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY profiles_update_self ON profiles FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

(Optionally expose a limited view `public_profiles` instead of broad policy.)

### 5.2 events

```sql
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
CREATE POLICY events_owner_select ON events FOR SELECT USING (auth.uid() = owner_id AND deleted_at IS NULL);
CREATE POLICY events_owner_modify ON events FOR UPDATE USING (auth.uid() = owner_id AND deleted_at IS NULL) WITH CHECK (auth.uid() = owner_id);
CREATE POLICY events_owner_delete ON events FOR DELETE USING (auth.uid() = owner_id);
CREATE POLICY events_insert_owner ON events FOR INSERT WITH CHECK (auth.uid() = owner_id);
```

(Access via share token handled by an RPC that bypasses RLS with service role.)

### 5.3 snapshots

```sql
ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY snapshots_owner_select ON snapshots FOR SELECT USING (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = snapshots.event_id));
CREATE POLICY snapshots_owner_insert ON snapshots FOR INSERT WITH CHECK (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = snapshots.event_id));
-- Immutable: no UPDATE/DELETE except maybe cleanup via service role.
```

### 5.4 share_links

```sql
ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY share_links_owner_all ON share_links FOR ALL USING (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = share_links.event_id)) WITH CHECK (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = share_links.event_id));
```

(View-only access for external viewers done through a server-side function returning a sanitized event view.)

### 5.5 access_logs

```sql
ALTER TABLE access_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY access_logs_owner_select ON access_logs FOR SELECT USING (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = access_logs.event_id));
CREATE POLICY access_logs_owner_insert ON access_logs FOR INSERT WITH CHECK (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = access_logs.event_id)) -- Optionally restrict; typically inserted via service role.
```

(Prefer inserts via service role; remove insert policy if so.)

### 5.6 audit_log

```sql
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_owner_select ON audit_log FOR SELECT USING (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = audit_log.event_id));
-- Inserts via service role; no update/delete.
```

### 5.7 import_consent

```sql
ALTER TABLE import_consent ENABLE ROW LEVEL SECURITY;
CREATE POLICY import_consent_owner_select ON import_consent FOR SELECT USING (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = import_consent.event_id));
CREATE POLICY import_consent_owner_insert ON import_consent FOR INSERT WITH CHECK (auth.uid() = user_id AND auth.uid() = (SELECT owner_id FROM events e WHERE e.id = import_consent.event_id));
```

### 5.8 guest_imports

```sql
ALTER TABLE guest_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY guest_imports_owner_select ON guest_imports FOR SELECT USING (auth.uid() = (SELECT owner_id FROM events e WHERE e.id = guest_imports.event_id));
CREATE POLICY guest_imports_owner_insert ON guest_imports FOR INSERT WITH CHECK (auth.uid() = user_id AND auth.uid() = (SELECT owner_id FROM events e WHERE e.id = guest_imports.event_id));
CREATE POLICY guest_imports_owner_update ON guest_imports FOR UPDATE USING (auth.uid() = user_id AND auth.uid() = (SELECT owner_id FROM events e WHERE e.id = guest_imports.event_id)) WITH CHECK (auth.uid() = user_id);
```

### 5.9 data_requests

```sql
ALTER TABLE data_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_requests_owner_select ON data_requests FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY data_requests_owner_insert ON data_requests FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY data_requests_owner_update ON data_requests FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
```

(Admin actions (processing) performed via service role.)

### 5.10 analytics_events

```sql
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
-- Restrict direct access; only service role inserts, no user selects.
CREATE POLICY analytics_events_no_access ON analytics_events FOR SELECT USING (false);
```

(Expose aggregated metrics through RPC with service role if needed.)

### 5.11 admin_flags

```sql
ALTER TABLE admin_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_flags_self_select ON admin_flags FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY admin_flags_self_update ON admin_flags FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY admin_flags_self_insert ON admin_flags FOR INSERT WITH CHECK (auth.uid() = user_id);
```

(Admin overrides via service role.)

## 6. Functions (Suggested)

(Not part of table list, but essential for concurrency/security.)

```sql
CREATE OR REPLACE FUNCTION acquire_event_lock(p_event_id uuid, p_minutes int DEFAULT 10)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_owner uuid; v_now timestamptz := now();
BEGIN
  SELECT owner_id INTO v_owner FROM events WHERE id = p_event_id AND deleted_at IS NULL;
  IF v_owner IS NULL OR v_owner <> auth.uid() THEN RETURN FALSE; END IF;
  UPDATE events SET lock_held_by = auth.uid(), lock_expires_at = v_now + (p_minutes || ' minutes')::interval
  WHERE id = p_event_id
    AND (lock_held_by IS NULL OR lock_expires_at < v_now OR lock_held_by = auth.uid());
  RETURN FOUND;
END;$$;

CREATE OR REPLACE FUNCTION release_event_lock(p_event_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE events SET lock_held_by = NULL, lock_expires_at = NULL
  WHERE id = p_event_id AND lock_held_by = auth.uid() RETURNING true;
$$;

CREATE OR REPLACE FUNCTION create_snapshot(p_event_id uuid, p_label text DEFAULT NULL, p_is_manual boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_plan jsonb; v_id uuid := gen_random_uuid(); v_prev uuid;
BEGIN
  SELECT plan_data INTO v_plan FROM events WHERE id = p_event_id AND owner_id = auth.uid();
  SELECT id INTO v_prev FROM snapshots WHERE event_id = p_event_id ORDER BY created_at DESC LIMIT 1;
  INSERT INTO snapshots(id,event_id,created_by,label,is_manual,plan_data,previous_snapshot_id)
  VALUES (v_id,p_event_id,auth.uid(),p_label,COALESCE(p_is_manual,false),v_plan,v_prev);
  RETURN v_id;
END;$$;
```

## 7. Additional Notes & Design Decisions

- JSONB `plan_data` chosen to minimize joins and simplify autosave/versioning; acceptable for MVP single-editor model. Future scalability can introduce normalized `guests`, `tables`, `seats` tables with migration.
- GIN index on `plan_data` is optional; add only if queries (e.g., searching guest by tag) become frequent.
- Soft locking performed at application layer using atomic functions; lock timeout handled by periodic checks on `lock_expires_at`.
- Audit & access logs kept separate for compliance and retention strategies (can be moved to cheaper storage later).
- Enumerated types enforce controlled vocabulary for actions and statuses improving data integrity and simplifying analytics.
- All RLS policies rely on direct ownership; shared link viewers never hit tables directly (use RPC returning sanitized projection to prevent PII leakage unless `include_pii` is true).
- DSAR requests logged in `data_requests`; deletion flow should scrub PII inside `plan_data` while retaining minimal audit entries (outside scope of schema DDL specifics).
- `deleted_at` soft delete on events used to retain snapshots & logs temporarily for recovery; background job can hard-delete after grace period.
- Provide views (not defined here) for: `event_public_view(token)` (RPC), `export_assignments(event_id)` (flattens `plan_data` for CSV/XLSX), and anonymized analytics aggregations.
- Consider partitioning `access_logs` & `audit_log` by time if volume grows (not required MVP).
- Compression: enable TOAST compression defaults for large JSONB snapshots.
- Future: add `constraint ensure_manual_snapshot_limit` utilizing `admin_flags.max_manual_snapshots` via trigger if needed.

---

This schema covers all PRD functional areas: events, versioning, sharing, locking, imports, consent, exports (via functions/views), audits, analytics, compliance, and performance (indexed FKs + optional GIN). Ready for migration authoring.
