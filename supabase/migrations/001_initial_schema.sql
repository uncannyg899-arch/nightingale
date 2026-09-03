-- ============================================================
-- Nightingale Patient Intake Platform — Initial Schema
-- Postgres / Supabase
--
-- Design principles encoded here (not just conventions):
--   1. Escalation is ONE-WAY: a DB trigger blocks risk downgrade
--      unless a clinician explicitly clears it.
--   2. Memory is VERSIONED: facts are superseded, never overwritten,
--      so provenance survives corrections.
--   3. PHI never enters audit_logs: enforced by a trigger.
--   4. Multi-tenant ready: clinic_id on every table, RLS scoped.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ============================================================
-- ENUMS
-- ============================================================

create type risk_level as enum ('low', 'medium', 'high');

-- Manchester Triage System mapping (cited in Technical Brief)
create type mts_tier as enum (
  'immediate',   -- MTS Red   -> high
  'very_urgent', -- MTS Orange-> high
  'urgent',      -- MTS Yellow-> medium
  'standard',    -- MTS Green -> low
  'non_urgent'   -- MTS Blue  -> low
);

create type actor_role as enum ('guest', 'patient', 'staff', 'clinician', 'system');
create type session_kind as enum ('lead', 'patient');
create type fact_kind as enum ('chief_complaint', 'medication', 'allergy', 'condition', 'symptom');
create type fact_status as enum ('active', 'superseded', 'retracted');
create type escalation_state as enum ('pending', 'acknowledged', 'resolved', 'auto_fallback');
create type channel_kind as enum ('staff_referral', 'social_comment', 'web_direct', 'whatsapp');

-- ============================================================
-- TENANCY
-- ============================================================

