-- migration: initial wedding seating app schema
-- timestamp (utc): 2025-10-28 23:09:01
-- description: creates enumerated types, tables, indexes, rls policies, and helper functions
-- includes: profiles, events, snapshots, share_links, access_logs, audit_log, import_consent,
--           guest_imports, data_requests, analytics_events, admin_flags
-- design notes:
--   * plan_data stored as jsonb in events & snapshots for mvp simplicity
--   * all tables have row level security enabled immediately after creation
--   * policies follow principle of least privilege; ownership-based access model
--   * external (public) viewing via share links is handled through secure rpc (service role) not direct table access
--   * analytics_events intentionally restricted (no direct end-user select) for privacy
--   * audit & access logs mostly inserted via service role; limited read for owners
-- safety: this migration is additive only (no drops) and can be rolled back by dropping created objects (not included)

-- =============================================
-- 1. enumerated types
-- =============================================
create type table_shape_enum as enum ('round','rectangular','long');
create type action_type_enum as enum (
  'guest_add','guest_edit','guest_delete','table_create','table_update','seat_swap',
  'import_started','import_completed','share_link_created','share_link_revoked',
  'export_generated','lock_acquired','lock_released','snapshot_created','snapshot_restored',
  'data_request_created','seat_order_changed'
);
create type import_status_enum as enum ('started','validated','completed','failed');
create type data_request_type_enum as enum ('export','deletion');
create type data_request_status_enum as enum ('pending','processing','completed','rejected');
create type analytics_event_type_enum as enum (
  'event_created','import_started','import_completed','import_errors','first_save',
  'share_link_created','share_link_clicked','export_generated','feedback_submitted'
);

-- =============================================
-- 2. tables
-- =============================================

-- 2.1 profiles (public user profile data; separate from auth.users)
create table if not exists profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  avatar_url text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table profiles is 'public user profile data; one row per auth user';

-- 2.2 events (core seating plan entity)
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  event_date date null,
  grid_rows int not null check (grid_rows > 0),
  grid_cols int not null check (grid_cols > 0),
  plan_data jsonb not null default '{}'::jsonb,
  autosave_version int not null default 0,
  lock_held_by uuid null references auth.users (id) on delete set null,
  lock_expires_at timestamptz null,
  deleted_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table events is 'seating plan container with embedded tables & guests jsonb for mvp';

-- 2.3 snapshots (version history of events)
create table if not exists snapshots (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete set null,
  label text null,
  is_manual boolean not null default false,
  plan_data jsonb not null,
  diff_summary jsonb null,
  previous_snapshot_id uuid null references snapshots (id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table snapshots is 'immutable version history of events.plan_data';

-- 2.4 share_links (view-only share tokens)
create table if not exists share_links (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete set null,
  token text not null unique,
  password_hash text null,
  expires_at timestamptz null,
  revoked_at timestamptz null,
  revoked_by uuid null references auth.users (id) on delete set null,
  include_pii boolean not null default false,
  last_accessed_at timestamptz null,
  created_at timestamptz not null default now()
);
comment on table share_links is 'event share tokens for external view-only access';

-- 2.5 access_logs (logs of share link accesses)
create table if not exists access_logs (
  id bigserial primary key,
  share_link_id uuid not null references share_links (id) on delete cascade,
  event_id uuid not null references events (id) on delete cascade,
  accessed_at timestamptz not null default now(),
  ip inet null,
  user_agent text null,
  geo_country text null,
  pii_exposed boolean not null default false
);
comment on table access_logs is 'audits each external share link access';

-- 2.6 audit_log (high level action trail)
create table if not exists audit_log (
  id bigserial primary key,
  event_id uuid not null references events (id) on delete cascade,
  user_id uuid null references auth.users (id) on delete set null,
  action_type action_type_enum not null,
  details jsonb null,
  share_link_id uuid null references share_links (id) on delete set null,
  created_at timestamptz not null default now()
);
comment on table audit_log is 'high-level action trail for compliance and history';

-- 2.7 import_consent (records consent at import time)
create table if not exists import_consent (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  ip inet null,
  consent_text text not null,
  created_at timestamptz not null default now()
);
comment on table import_consent is 'stores gdpr/ccpa consent text & metadata at time of guest import';

-- 2.8 guest_imports (xlsx import metadata & audit)
create table if not exists guest_imports (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  original_filename text null,
  row_count int not null default 0,
  duplicate_count int not null default 0,
  error_count int not null default 0,
  status import_status_enum not null,
  audit_trail jsonb null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null
);
comment on table guest_imports is 'metadata and audit trail for spreadsheet guest imports';

-- 2.9 data_requests (dsar export/deletion requests)
create table if not exists data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  event_id uuid null references events (id) on delete cascade,
  type data_request_type_enum not null,
  status data_request_status_enum not null default 'pending',
  result_url text null,
  requested_at timestamptz not null default now(),
  processed_at timestamptz null
);
comment on table data_requests is 'tracks user data export or deletion requests for compliance';

-- 2.10 analytics_events (minimal privacy-conscious instrumentation)
create table if not exists analytics_events (
  id bigserial primary key,
  event_type analytics_event_type_enum not null,
  event_id uuid null references events (id) on delete cascade,
  user_id uuid null references auth.users (id) on delete set null,
  metadata jsonb null,
  created_at timestamptz not null default now()
);
comment on table analytics_events is 'core product analytics without pii; restricted access';

-- 2.11 admin_flags (optional feature flags / limits)
create table if not exists admin_flags (
  user_id uuid primary key references auth.users (id) on delete cascade,
  max_manual_snapshots int not null default 0,
  rate_limit_exports_daily int not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table admin_flags is 'per-user feature flags and rate limits';

-- =============================================
-- 3. indexes
-- =============================================
-- events indexes
create index if not exists events_owner_id_idx on events(owner_id);
create index if not exists events_lock_expires_at_idx on events(lock_expires_at);
create index if not exists events_deleted_at_idx on events(deleted_at) where deleted_at is not null;
-- optional gin for jsonb plan queries
create index if not exists events_plan_data_gin_idx on events using gin (plan_data);

-- snapshots
create index if not exists snapshots_event_created_idx on snapshots(event_id, created_at desc);

-- share_links
create unique index if not exists share_links_token_key on share_links(token);
create index if not exists share_links_event_idx on share_links(event_id);
create index if not exists share_links_event_revoked_idx on share_links(event_id) where revoked_at is null;
create index if not exists share_links_event_expires_idx on share_links(event_id, expires_at);

-- access_logs
create index if not exists access_logs_share_link_idx on access_logs(share_link_id, accessed_at desc);
create index if not exists access_logs_event_idx on access_logs(event_id);

-- audit_log
create index if not exists audit_log_event_created_idx on audit_log(event_id, created_at desc);
create index if not exists audit_log_action_type_idx on audit_log(action_type);

-- import_consent
create index if not exists import_consent_event_idx on import_consent(event_id);

-- guest_imports
create index if not exists guest_imports_event_idx on guest_imports(event_id);
create index if not exists guest_imports_status_idx on guest_imports(status);

-- data_requests
create index if not exists data_requests_user_status_idx on data_requests(user_id, status);

-- analytics_events
create index if not exists analytics_events_type_time_idx on analytics_events(event_type, created_at desc);
create index if not exists analytics_events_event_idx on analytics_events(event_id);

-- =============================================
-- 4. row level security enablement
-- =============================================
alter table profiles enable row level security;
alter table events enable row level security;
alter table snapshots enable row level security;
alter table share_links enable row level security;
alter table access_logs enable row level security;
alter table audit_log enable row level security;
alter table import_consent enable row level security;
alter table guest_imports enable row level security;
alter table data_requests enable row level security;
alter table analytics_events enable row level security;
alter table admin_flags enable row level security;

-- =============================================
-- 5. policies (least privilege, separated per operation & role)
-- note: for simplicity, anon role typically has no access except possibly public profiles view
-- =============================================

-- 5.1 profiles policies
-- allow authenticated users to select their own profile
create policy profiles_select_self_authenticated on profiles for select to authenticated using (auth.uid() = user_id);
-- allow authenticated users to insert/update only their own profile
create policy profiles_insert_self_authenticated on profiles for insert to authenticated with check (auth.uid() = user_id);
create policy profiles_update_self_authenticated on profiles for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- optional public read (anon) of non-sensitive fields could be via a view; here we restrict anon entirely for safety
create policy profiles_no_anon_select on profiles for select to anon using (false);

-- 5.2 events policies (owners only)
create policy events_owner_select_authenticated on events for select to authenticated using (auth.uid() = owner_id and deleted_at is null);
create policy events_owner_insert_authenticated on events for insert to authenticated with check (auth.uid() = owner_id);
create policy events_owner_update_authenticated on events for update to authenticated using (auth.uid() = owner_id and deleted_at is null) with check (auth.uid() = owner_id);
create policy events_owner_delete_authenticated on events for delete to authenticated using (auth.uid() = owner_id);
-- deny anon entirely
create policy events_no_anon_access on events for all to anon using (false);

-- 5.3 snapshots policies (owner derived from events)
create policy snapshots_owner_select_authenticated on snapshots for select to authenticated using (auth.uid() = (select owner_id from events e where e.id = snapshots.event_id));
create policy snapshots_owner_insert_authenticated on snapshots for insert to authenticated with check (auth.uid() = (select owner_id from events e where e.id = snapshots.event_id));
-- immutable (no update/delete); explicitly deny other ops by absence & deny anon
create policy snapshots_no_anon_select on snapshots for select to anon using (false);

-- 5.4 share_links policies (owner management only)
create policy share_links_owner_all_authenticated on share_links for all to authenticated using (auth.uid() = (select owner_id from events e where e.id = share_links.event_id)) with check (auth.uid() = (select owner_id from events e where e.id = share_links.event_id));
create policy share_links_no_anon_all on share_links for all to anon using (false);

-- 5.5 access_logs policies (owner can view; inserts usually via service role)
create policy access_logs_owner_select_authenticated on access_logs for select to authenticated using (auth.uid() = (select owner_id from events e where e.id = access_logs.event_id));
-- optional insert if app chooses to let client log accesses (normally service role) restrict to owner
create policy access_logs_owner_insert_authenticated on access_logs for insert to authenticated with check (auth.uid() = (select owner_id from events e where e.id = access_logs.event_id));
create policy access_logs_no_anon_access on access_logs for all to anon using (false);

-- 5.6 audit_log policies (owner read only)
create policy audit_log_owner_select_authenticated on audit_log for select to authenticated using (auth.uid() = (select owner_id from events e where e.id = audit_log.event_id));
create policy audit_log_no_anon_select on audit_log for select to anon using (false);

-- 5.7 import_consent policies (owner and user same)
create policy import_consent_owner_select_authenticated on import_consent for select to authenticated using (auth.uid() = (select owner_id from events e where e.id = import_consent.event_id));
create policy import_consent_owner_insert_authenticated on import_consent for insert to authenticated with check (auth.uid() = user_id and auth.uid() = (select owner_id from events e where e.id = import_consent.event_id));
create policy import_consent_no_anon_access on import_consent for all to anon using (false);

-- 5.8 guest_imports policies
create policy guest_imports_owner_select_authenticated on guest_imports for select to authenticated using (auth.uid() = (select owner_id from events e where e.id = guest_imports.event_id));
create policy guest_imports_owner_insert_authenticated on guest_imports for insert to authenticated with check (auth.uid() = user_id and auth.uid() = (select owner_id from events e where e.id = guest_imports.event_id));
create policy guest_imports_owner_update_authenticated on guest_imports for update to authenticated using (auth.uid() = user_id and auth.uid() = (select owner_id from events e where e.id = guest_imports.event_id)) with check (auth.uid() = user_id);
create policy guest_imports_no_anon_access on guest_imports for all to anon using (false);

-- 5.9 data_requests policies (user scoped)
create policy data_requests_user_select_authenticated on data_requests for select to authenticated using (auth.uid() = user_id);
create policy data_requests_user_insert_authenticated on data_requests for insert to authenticated with check (auth.uid() = user_id);
create policy data_requests_user_update_authenticated on data_requests for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy data_requests_no_anon_access on data_requests for all to anon using (false);

-- 5.10 analytics_events policies (deny end-user access entirely)
create policy analytics_events_no_select_authenticated on analytics_events for select to authenticated using (false);
create policy analytics_events_no_select_anon on analytics_events for select to anon using (false);
-- inserts expected via service role bypassing rls; no user insert/update/delete policies defined

-- 5.11 admin_flags policies (self only)
create policy admin_flags_self_select_authenticated on admin_flags for select to authenticated using (auth.uid() = user_id);
create policy admin_flags_self_insert_authenticated on admin_flags for insert to authenticated with check (auth.uid() = user_id);
create policy admin_flags_self_update_authenticated on admin_flags for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy admin_flags_no_anon_access on admin_flags for all to anon using (false);

-- =============================================
-- 6. functions (security definer for locking & snapshots)
-- note: SECURITY DEFINER allows controlled privilege escalation; ensure owner is trusted.
-- ensure search_path safety by setting it explicitly (avoid injection via malicious objects)
-- =============================================

create or replace function acquire_event_lock(p_event_id uuid, p_minutes int default 10)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare v_owner uuid; v_now timestamptz := now();
begin
  select owner_id into v_owner from events where id = p_event_id and deleted_at is null;
  if v_owner is null or v_owner <> auth.uid() then
    return false;
  end if;
  update events set lock_held_by = auth.uid(), lock_expires_at = v_now + (p_minutes || ' minutes')::interval
    where id = p_event_id
      and (lock_held_by is null or lock_expires_at < v_now or lock_held_by = auth.uid());
  return found;
end;$$;
comment on function acquire_event_lock(uuid, int) is 'attempt to acquire an edit lock on an event for the authenticated owner';

create or replace function release_event_lock(p_event_id uuid)
returns boolean language sql security definer set search_path = public, pg_temp as $$
  update events set lock_held_by = null, lock_expires_at = null
  where id = p_event_id and lock_held_by = auth.uid() returning true;
$$;
comment on function release_event_lock(uuid) is 'release the current edit lock if held by caller';

create or replace function create_snapshot(p_event_id uuid, p_label text default null, p_is_manual boolean default false)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare v_plan jsonb; v_id uuid := gen_random_uuid(); v_prev uuid;
begin
  select plan_data into v_plan from events where id = p_event_id and owner_id = auth.uid();
  if v_plan is null then
    raise exception 'event not found or not owned by user';
  end if;
  select id into v_prev from snapshots where event_id = p_event_id order by created_at desc limit 1;
  insert into snapshots(id,event_id,created_by,label,is_manual,plan_data,previous_snapshot_id)
    values (v_id,p_event_id,auth.uid(),p_label,coalesce(p_is_manual,false),v_plan,v_prev);
  return v_id;
end;$$;
comment on function create_snapshot(uuid, text, boolean) is 'capture current plan_data of an owned event into snapshots';

-- =============================================
-- 7. additional hardening suggestions (non-executable comments)
-- * consider triggers for updated_at maintenance
-- * consider partitioning large log tables in future
-- * ensure service role handles external share link viewing logic
-- =============================================

-- end of migration