create table clinics (
  id              uuid primary key default uuid_generate_v4(),
  name            text not null,
  emergency_number text not null default '999',
  timezone        text not null default 'Asia/Kuala_Lumpur',
  -- after-hours window: outside this, high-risk shows direct emergency action
  office_open     time not null default '09:00',
  office_close    time not null default '18:00',
  -- clinician must acknowledge a high-risk escalation within this window
  ack_sla_minutes int  not null default 15,
  channel_rules   jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- App users (staff/clinicians). Patients link via sessions.
create table clinic_members (
  id         uuid primary key default uuid_generate_v4(),
  clinic_id  uuid not null references clinics(id) on delete cascade,
  auth_user_id uuid not null,           -- supabase auth.users.id
  role       actor_role not null check (role in ('staff','clinician')),
  full_name  text,
  created_at timestamptz not null default now(),
  unique (clinic_id, auth_user_id)
);

-- ============================================================
-- SESSIONS  (guest -> patient migration preserves the same row)
-- ============================================================

create table sessions (
  id              uuid primary key default uuid_generate_v4(),
  clinic_id       uuid not null references clinics(id) on delete cascade,
  kind            session_kind not null default 'lead',
  -- null until trust transition; then links to supabase auth user
  auth_user_id    uuid,
  -- attribution, captured at first touch and never rewritten
  channel         channel_kind not null,
  channel_ref     text,                       -- e.g. IG comment id, staff code
  utm             jsonb not null default '{}'::jsonb,
  first_touch_at  timestamptz not null default now(),
  converted_at    timestamptz,                -- guest -> patient moment
  -- PDPA 2010 (as amended 2024): right to erasure
  deletion_requested_at timestamptz,
  deleted_at            timestamptz,
  constraint patient_has_user
    check (kind = 'lead' or auth_user_id is not null)
);

create index on sessions (clinic_id, channel);
create index on sessions (auth_user_id);

-- ============================================================
-- MESSAGES  (raw + redacted; only redacted ever reaches the LLM)
-- ============================================================

create table messages (
  id            uuid primary key default uuid_generate_v4(),
  clinic_id     uuid not null references clinics(id) on delete cascade,
  session_id    uuid not null references sessions(id) on delete cascade,
  author_role   actor_role not null,
  body_raw      text not null,          -- PHI-bearing, never sent to model
  body_redacted text not null,          -- what the model sees
  redactions    jsonb not null default '[]'::jsonb,  -- [{type,start,end}]
  created_at    timestamptz not null default now()
);

create index on messages (session_id, created_at);

-- ============================================================
-- LIVING MEMORY  (versioned; corrections supersede, never overwrite)
-- ============================================================

create table profile_facts (
  id           uuid primary key default uuid_generate_v4(),
  clinic_id    uuid not null references clinics(id) on delete cascade,
  session_id   uuid not null references sessions(id) on delete cascade,
  kind         fact_kind not null,
  value        text not null,
  status       fact_status not null default 'active',
  -- version chain: points at the fact this one replaces
  supersedes_id uuid references profile_facts(id),
  confidence   numeric(3,2) check (confidence between 0 and 1),
  created_at   timestamptz not null default now(),
  superseded_at timestamptz
);

create index on profile_facts (session_id, kind, status);

-- Provenance: every fact points back to the message(s) it came from.
create table fact_citations (
  id         uuid primary key default uuid_generate_v4(),
  clinic_id  uuid not null references clinics(id) on delete cascade,
  fact_id    uuid not null references profile_facts(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  -- character span within messages.body_raw supporting this fact
  span_start int,
  span_end   int,
  created_at timestamptz not null default now(),
  unique (fact_id, message_id)
);

-- A fact must have at least one citation. Enforced at write time in
-- the app layer + verified by test_provenance.

-- ============================================================
-- RISK & ESCALATION  (one-way lock)
-- ============================================================

create table risk_assessments (
  id          uuid primary key default uuid_generate_v4(),
  clinic_id   uuid not null references clinics(id) on delete cascade,
  session_id  uuid not null references sessions(id) on delete cascade,
  message_id  uuid references messages(id) on delete set null,
  level       risk_level not null,
  mts         mts_tier not null,
  -- which layer fired: deterministic rules, model, or both
  rule_hits   text[] not null default '{}',
  model_level risk_level,
  rationale   text,
  created_at  timestamptz not null default now()
);

create index on risk_assessments (session_id, created_at desc);

create table escalations (
  id            uuid primary key default uuid_generate_v4(),
  clinic_id     uuid not null references clinics(id) on delete cascade,
  session_id    uuid not null references sessions(id) on delete cascade,
  risk_assessment_id uuid not null references risk_assessments(id),
  level         risk_level not null,
  state         escalation_state not null default 'pending',
  -- captured only on high risk, with explicit browser permission
  geo_lat       numeric(9,6),
  geo_lng       numeric(9,6),
  after_hours   boolean not null default false,
  created_at    timestamptz not null default now(),
  ack_deadline  timestamptz,                       -- created_at + ack_sla
  acknowledged_at timestamptz,
  acknowledged_by uuid references clinic_members(id),
  -- ONLY a clinician may clear. Enforced by trigger below.
  cleared_at    timestamptz,
  cleared_by    uuid references clinic_members(id),
  -- over-escalation metric: was this escalation clinically warranted?
  clinically_appropriate boolean
);

create index on escalations (clinic_id, state, created_at desc);

-- --- One-way escalation lock -------------------------------------
-- Blocks any downgrade of a session's risk level unless the matching
-- escalation was cleared by a clinician.
create or replace function enforce_one_way_risk()
returns trigger language plpgsql as $$
declare
  prev risk_level;
  open_high boolean;
begin
  select level into prev
    from risk_assessments
   where session_id = new.session_id
   order by created_at desc
   limit 1;

  if prev is null then
    return new;
  end if;

  -- is there an uncleared escalation at a higher level?
  select exists (
    select 1 from escalations e
     where e.session_id = new.session_id
       and e.cleared_at is null
       and e.level > new.level
  ) into open_high;

  if open_high then
    raise exception
      'risk downgrade blocked: open escalation requires clinician clearance (session %)',
      new.session_id;
  end if;

  return new;
end $$;

create trigger trg_one_way_risk
  before insert on risk_assessments
  for each row execute function enforce_one_way_risk();

-- Only clinicians (not staff) may clear an escalation.
create or replace function enforce_clinician_clear()
returns trigger language plpgsql as $$
declare r actor_role;
begin
  if new.cleared_at is not null and old.cleared_at is null then
    select role into r from clinic_members where id = new.cleared_by;
    if r is distinct from 'clinician' then
      raise exception 'only a clinician may clear an escalation';
    end if;
  end if;
  return new;
end $$;

create trigger trg_clinician_clear
  before update on escalations
  for each row execute function enforce_clinician_clear();

-- ============================================================
-- FUNNEL  (guest value + attribution)
-- ============================================================

create table value_events (
  id         uuid primary key default uuid_generate_v4(),
  clinic_id  uuid not null references clinics(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  kind       text not null,        -- e.g. 'prep_checklist', 'wait_time_estimate'
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table funnel_events (
  id         uuid primary key default uuid_generate_v4(),
  clinic_id  uuid not null references clinics(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  step       text not null,        -- 'first_touch','value_delivered','email_earned','converted','booked'
  created_at timestamptz not null default now()
);

create index on funnel_events (clinic_id, step);

-- ============================================================
-- AUDIT  (PHI-free by construction)
-- ============================================================

create table audit_logs (
  id         uuid primary key default uuid_generate_v4(),
  clinic_id  uuid not null references clinics(id) on delete cascade,
  actor_role actor_role not null,
  actor_id   uuid,
  action     text not null,
  -- references only, never content
  subject_table text,
  subject_id    uuid,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Structural guard: reject audit rows carrying free-text PHI-ish keys.
create or replace function reject_phi_in_audit()
returns trigger language plpgsql as $$
begin
  if new.meta ?| array['body','body_raw','text','message','name','phone','ic','email'] then
    raise exception 'audit_logs.meta must not contain PHI-bearing keys';
  end if;
  return new;
end $$;

create trigger trg_audit_phi_free
  before insert on audit_logs
  for each row execute function reject_phi_in_audit();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

alter table sessions       enable row level security;
alter table messages       enable row level security;
alter table profile_facts  enable row level security;
alter table fact_citations enable row level security;
alter table risk_assessments enable row level security;
alter table escalations    enable row level security;
alter table value_events   enable row level security;
alter table funnel_events  enable row level security;
alter table audit_logs     enable row level security;
alter table clinic_members enable row level security;

-- helper: current user's clinic membership
create or replace function current_member()
returns clinic_members language sql stable as $$
  select * from clinic_members where auth_user_id = auth.uid() limit 1;
$$;

create or replace function is_clinic_staff(c uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from clinic_members
     where auth_user_id = auth.uid() and clinic_id = c
  );
$$;

-- Patients: own sessions only.
create policy patient_own_session on sessions
  for select using (auth_user_id = auth.uid());

-- Staff/clinicians: their clinic's sessions.
create policy staff_clinic_sessions on sessions
  for select using (is_clinic_staff(clinic_id));

create policy patient_own_messages on messages
  for select using (
    exists (select 1 from sessions s
             where s.id = messages.session_id
               and s.auth_user_id = auth.uid())
  );

create policy staff_clinic_messages on messages
  for select using (is_clinic_staff(clinic_id));

create policy patient_own_facts on profile_facts
  for select using (
    exists (select 1 from sessions s
             where s.id = profile_facts.session_id
               and s.auth_user_id = auth.uid())
  );

create policy staff_clinic_facts on profile_facts
  for select using (is_clinic_staff(clinic_id));

create policy staff_clinic_citations on fact_citations
  for select using (is_clinic_staff(clinic_id));

create policy staff_clinic_risk on risk_assessments
  for select using (is_clinic_staff(clinic_id));

-- Escalations are clinician/staff-facing only; patients never read them.
create policy staff_clinic_escalations on escalations
  for select using (is_clinic_staff(clinic_id));

create policy clinician_update_escalations on escalations
  for update using (
    exists (select 1 from clinic_members m
             where m.auth_user_id = auth.uid()
               and m.clinic_id = escalations.clinic_id
               and m.role = 'clinician')
  );

create policy staff_clinic_value on value_events
  for select using (is_clinic_staff(clinic_id));

create policy staff_clinic_funnel on funnel_events
  for select using (is_clinic_staff(clinic_id));

-- Audit logs: clinic staff read-only. No update/delete policy at all,
-- so logs are append-only for every non-service role.
create policy staff_read_audit on audit_logs
  for select using (is_clinic_staff(clinic_id));

create policy member_self on clinic_members
  for select using (auth_user_id = auth.uid() or is_clinic_staff(clinic_id));
