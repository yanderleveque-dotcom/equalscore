# Clave Studio v1 — Implementation plan

Status: **proposed, awaiting approval** (nothing in `src/` exists yet). Companion documents: `docs/SPEC.md` (the brief, verbatim; `§n` below refers to its sections) and `DECISIONS.md` (choices the brief does not specify; entries are marked *proposed* until this plan is approved).

How to read this: sections 1–8 are the design and the build order. **Section 9 is what needs your answer**: a short list of questions that change what gets built, a longer table of defaults I will apply unless you object, and the contradictions I found in the brief with the resolution I propose. Replying "approved, defaults are fine" plus answers to the numbered questions is enough to start milestone 1.

---

## 1. Guiding principles

1. **The database is the security boundary.** Every business table carries `school_id`; Row Level Security, composite foreign keys, unique and exclusion constraints, and triggers make the invariants true even if application code has a bug. Next.js is a typed client of that boundary.
2. **Two identities, one link.** `auth.users` + `profiles` + `memberships` say *who can log in and what they may access*. `people` says *who the school does business with* (students and guests), whether or not they ever log in. The only link is `people.user_id`, nullable.
3. **Money is integers, snapshotted, never rewritten.** Every charge stores what the engine computed, how it got there, and what applies after edits. Price changes reach future charges only (§6).
4. **Anything that computes a number or an explanation shown to a human is a pure TypeScript function** (pricing, proration, overuse, check-in window matching, charge previews), unit-tested exhaustively. Anything that must be atomic with a write (session generation, expected-attendee sync, idempotent inserts, the audit trail) is SQL. Nothing is implemented twice.
5. **Every scheduled job is idempotent by natural key plus a ledger row**, whoever calls it (Vercel Cron, pg_cron, an admin's "run now", a retry).
6. **Nothing is hardcoded that §3 and §16 say is a setting.** Enforced by tooling (lint rule for literal UI strings, seed data outside `src/`, tenant-isolation sweep over every table), not discipline.

## 2. Domain model overview

```
auth.users ─1:1─ profiles                 (global; name, phone, email cache, preferred_language)
    │
    │ 0..n
memberships (school_id, user_id, role owner|admin|student, status)      ← ACCESS: what RLS reads
    │
    │ 0..1 per school, via people.user_id (nullable, partial unique)
people (school_id, kind student|guest, status pending|active|inactive) ← BUSINESS IDENTITY
    ├── student_categories (enrollment history)      students only
    ├── price_overrides                              students only
    ├── session_attendees, check_ins                 any kind
    └── charges ── payments                          any kind

schools ──< locations ──< location_qr_tokens
        ──< categories ──< schedule_slots ──< class_sessions ──< session_attendees
        ──< combination_rules ──< combination_rule_categories
        ──< whatsapp_templates, invites, job_runs, activity_log
```

Why one `people` table for students and guests: attendance, check-ins and charges reference *a person*; guest → student conversion is a status change that keeps every row (§5 "keeping their history"); the alternative (two tables, nullable `student_id`/`guest_id` pairs on every referencing table) doubles every join and every policy.

Why business status lives on `people` and not on `memberships`: admin-created students are charged and expected in class before they ever accept an invite (§10), and guests never log in (§5). `memberships.status` mirrors `people.status` by trigger for students; owner/admin memberships are only `active`/`inactive`.

## 3. Data model

Conventions: Postgres 16 on Supabase. Every table has `id uuid primary key default gen_random_uuid()` (except `activity_log`, `bigint identity`), `created_at timestamptz default now()`; mutable tables also `updated_at` (trigger). Every business table has `school_id uuid not null references schools(id)` plus `unique (id, school_id)` when other tables reference it, so children use **composite foreign keys** `(child.x_id, child.school_id) → parent(id, school_id)`: a row can never point across tenants, whatever path wrote it. Money is `bigint` in the currency's smallest unit (CLP: pesos), `check (>= 0)`. Calendar concepts (`date`, `period`, `valid_from`) are `date` in the school's timezone; instants are `timestamptz`. Extensions: `pgcrypto`, `citext`, `btree_gist`, `pg_trgm`.

### 3.1 Enums

| Enum | Values |
|---|---|
| `membership_role` | `owner`, `admin`, `student` |
| `membership_status` | `pending`, `active`, `inactive` |
| `person_kind` | `student`, `guest` |
| `person_status` | `pending`, `active`, `inactive` |
| `session_kind` | `regular`, `extra` |
| `session_status` | `scheduled`, `cancelled`, `moved` |
| `extra_type` | `workshop`, `event`, `private`, `rehearsal`, `other` |
| `charge_mode` | `signed_up`, `attended`, `none` |
| `attendee_source` | `auto`, `manual`, `walk_in` |
| `attendee_status` | `expected`, `attended`, `absent`, `excused` |
| `checkin_source` | `qr`, `manual` |
| `checkin_status` | `valid`, `removed` |
| `charge_type` | `monthly`, `one_off` |
| `charge_source` | `monthly_run`, `mid_month`, `manual`, `category_batch`, `extra_session` |
| `charge_status` | `unpaid`, `partial`, `paid`, `void` |
| `payment_method` | `cash`, `transfer`, `other`, `online` |
| `job_status` | `running`, `completed`, `failed` |

Languages are `text check (in ('es','en'))` so adding a language is a data change, not an enum migration.

### 3.2 Tenant, users, access

**`schools`** — the tenant and its settings (§3, §13 Settings)

| Column | Type | Notes |
|---|---|---|
| `name` | text not null | |
| `slug` | citext not null unique | `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$`, reserved words excluded (`admin`, `api`, `join`, `invite`, `checkin`, `login`, `auth`, `me`, `legal`, `onboarding`); public join link `/join/{slug}` |
| `currency` | char(3) not null default `'CLP'` | locked by trigger once any charge or payment exists |
| `timezone` | text not null default `'America/Santiago'` | validated against `pg_timezone_names` |
| `payment_due_day` | smallint not null default 5 | `check between 1 and 28` |
| `default_language` | text not null default `'es'` | |
| `default_country` | char(2) not null default `'CL'` | for phone normalisation to E.164 |
| `checkin_window_before_min` | smallint not null default 30 | `check between 0 and 180` (§9 "make it a school setting") |
| `checkin_window_after_end_min` | smallint not null default 0 | `check between 0 and 120` |
| `join_enabled` | boolean not null default true | public self-registration on/off |
| `billing_start_period` | date not null | first-of-month; default = month after creation; the monthly run never bills earlier periods |
| `setup_dismissed_at`, `suspended_at`, `suspended_reason` | timestamptz / timestamptz / text | onboarding checklist dismissal; suspension switch for a non-paying school (no UI in v1, data preserved) |
| `created_by` | uuid → profiles | |

**`profiles`** — one row per `auth.users` row, created by trigger on sign-up (§5)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk → auth.users on delete cascade | |
| `full_name` | text | from Google `name` when available |
| `phone` | text | E.164 `check (phone ~ '^\+[1-9][0-9]{6,14}$')` |
| `email` | citext | cache of `auth.users.email`, maintained by trigger |
| `preferred_language` | text | null = never chosen |
| `avatar_url` | text | optional, from Google |

**`memberships`** — access grant (§4, §5)

| Column | Type | Notes |
|---|---|---|
| `school_id`, `user_id` | uuid | `unique (school_id, user_id)` |
| `role` | membership_role not null | |
| `status` | membership_status not null | for students, kept equal to `people.status` by trigger |
| `invited_by`, `accepted_at` | uuid / timestamptz | |

Constraints: `unique (school_id) where role = 'owner'` (exactly one owner); trigger `protect_owner` refuses any update or delete that would leave the owner row not active-owner (§4 "cannot remove the owner"). Rows are never deleted; `status = 'inactive'` instead.

**`invites`** — pending links for admins and students (§10, §13 Team)

| Column | Type | Notes |
|---|---|---|
| `role` | text `check in ('admin','student')` | |
| `email` | citext | required for admin invites (acceptance must match the login email) |
| `person_id` | uuid → people (composite) | required for student invites |
| `token_hash` | text not null unique | sha256 of a 24-byte random token; plaintext returned once |
| `expires_at` | timestamptz not null | admin 7 days, student 30 days |
| `created_by`, `accepted_at`, `accepted_by`, `revoked_at` | | |

Partial uniques: one open invite per `person_id`; one open invite per `(school_id, email, role)`.

### 3.3 People

**`people`** — students and guests, with or without a login (§5 guests, §10)

| Column | Type | Notes |
|---|---|---|
| `kind` | person_kind not null | |
| `status` | person_status not null default `'active'` | guests: `check (kind = 'student' or status in ('active','inactive'))` |
| `user_id` | uuid → auth.users on delete set null | partial `unique (school_id, user_id) where user_id is not null` |
| `full_name` | text not null | `check (length(btrim(full_name)) between 1 and 120)` |
| `phone` | text | E.164 check as in profiles; used for `wa.me` |
| `email` | citext | school's contact record, optional |
| `language` | text | null = school default; overridden by the linked user's own preference (trigger) |
| `activated_at`, `deactivated_at` | timestamptz | `activated_at` drives the mid-month suggestion (§7) |
| `merged_into_person_id` | uuid → people (composite) | set when a duplicate self-registration is merged into an existing record |
| `created_by` | uuid → profiles | |

Indexes: `(school_id, kind, status)`, `(school_id, email) where email is not null`, trigram on `full_name` for search and duplicate hints. Trigger `assert_student` on `student_categories`, `price_overrides`, `invites (role student)` refuses guests.

**`people_private`** — admin-only fields, separated so a student's own-row SELECT can never expose them: `person_id pk`, `school_id`, `admin_note text`, `updated_at`.

### 3.4 Catalogue

**`locations`** (§5, §13): `name text not null`, `address text`, `archived_at timestamptz`; `unique (school_id, name)`. Archiving ends every active slot at that location (after listing them).

**`location_qr_tokens`** (§9; rotation-ready): `location_id` (composite FK), `token text not null unique` (32 hex chars from `gen_random_bytes(16)`), `kind text default 'printed'` (a later rotating tablet QR is another row kind), `active boolean not null default true`, `created_by`, `revoked_at`; `unique (location_id) where active`. Satisfies §5 "a unique `qr_token`" while keeping tokens out of any table students can read.

**`categories`** (§5): `name text not null`, `location_id uuid null` (composite FK; reporting attribute, slots are the truth), `color text not null` (hex), `default_monthly_price bigint not null check (>= 0)`, `classes_per_week_included smallint null check (> 0)` (null = no limit), `active boolean not null default true`; `unique (school_id, lower(name)) where active`. Archiving a category that still has active enrollments is refused with the list of students (or "end all enrollments today"); archiving ends its active slots.

**`schedule_slots`** — the weekly pattern (§5, §9b, §13)

| Column | Type | Notes |
|---|---|---|
| `location_id`, `category_id` | uuid not null (composite FKs) | |
| `weekday` | smallint not null | ISO, `check between 1 and 7`, 1 = Monday; **immutable after creation** ("move to Thursday" = end this slot + duplicate) |
| `start_time`, `end_time` | time not null | `check (end_time > start_time)` (no classes past midnight in v1) |
| `valid_from` | date not null | first occurrence = first date ≥ `valid_from` on that weekday |
| `valid_until` | date | inclusive; `check (valid_until >= valid_from)` |
| `active` | boolean not null default true | pause/archive; untouched future sessions are removed, edited ones cancelled with reason `pattern_ended` |
| `duplicated_from_slot_id` | uuid | provenance of the duplicate action, display only |
| `created_by` | uuid | |

No exclusion constraint on overlaps: §9b allows them and wants a warning, which is a query (`find_slot_overlaps`).

### 3.5 Sessions and attendance

**`class_sessions`** — one dated class (§5, §9b)

| Column | Type | Notes |
|---|---|---|
| `kind` | session_kind not null | |
| `slot_id`, `slot_date` | uuid (composite FK) / date | the pattern occurrence this row stands for; **immutable**; `unique (slot_id, slot_date) where slot_id is not null` is the idempotency key of generation; `check ((slot_id is null) = (slot_date is null))` |
| `category_id` | uuid (composite FK) | `check (kind = 'extra' or category_id is not null)`; optional on extras (colour/filter only) |
| `location_id`, `address_text` | uuid (composite FK) / text | `check (location_id is not null or address_text is not null)`; QR check-in only matches sessions with a location |
| `date`, `start_time`, `end_time` | date / time / time | wall-clock, what the teacher edits; `check (end_time > start_time)` |
| `starts_at`, `ends_at` | timestamptz not null | **derived by trigger** from date + time + school timezone; used for "happening now" and "already held" |
| `status` | session_status not null default `'scheduled'` | |
| `cancel_reason`, `cancelled_at`, `cancelled_by` | text / timestamptz / uuid | `check ((status = 'cancelled') = (cancelled_at is not null))` |
| `override_time`, `override_location` | boolean not null default false | set by `move_session`; a slot edit skips overridden fields |
| `moved_from` | jsonb | `{date, start_time, end_time, location_id}` before the first move, for "moved from Fri 19:00" labels |
| `extra_type`, `title` | extra_type / text | `check (kind = 'regular' or (extra_type is not null and title is not null))`; regular sessions display the category name |
| `note` | text | visible to expected students |
| `price` | bigint | `check (price is null or price >= 0)` |
| `charge_mode` | charge_mode not null default `'none'` | |
| `counts_toward_limit` | boolean not null | filled by trigger when omitted: `kind = 'regular'` (§5) |
| `reviewed_at`, `reviewed_by` | timestamptz / uuid | |
| `created_by` | uuid | null = generated |

Three kinds of session, one table: generated from a pattern (`regular`, `slot_id` set), **single dated class** (§9b; `regular`, `slot_id` null, category set: auto expected list, counts by default) and extra (`extra`, teacher-composed list, counts off by default).

Indexes: `(school_id, date)`, `(location_id, starts_at) where status <> 'cancelled'`, partial `(school_id, ends_at) where reviewed_at is null and status <> 'cancelled'` (to-do), gist `(location_id, tstzrange(starts_at, ends_at)) where status <> 'cancelled'` (overlap warnings).

**`session_expected_categories`** — category links of an extra's expected list (§9b "whole categories"; also usable on a regular session to invite a second category): `session_id`, `category_id`, `school_id`, `added_by`; pk `(session_id, category_id)`. Live until the session starts (a new team member is expected automatically); each auto row shows "via Comp Team A".

**`session_attendees`** — the list and the teacher's verdict (§5, §9b)

| Column | Type | Notes |
|---|---|---|
| `session_id`, `person_id` | uuid (composite FKs) | `unique (session_id, person_id)` |
| `source` | attendee_source not null | `auto` from a category link, `manual` added by an admin, `walk_in` created by a check-in of someone not on the list |
| `via_category_id` | uuid | which link produced an auto row |
| `status` | attendee_status not null default `'expected'` | written only by review RPCs |
| `removed_at`, `removed_by` | timestamptz / uuid | **tombstone**: taken off the list; the row stays so the sync cannot re-add the person |
| `checked_in_at`, `attendance_source` | timestamptz / checkin_source | **caches** of the valid `check_ins` row, maintained by trigger only |
| `charge_id` | uuid → charges (composite, on delete set null) | replaces the brief's `charged` flag: says *which* charge, survives voids, drives the preview |
| `added_by` | uuid | |

**`check_ins`** — the immutable door log (§5, §9)

| Column | Type | Notes |
|---|---|---|
| `session_id`, `person_id` | uuid (composite FKs, on delete restrict) | |
| `checked_in_at` | timestamptz not null default now() | |
| `source` | checkin_source not null | |
| `qr_token_id` | uuid → location_qr_tokens | `check (source <> 'qr' or qr_token_id is not null)` |
| `created_by` | uuid → profiles | the student (qr) or the admin (manual) |
| `status` | checkin_status not null default `'valid'` | |
| `removed_at`, `removed_by`, `removed_reason` | | `check ((status = 'removed') = (removed_at is not null))` |

`unique (session_id, person_id) where status = 'valid'` (§9 "no duplicate check in"); trigger refuses deletes and any update other than `valid → removed` with its reason. A wrong check-in is an audit row, never a missing one.

### 3.6 Enrollment and pricing

**`student_categories`** (§5): `person_id`, `category_id` (composite FKs), `start_date date not null`, `end_date date null`, `created_by`; `exclude using gist (person_id with =, category_id with =, daterange(start_date, end_date, '[]') with &&)` (no overlapping enrollment in the same category; history kept).

**`combination_rules`** (§5, §6): `name text not null`, `monthly_price bigint not null check (>= 0)`, `active boolean not null default true`, `categories_key text not null` (sorted member ids joined, maintained by trigger); `unique (school_id, categories_key) where active` (no two active rules with the same set). A deferred constraint trigger requires ≥ 2 members at commit.

**`combination_rule_categories`**: `rule_id`, `category_id`, `school_id`; pk `(rule_id, category_id)`; composite FKs (rule on delete cascade, category on delete restrict).

**`price_overrides`** (§5, §6): `person_id` (composite FK), `monthly_price bigint not null check (>= 0)` (0 = scholarship), `reason text not null`, `valid_from date not null`, `valid_until date null`, `created_by`; `exclude using gist (person_id with =, daterange(valid_from, valid_until, '[]') with &&)` (at most one override at any date, so step 1 of §6 is deterministic).

### 3.7 Money

**`charges`** (§5, §7, §8, §9b)

| Column | Type | Notes |
|---|---|---|
| `person_id` | uuid (composite FK, on delete restrict) | students and guests |
| `type` | charge_type not null | |
| `source` | charge_source not null | `check (type = 'one_off' or source in ('monthly_run','mid_month'))` |
| `period` | date not null | first day of the month this charge counts toward, **for all charges** (§9b "lands on that student's monthly total"); `check (period = date_trunc('month', period))`; displayed as `YYYY-MM` |
| `session_id` | uuid (composite FK) | extra-session charges; `check (source <> 'extra_session' or session_id is not null)` |
| `batch_id` | uuid → charge_batches | category-wide one-offs |
| `default_amount` | bigint not null | what the engine computed; **immutable** |
| `amount_due` | bigint not null | what applies after edits |
| `paid_total` | bigint not null default 0 | recomputed from scratch by trigger from non-voided payments |
| `status` | charge_status **generated always as** (`void` if `voided_at`, `paid` if `paid_total >= amount_due`, `partial` if `paid_total > 0`, else `unpaid`) stored | one truth for dashboard, portal, reminder and filters; indexable |
| `pricing_snapshot` | jsonb | engine input + result (basis, rule/category ids and labels, engine version); **immutable**; powers "how the amount was reached" and "what the default would have been" (§6) |
| `breakdown` | jsonb | `[{category_id, location_id, amount}]` allocation of `default_amount` for the income split (§12.4), largest-remainder rounding; immutable |
| `proration` | jsonb | `{days_in_month, days_charged, full_amount, prorated_amount, choice}` for mid-month charges |
| `due_date` | date not null | snapshotted from `payment_due_day` at creation (setting changes affect future charges only) |
| `description` | text | free text for one-offs; monthly charges render from `period` in the reader's locale |
| `created_by` | uuid | null = system |
| `voided_at`, `voided_by`, `void_reason` | | charges are never deleted |

Partial unique indexes (the idempotency backbone): `(person_id, period) where type = 'monthly' and voided_at is null`; `(session_id, person_id) where session_id is not null and voided_at is null`; `(batch_id, person_id) where batch_id is not null and voided_at is null`. Trigger `charges_guard`: immutable columns listed above; `amount_due >= paid_total` (a charge is never overpaid); void refused while `paid_total > 0`; edits to `amount_due`/`due_date` require a reason (passed through `app.reason`, landing in the activity log).

**`charge_batches`** (§8): `description text not null`, `amount bigint not null`, `due_date date not null`, `period date not null`, `target jsonb not null` (`{category_ids:[...]}` or `{person_ids:[...]}`), `category_id uuid null` (income attribution when a single category is targeted), `created_by`. Recipients are resolved once at creation (active students with an enrollment active today in any target category, deduplicated); "add person to batch" covers late joiners.

**`payments`** (§5)

| Column | Type | Notes |
|---|---|---|
| `charge_id`, `person_id` | uuid | composite FK `(charge_id, person_id, school_id) → charges (id, person_id, school_id)`: a payment can never sit on someone else's charge |
| `amount` | bigint not null `check (> 0)` | immutable; mistakes are voided and re-recorded |
| `method` | payment_method not null | `online` reserved for the future provider |
| `paid_at` | timestamptz not null default now() | backdating allowed |
| `recorded_by` | uuid not null → profiles | |
| `note` | text | |
| `provider`, `provider_ref` | text | nullable; `unique (provider, provider_ref) where provider is not null` (§5 future Mercado Pago / Flow) |
| `client_key` | uuid not null | idempotency key from the form; `unique (school_id, client_key)` makes a retried submit on a flaky connection a no-op |
| `voided_at`, `voided_by`, `void_reason` | | |

One payment is linked to exactly one charge, as the brief says. A single transfer covering two charges is recorded as two payment rows from one form (same `paid_at`, method and note). Overpayment is refused (`payment_exceeds_open_amount`); credit balances are not a v1 feature (question Q4 in §9).

**`whatsapp_templates`** (§15): `key text` (`payment_reminder`, `student_invite`, `session_cancelled`, `session_changed`, `session_reminder`, `extra_charge`), `language text`, `body text`, `updated_by`; `unique (school_id, key, language)`. Seeded in both languages at school creation; placeholders validated at save time.

### 3.8 Operations

**`activity_log`** (§11) — append-only, written by one trigger on every business table

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | |
| `school_id` | uuid not null | |
| `actor_kind` | text `check in ('admin','student','system')` | |
| `actor_user_id`, `actor_name` | uuid / text | name snapshotted (survives account deletion) |
| `actor_label` | text | system jobs: `cron:monthly_charges`, `cron:materialize_sessions`, `trigger:attendee_sync` |
| `event` | text not null | semantic key set by RPCs (`payment.recorded`, `checkin.removed`, `person.approved`), default `<table>.<op>` |
| `action` | text `check in ('insert','update','delete')` | |
| `entity_type`, `entity_id` | text / uuid | |
| `subject_person_id` | uuid → people on delete set null | §11 "filter by student" |
| `before`, `after`, `changed_keys` | jsonb / jsonb / text[] | redacted (`token_hash`, `updated_at`) |
| `reason` | text | from `app.reason` (charge edits, voids, check-in removals) |
| `txid` | bigint | groups rows written by one action (bulk charges, review confirm) |

Indexes: `(school_id, created_at desc)`, `(school_id, subject_person_id, created_at desc)`, `(school_id, actor_user_id, created_at desc)`, `(school_id, entity_type, entity_id)`. Human-readable lines are rendered by the app from `event + after + subject` in the reader's language; the sentence is not stored.

**`job_runs`** — idempotency ledger for every scheduled job: `job text`, `school_id`, `period_key text` (`2026-09` for the monthly run, the local date for materialisation), `status job_status`, `started_at`, `finished_at`, `summary jsonb`, `error text`; partial `unique (job, school_id, period_key) where status <> 'failed'` is the claim; a `running` row older than 15 minutes is treated as crashed and reclaimed.

**Schema `private`** (not exposed through the API): RLS helper functions, trigger functions, `rate_limits (key, window_start, count)`, `school_creation_allowlist (email citext pk)`.

**Views** (all `with (security_invoker = true)`, so the caller's RLS applies): `v_agenda_sessions` (session + category/location names + expected/checked-in/attended counts), `v_unreviewed_sessions`, `v_counted_attendances` (the attendance predicates, single definition), `v_person_month_status` (worst charge status and open amount per person and period), `v_people_needing_monthly_charge` (active this month, enrolled today, no live monthly charge).

## 4. Access model (RLS, grants, RPCs)

### 4.1 Helpers

All in `private`, `language sql stable security definer set search_path = ''`, owned by `postgres`, `execute` granted to `authenticated` only. They take no row arguments, so `school_id in (select private.admin_school_ids())` plans as a one-time InitPlan per statement, and because they bypass RLS on `memberships` there is no policy recursion (no `force row level security` on `memberships` or `people`).

```sql
private.admin_school_ids()   -- schools where I am owner/admin with an active membership
private.member_school_ids()  -- schools where I have any active membership
private.my_person_ids()      -- my people rows in schools where my membership is active
private.is_owner_of(school)  -- owner check for the Team page
```

Every business table has an index whose leading column is `school_id`.

### 4.2 Policy matrix

`anon` has no table policies at all; its only entry points are three public RPCs. Permissive policies OR together, so each table has at most one admin policy and one student policy.

| Table | Owner / admin (active membership) | Student (active membership) |
|---|---|---|
| `schools` | select; update settings columns | select own school |
| `profiles` | select own + profiles of members of my schools; update own | select/update own |
| `memberships` | select school rows; writes via RPC only | select own rows (any status) |
| `invites` | select school rows (hash never selected by the app); writes via RPC | none |
| `people` | select/insert/update school rows (state-machine columns via RPC); no delete | select own row |
| `people_private` | all | none |
| `locations` | all (archive, not delete) | select school rows |
| `location_qr_tokens` | select; writes via RPC | none (lookup by RPC) |
| `categories` | all | select school rows (names, colours, limits, default prices) |
| `schedule_slots`, `combination_rules(+_categories)`, `whatsapp_templates`, `charge_batches` | all | none |
| `class_sessions` | all except delete (cancel instead); side-effect columns via RPC | select sessions where I have a live attendee row |
| `session_expected_categories` | all | none |
| `session_attendees` | select; status/removal via RPC | select own rows |
| `check_ins` | select; insert/remove via RPC | select own rows |
| `student_categories` | all | select own rows |
| `price_overrides` | all | none (the student sees the outcome in the charge snapshot) |
| `charges` | select; insert via RPC; update `amount_due`, `due_date`, `description` (column grants) | select own rows |
| `payments` | select; insert/void via RPC | select own rows |
| `activity_log`, `job_runs` | select school rows | none |

Grants: `authenticated` keeps table-level `select` everywhere (row scope by RLS; column-level select revokes are never used because they break `select *`). Writes are narrowed with column-level `revoke insert/update` for state-machine columns (`people.status/user_id/kind/activated_at`, `charges.default_amount/pricing_snapshot/period/…`, `class_sessions.slot_id/slot_date/starts_at/ends_at/reviewed_*`, `session_attendees.status/removed_*/checked_in_at/charge_id`) and `revoke insert, update, delete` entirely on `memberships`, `invites`, `check_ins`, `payments`, `activity_log`, `job_runs`, `location_qr_tokens`. `school_id` is immutable everywhere (revoke + `forbid_school_change` trigger, because grants do not apply inside security-definer functions).

Hardening on every security-definer function: `set search_path = ''` with qualified names, `revoke execute from public, anon` right after creation (Postgres grants execute to public by default), an `auth.uid() is not null` check, and school membership re-derived server-side (ids are never trusted from the client; `checkin` recomputes its candidate set, `record_payment` derives the school from the charge).

### 4.3 RPCs (security definer, in `public`)

| Audience | Functions |
|---|---|
| `anon` + `authenticated` | `get_school_public(slug)` → name, language, join_enabled; `get_invite_public(token)` → school name, role, state; `get_checkin_public(token)` → school name, slug, join_enabled |
| `authenticated` | `join_school(slug, full_name, phone, language)`, `accept_invite(token)`, `checkin(token, session_id?)`, `update_my_contact(full_name, phone)`, `can_create_school()`, `create_school(...)` (allowlisted email) |
| admins | people: `create_invite`, `revoke_invite`, `approve_student(person, categories[], override?)`, `approve_as_existing(pending, existing)`, `reject_registration`, `deactivate_person`, `reactivate_person`, `unlink_person_user`, `convert_guest_to_student`, `find_possible_duplicates`, `set_membership_status`; agenda: `duplicate_slot`, `end_slot`, `find_slot_overlaps`, `find_session_overlaps`, `create_single_session`, `create_extra_session`, `duplicate_session`, `cancel_session`, `uncancel_session`, `move_session`, `revert_session_to_pattern`, `delete_session` (pristine only), `add_attendee`, `add_guest_attendee`, `remove_attendee`, `add_expected_category`, `remove_expected_category`; door and review: `admin_checkin`, `remove_checkin`, `set_attendee_status`, `mark_checked_in_attended`, `mark_session_reviewed`, `unmark_session_reviewed`; money: `create_first_month_charge`, `update_charge`, `void_charge`, `unvoid_charge`, `create_one_off_charges`, `confirm_session_charges`, `record_payment`, `void_payment`; locations: `rotate_location_qr`; jobs (admin of the school **or** service role): `materialize_sessions`, `insert_monthly_charges` |
| service role only | `materialize_sessions_all()`, `cleanup_rate_limits()` |

Single-row edits of admin-owned reference data (a category's price, a slot's time, a session note) are plain updates under RLS and column grants; the activity trigger logs them like everything else. Multi-row or state-machine writes are RPCs so they are atomic and carry `app.event` / `app.reason` for the log.

### 4.4 Application-side boundaries

- Server components and server actions always use the **user's session** (cookie → anon key → RLS). Every server action is declared through one `defineAction({access, schema, handler, revalidate})` wrapper (role check for the slug, zod parse, Postgres error key → i18n key, `revalidatePath`); a lint rule fails on a bare exported action.
- The **service-role key** is read by exactly one file (`src/lib/supabase/service.ts`, `server-only`), importable only from `src/app/api/cron/**`, `src/server/jobs/**` and `scripts/**` (lint rule); CI greps the build output for it. The activity trigger **raises** on a write with no `auth.uid()` and no `app.actor_label`, so an accidental service-role write in a request path fails instead of being logged as "system".
- Every app URL is scoped by school slug: `/{slug}/...` for admins, `/{slug}/me/...` for students. The `[slug]` layout resolves membership once per request and returns 404 (not 403) to non-members. This honours §4 "several schools" now: two schools can be open in two tabs with no server-side "current school".
- Public URLs never carry a locale or a school id: `/checkin/{token}` (printed), `/join/{slug}` (flyers), `/invite/{token}` (WhatsApp).

## 5. Key mechanisms

### 5.1 Pricing engine (§6)

`priceStudent(input): PricingResult` in `src/lib/domain/pricing/engine.ts`, pure, no I/O.

Input: `asOf` (local date), the student's enrollments active on `asOf` in **active** categories (with default prices and limits), all active rules of the school, and the override whose validity contains `asOf` (at most one, by constraint).

1. **Override** active on `asOf` → `amount = override.monthly_price`, `basis = override`; the result also carries `withoutOverride` (steps 2–3) so the UI can say "Override: family discount — would have been $60.000".
2. **Best cover of rules.** A rule is *applicable* iff it is active, has ≥ 2 categories, and all of them are in the student's active set `A`. A *cover* is a set of applicable, pairwise-disjoint rules (the empty set included). Score: maximise the number of categories covered, then minimise the total (`Σ rule prices + Σ default prices of uncovered categories`), then fewest rules, then lexicographic rule ids (determinism). Exhaustive depth-first search over applicable rules sorted by size/price/id with disjointness pruning; a guard raises above 24 applicable rules. Uncovered categories add their default price (§6).
3. **Sum of defaults** of active categories; `basis = none` with amount 0 when there are none.

Output: `amount`, `defaultAmount` (steps 2–3 result, equal when no override), `basis` (`override | rules | sum | none`) with the applied rule/category ids and prices, `sumOfDefaults`, `engineVersion`. Explanation strings are rendered by the UI from ids through next-intl, using current names for a live price and the snapshot's labels for a historical charge.

Edge cases pinned by tests: a rule pricier than its categories separately still wins by coverage (§6 literal order; the rules screen warns at save time); two disjoint small rules beat one big cheaper rule if they cover more; rules sharing a category are mutually exclusive; archived categories never price and never enable a rule; zero-price categories count as covered; a student with no categories but an override; overlapping-rule ties resolved deterministically; property test: the chosen cover is always disjoint and applicable, and with discount-only rules the amount never exceeds the sum of defaults.

`previewRuleImpact(draft)` runs the engine for every active student with and without the draft rule and lists those whose amount or basis changes (§13 "preview which students it affects").

### 5.2 Monthly charges (§7)

- **When.** An hourly tick (`/api/cron/tick`, see 5.15) looks at each school's *local* date. If `period = date_trunc('month', local_date) >= billing_start_period` and no completed `job_runs` row exists for `(monthly_charges, school, period)`, it claims the run (partial unique index; a stale `running` row is reclaimed after 15 minutes). The condition is "no completed run for this period", not "today is the 1st", so an outage on the 1st self-heals on the next tick; DST never matters. Settings has "Generate charges for {month} now" (same code, admin-authenticated), harmless to press twice.
- **Who.** Active students with at least one active category **or** an override on the 1st. Active students with nothing to charge are skipped and listed on the dashboard ("active, no categories"). Anyone who already has *any* monthly charge for the period (live or voided) is skipped.
- **How.** TypeScript computes each amount with the engine **as of the 1st of the period** (enrollments and override active that day, prices as of the run), builds `pricing_snapshot`, `breakdown` and `due_date = period + payment_due_day - 1`, and calls `insert_monthly_charges(school, period, rows)` which inserts in one transaction with `on conflict do nothing` on the monthly unique index, records the ledger row and a system actor for the log. Batches of 50 students; resumable by construction.
- **Mid-month join (§7).** Trigger condition: *active this month, an enrollment active today, no live monthly charge for this period* (view `v_people_needing_monthly_charge`), which covers approvals, admin-created students, reactivations, enrollments starting today and a charge voided by mistake. The approval/activation flow ends with a prompt: full amount as of the join date, proportional suggestion (`prorate`), custom amount, or none. "None" creates a $0 charge with the reason, so the person leaves the to-do list and the decision is visible. Proration: calendar days including the join day, `floor((2·full·days + D) / (2·D))` (half-up, integers only), stored in `proration`.
- **Changes during the month.** Never rewrite the existing charge. The student page shows "September was calculated with X; today's price would be Y" with one-tap "use new amount" (a logged edit with reason) or keep. Deactivation mid-month leaves the charge; the dialog offers keep / prorate / void (void only if unpaid).
- **Edits.** `update_charge(charge, amount_due?, due_date?, description?, reason)` requires a reason and an `expected_updated_at` (optimistic concurrency). `default_amount` and the snapshot never change, so "what the system calculated" is always visible next to the edits. Voiding frees the unique slot (a mistaken void can be recreated); to gift a month, set the amount to 0 instead.

### 5.3 One-off charges (§8)

`create_one_off_charges({target, amount, due_date, period?, description})`: target = one person or one or more categories. Recipients for categories: active students with an enrollment active today in any of them, deduplicated. The screen previews names, count and total before writing; the write is one transaction, per-row `on conflict do nothing` on `(batch_id, person_id)`. `period` defaults to the month of `due_date`.

### 5.4 Extra-session charging (§9b)

`previewSessionCharges(session, attendees, existingCharges)` (pure TS) returns one row per attendee with `willCharge`, `reason`, `amount`:
- `price is null or charge_mode = 'none'` → nothing (button disabled).
- `charge_mode = 'attended'` → `status = 'attended'`.
- `charge_mode = 'signed_up'` → status in (`expected`, `attended`, `absent`); `excused` is the teacher's explicit waiver.
- Anyone whose `charge_id` points to a live charge → skipped, "already charged" (§9b never double charge; the partial unique index is the guarantee).
- Guests are rows like any other. The admin can uncheck a row or edit its amount before confirming.

`confirm_session_charges(session, rows, mark_reviewed)` inserts `one_off` / `extra_session` charges with `period = month of the session`, `due_date = session date`, sets `session_attendees.charge_id`, and optionally marks the session reviewed, in one transaction. Re-running charges only people added since. Changing the price afterwards never touches existing charges; marking someone absent after charging shows "charged but absent — void?".

### 5.5 Payments and status (§5)

`record_payment(charge, amount, method, paid_at, note, client_key)`: amount ≤ open amount (`amount_due - paid_total`) or `payment_exceeds_open_amount`; `recorded_by = auth.uid()`; retry-safe through `client_key`. The Payments screen lists the person's open charges oldest due first and lets the admin split one transfer across them (one row each). `void_payment(payment, reason)`; amounts are immutable, method/date/note editable. `paid_total` is recomputed from scratch by trigger on every payment insert/void; `status` is a stored generated column: `void` / `paid` (`paid_total >= amount_due`, so a $0 charge is paid) / `partial` / `unpaid`. A CI check re-derives every `paid_total` and fails on drift.

Person-level status for a month (§12.2, §13 filter, §14, the §9 reminder): `v_person_month_status` = worst status over live charges of that period (`unpaid > partial > paid`), open amount, earliest due date → days overdue.

### 5.6 Session generation and edits (§5, §9b)

- **Time model.** Slots and sessions store wall-clock (`weekday`/`date`, `start_time`, `end_time`); `starts_at`/`ends_at` are derived per date by trigger through the school timezone, so a 19:00 class stays 19:00 across Chile's DST changes (pinned by tests on the 2026 transition dates). A timezone change recomputes future sessions only. Every date/time shown is formatted in the school timezone, never the device's.
- **`materialize_sessions(school, until?, slot?, from?)`** (SQL, idempotent): for each active slot of an active category, generate occurrences from `greatest(today, valid_from)` to `least(valid_until, horizon)` and insert `on conflict (slot_id, slot_date) do nothing`. Horizon 12 weeks (brief: at least 8), extended on demand up to 52 when the agenda is opened further ahead. Called hourly by the tick (per-school ledger row per local day, advisory lock per school), immediately by a trigger on slot insert/update, and with `from = valid_from` when the teacher ticks "also create sessions since {valid_from}" (backfill).
- **Pattern edits apply to future sessions only.** Future = `starts_at > now()`. Trigger `sync_slot_sessions` on slot update: time/location changes propagate to future occurrences whose `override_time`/`override_location` is false; category change propagates and recomputes expected lists; validity shrink or `active = false` hard-deletes *pristine* future occurrences (generated, untouched) and cancels the rest with reason `pattern_ended`; validity extension fills gaps. `weekday` is immutable (move = end + duplicate). Deleting a slot is refused once any occurrence has been held or touched (`end_slot` instead).
- **Per-session edits** (`cancel_session` with reason, `move_session` to another time/location/date for that date only, note) set the override flags and `moved_from`; `slot_date` never changes, so regeneration cannot recreate the original occurrence or duplicate the moved one. `cancelled` wins as status; overrides survive underneath so `uncancel_session` restores `moved`.
- **Overlap warning** (§9b): `find_slot_overlaps` / `find_session_overlaps` (same location, half-open time ranges, overlapping validity); the form asks "save anyway?". Different locations never warn.
- **Duplicate** (§9b): `duplicate_slot(slot, weekday, start, end?, location?, category?)` and `duplicate_session(session, date, start)`; "duplicate a whole day" loops the former.

### 5.7 Expected attendees (§9b)

Materialised rows in `session_attendees`, kept right by **one idempotent function** `recompute_expected(session_ids[])`: for each *future* session, the set that *should* be expected = active students with an enrollment valid on the session's date in any of the session's expected categories (a regular session's own category ∪ `session_expected_categories`). Insert missing rows as `auto` (`on conflict do nothing`, so manual rows, walk-ins and tombstones win); delete `auto` rows that are still untouched (`expected`, no check-in, no charge, not removed) and no longer in the set. Held sessions are frozen history, edited only by review.

Triggers call it on: session insert (statement-level), session category/date change, expected-category link changes, enrollment insert/update/delete (both old and new category), person status change, category archive. The daily tick recomputes all future sessions of each school as a safety net.

Manual control: `add_attendee` (upsert; clears a tombstone), `add_guest_attendee(name, phone)` (creates the guest and the row), `remove_attendee` (tombstone; refused while the person has a valid check-in or a live charge for that session; the tombstone survives enrollment churn), category links on extras are live until start ("via Comp Team A" shown per row).

### 5.8 QR check-in (§9)

`/checkin/[token]` requires a session; middleware redirects to `/login?next=/checkin/{token}` and the magic-link and Google callbacks carry `next` through (validated by `safeNext`: same-origin path only). Signed in, the page calls **one** RPC, `checkin(token, session_id?)`:

1. Token → active `location_qr_tokens` row → school and location (`invalid_token` otherwise).
2. The caller must have an active student `people` row in that school (`not_member`, `pending`, `inactive` results render friendly messages).
3. Candidates = sessions at that location, `status <> 'cancelled'`, `now()` within `[starts_at − window_before, ends_at + window_after]` (school settings), and for **extras** only if the caller has a live attendee row (§9 "for students who are on the expected list"). Regular sessions accept any active student; enrollment is a flag, not a gate.
4. One candidate → insert `check_ins` (`qr`, `qr_token_id`, `created_by`) `on conflict do nothing` on the valid-per-session index; a conflict returns `already_checked_in` with the original time. Several → `choose` list (enrolled class first, "in progress" vs "starts in N min"); the second call re-derives candidates instead of trusting the client. None → `no_session` with the next session at that location.
5. The response includes `unpaid_period` (current local month's status) so the confirmation shows the reminder; nothing blocks an unpaid student.

A trigger on `check_ins` keeps `session_attendees` consistent: ensures a row exists (`auto` if enrolled on that date, else `walk_in`; a tombstoned row is revived as `walk_in`) and refreshes the `checked_in_at`/`attendance_source` caches from the valid row. A check-in never sets `attended` by itself.

Admin corrections: `admin_checkin(session, person)` (no window; guests included), `remove_checkin(check_in, reason)` (`valid → removed`; a walk-in row with no remaining check-in is tombstoned, an `attended` row becomes `absent`). The session screen polls every 10 s while open (Realtime is a contained upgrade later).

Speed: middleware + one RPC + a static confirmation; the 5-second target (§19) is measured on a warm session in the E2E suite. A first-ever scan includes the email round trip and cannot meet it; sessions never expire, so that happens once per phone.

### 5.9 Post-class review (§9b)

One session screen with two modes: **live** until `ends_at` (expected list with check-in badges, manual check-in, remove, add person, WhatsApp, cancel/move/note) and **review** from the start time (three-way control per row, walk-ins marked "checked in, not expected", "via {category}" on auto rows, add person or new guest as attended, remove wrong check-in, charge preview). RPCs: `set_attendee_status`, `mark_checked_in_attended(session)` (the one tap), `mark_session_reviewed(session)` (check-ins → `attended`, remaining `expected` → `absent`, `excused` is always explicit; idempotent; `confirm_session_charges` calls it in the same transaction), `unmark_session_reviewed`. Everything stays editable afterwards and every change is a logged RPC. The dashboard to-do lists unreviewed past sessions (last 30 days expanded, older collapsed behind a count) with inline "nobody came" and "mark checked-in attended + reviewed".

### 5.10 Overuse and unenrolled flags (§9)

Single definition of the predicates in `v_counted_attendances`; aggregation and rules in pure TS `computeWeeklyFlags` (unit-tested reference, §19).

- **Attendance** = live attendee row at a non-cancelled session with `status = 'attended'`, or `status = 'expected'` with a valid check-in (unreviewed sessions count; a review verdict of absent/excused wins over a lingering check-in).
- **Counts toward the allowance** when `counts_toward_limit` **and** (the session has no category **or** its category has a limit). This resolves the brief's silent conflict: a competition-team rehearsal generated from the pattern has `counts_toward_limit = true` but its category is unlimited, so it must not eat the two weekly classes the student pays for.
- **Week** = Monday–Sunday of the session's local `date` (never the check-in instant).
- **Allowance** = sum of `classes_per_week_included` over limited categories whose enrollment overlaps the week; **undefined** when there are none.
- **Overuse** = allowance defined and counted attendances > allowance. Attendances in limited categories the student is not enrolled in **do** count (a "Friday 2x" student who slips into Partnerwork has used a third class, exactly §1's case).
- **Unenrolled** = per attendance at a regular session whose category the person is not enrolled in on that date, excluding `manual` adds (the teacher's decision) but including walk-ins and auto rows whose enrollment ended. Extras never raise it.
- Both flags carry their evidence ("3 of 2: Fri 19:00, Sat 11:00, Tue 20:00 Partnerwork — not enrolled"). Nothing is persisted, so flipping a session's toggle or editing a review is reflected immediately. Dashboard = current week; student detail = last 12 weeks.

### 5.11 Activity log (§11)

One security-definer trigger function `log_activity()` installed `after insert or update or delete for each row` on every business table (a CI check asserts no table is missing it). It resolves the actor (`auth.uid()` → membership role → `admin`/`student`, name snapshotted; no uid → requires `app.actor_label` or raises), the school (`school_id` of the row), the subject person (table-specific column), the event key (`app.event` set by RPCs, else `<table>.<op>`), the reason (`app.reason`), redacts secrets, skips no-op updates. Noise control: derived inserts/deletes of pristine rows during `materialize`, `slot_sync` and `attendee_sync` (`app.system_op`) are not logged; every human action and every sync-caused cancellation is. Student actions are logged with `actor_kind = 'student'`; the screen defaults to admins.

### 5.12 Income split (§12.4)

`charges.breakdown` allocates `default_amount` to `(category_id, location_id)` at creation: defaults → one entry per category at its price; rules → the rule price split across its categories proportionally to their default prices (equal split if all zero) with largest-remainder rounding; override → the without-override breakdown rescaled; one-offs → the batch's attribution category or "one-off"; extra sessions → the session's category/location or "extras". The dashboard scales each charge's entries to `amount_due` (expected) and `paid_total` (received) in TS and groups by location and category, with "no location" / "one-off" / "extras" buckets. A second line "cash received this month" sums payments by `paid_at`.

### 5.13 Onboarding (§10)

- **Admin creates** a student (name, phone with the school's default country, optional email, categories, language): `status = 'active'` immediately (chargeable and expected whether or not they ever log in). "Invitar" → `create_invite` returns the link once; copy or WhatsApp (`student_invite` template). `/invite/[token]` → sign in → "Vas a unirte a {school} como {name}. ¿Eres tú?" → `accept_invite` links `people.user_id`, fills the contact email if empty, creates the student membership with the person's status. Forwarded-link defence: the name confirmation, single use, 30-day expiry, 192-bit token, `person_already_linked` for a second taker, admin `unlink_person_user`.
- **Self-registration**: `/join/{slug}` → sign in first (magic link 6-digit code + link, or Google) → name and phone → `join_school`: if an unlinked student with the same verified email exists, link it (the admin already vetted them, no approval needed); else a `pending` person and membership. Pending students see a waiting card, cannot check in, and appear as a dashboard badge. Approval screen shows possible duplicates (same E.164 phone, same email, similar name) with "approve as new" (`approve_student` with categories and optional override, then the first-month prompt) or "same person as X" (`approve_as_existing`, merges the login onto the existing record). `reject_registration` keeps the row inactive for the audit trail.
- **Admin invites** are email-bound: acceptance requires the login email to match. Admins may invite and deactivate other admins; only the owner row is protected.
- **Guest → student**: `convert_guest_to_student(person, email?, categories[])` is a status change on the same row; every attendee, check-in and charge stays attached.
- **First school**: `/onboarding` → `create_school` for a signed-in user whose email is in `private.school_creation_allowlist` (seeded with yours). The same function becomes the multi-school signup once billing exists (§17).

### 5.14 WhatsApp, i18n, formatting, PWA

- **WhatsApp (§15)**: `waLink(e164, text)` = `https://wa.me/{digits}?text={encoded}`; `renderTemplate(body, vars, {locale, currency, timeZone})` is pure, validates placeholders at save time, formats `{amount}` and `{month}` in the recipient's language = `coalesce(people.language, profiles.preferred_language, school.default_language)`. Multi-person actions are one button per person with a tick once tapped.
- **Phones**: stored E.164 only (CHECK), parsed with `libphonenumber-js` using `schools.default_country`, echoed before save, re-parsed server-side, displayed nationally.
- **i18n (§16)**: next-intl **without URL routing**; locale from `cs_locale` cookie ← profile preference ← school default (public pages) ← `Accept-Language` ← `es`. Toggle on every page updates the profile and the cookie. `messages/es.json` canonical, `en.json` checked for key and ICU-placeholder parity in CI; typed keys; every Postgres enum value has an `enums.*` key (test); `no-literal-string` lint on `src/app` and `src/components`; database errors are snake_case keys mapped to `errors.*`.
- **Formatting**: one module `src/lib/format.ts` (`Intl` with explicit locale, currency and school timezone: `$45.000` in es, `$45,000` in en for CLP); `toLocale*` and bare `Intl` banned elsewhere by lint; `date-fns` + `@date-fns/tz` for local-day arithmetic; DST fixtures in tests.
- **PWA (§2)**: `manifest.ts`, icons (192, 512, maskable, apple-touch), hand-written `public/sw.js`: static assets cache-first, navigations network-only with an `/offline` page, **no HTML ever cached** (shared phones), cache name per build, "new version" toast. No push, no offline queue. Install card for admins; optional for students (iOS installed PWA has its own cookie jar, so the 6-digit code flow is the answer there).

### 5.15 Jobs, security, operations

- **Tick**: `GET|POST /api/cron/tick`, `Authorization: Bearer $CRON_SECRET` (constant-time compare, 401 with no body, inert on previews without the secret), `maxDuration 300`, service client; per school in order: materialise sessions, recompute expected lists, monthly charges, rate-limit cleanup; per-school `try/catch`; JSON summary. Scheduler: Vercel Cron `0 * * * *` (Pro) or `pg_cron` + `pg_net` calling the same route; the route does not care. Dashboard badge when the last successful tick is older than 3 hours; Settings shows the ledger.
- **Auth**: magic link (`token_hash` flow, verified on POST so link scanners cannot consume it, 6-digit code in the same email) + Google OAuth (PKCE); custom SMTP with SPF/DKIM/DMARC is a launch blocker (Supabase's built-in mailer only delivers to project members); no roles in JWT claims (revocation is immediate); `getUser()` on the server; sessions do not expire.
- **Rate limiting**: `private.throttle(key, limit, window)` inside public RPCs keyed on `auth.uid()`, email or token (join 3/day/user, check-in 60/hour/user, invite lookups 20/hour), per-IP limits at the edge (Vercel WAF on Pro, else in `proxy.ts`), Supabase Auth's own OTP limits; Cloudflare Turnstile on the OTP request is optional hardening (question Q13).
- **Headers**: HSTS, nonce-based CSP (report-only for two weeks, then enforced), `X-Frame-Options DENY`, `Referrer-Policy strict-origin-when-cross-origin` (tokens in paths never reach `wa.me` or Google), `Permissions-Policy` off for camera etc., `robots.txt Disallow: /`.
- **Environments**: local (Postgres or Supabase CLI), staging (own Supabase project, `main` → `staging.<domain>`), production (`production` branch, manual approval, `supabase db push` before the deploy hook). Supabase region `sa-east-1`, Vercel `gru1`. Secrets: the service key never has a `NEXT_PUBLIC_` prefix (CI grep); SMTP and Google secrets live only in the Supabase dashboard.

## 6. Folder structure

```
clave-studio/                          (this repository, root replaced — see Q1)
├── .github/workflows/ci.yml, deploy.yml
├── docs/  SPEC.md · PLAN.md · testing/milestone-N.md (hand-test scripts)
├── DECISIONS.md · README.md · .env.example · vercel.json · components.json
├── messages/  es.json (canonical) · en.json
├── public/    icons/ · sw.js · robots.txt
├── scripts/   seed.ts · bootstrap-school.ts · i18n-check.ts · check-build.ts (secrets + hardcoded names) · db/ (Docker-less migration runner)
├── supabase/
│   ├── config.toml
│   ├── migrations/            forward-only, one concern per file (extensions, private schema, activity_log, schools/profiles/memberships,
│   │                          people, catalogue, schedule+sessions, attendance, pricing, money, jobs+templates, rls+grants, rpc_*)
│   ├── seed/*.sql             demo school + isolation-control school, relative dates, written through the same RPCs the app uses
│   └── tests/                 SQL fixtures shared with Vitest
├── tests/
│   ├── db/                    Vitest + pg: RLS matrix, composite-FK refusals, trigger and RPC contracts, tick-twice idempotency
│   └── e2e/                   Playwright, mobile viewport: sign in, scan→confirm, record payment, review, approve
└── src/
    ├── app/
    │   ├── layout.tsx · page.tsx (root resolver) · manifest.ts · globals.css · error/not-found
    │   ├── (public)/login · join/[slug] · invite/[token] · legal/{privacy,terms} · offline
    │   ├── auth/{confirm,callback,signout}/route.ts
    │   ├── checkin/[token]/                      printed URL, outside every group
    │   ├── onboarding · schools · welcome
    │   ├── (app)/[slug]/layout.tsx               membership gate, SchoolProvider (currency, timezone, settings)
    │   │   ├── (admin)/ page (dashboard) · students · categories · rules · guests · team · activity · payments · charges
    │   │   │            · locations/[id]/qr/route.ts · schedule · agenda · agenda/sessions/[id] · settings/{general,templates,jobs}
    │   │   └── me/      page · categories · payments · attendance · agenda · settings
    │   └── api/cron/tick/route.ts · api/health/route.ts
    ├── components/  ui (shadcn) · layout · forms (MoneyInput, PhoneInput, DateField) · money · agenda · students · checkin · activity · whatsapp
    ├── lib/
    │   ├── domain/     PURE, no I/O, 100 % covered: money/ · pricing/ (engine, proration, breakdown) · overuse/ · agenda/ (window, overlap, occurrences)
    │   │               · charges/ (status, session-charges preview) · activity/ (describe)
    │   ├── supabase/   types.ts (generated) · browser.ts · server.ts · proxy.ts · service.ts (server-only, import-restricted)
    │   ├── format.ts · phone.ts · whatsapp.ts · safe-next.ts · dates.ts · validation/ (zod schemas shared by forms and actions)
    ├── server/  action.ts (defineAction) · school-context.ts · queries/ (read models per page) · people/ · invites/ · pricing/ · charges/
    │            · payments/ · sessions/ · attendance/ · jobs/ (tick, materialize, monthly-charges, cleanup)
    ├── i18n/request.ts · resolve.ts
    └── proxy.ts  (Next 16 name for middleware: session refresh, CSP nonce, locale cookie)
```

Toolchain (pinned in `package.json`): Node 22, pnpm 10, Next.js 16 / React 19, TypeScript strict (`noUncheckedIndexedAccess`), Tailwind CSS 4, shadcn/ui, next-intl 4, Vitest, Playwright, `zod`, `react-hook-form`, `date-fns` + `@date-fns/tz`, `libphonenumber-js`, `qrcode`, `supabase` CLI as a devDependency.

## 7. Testing strategy (§19)

| Layer | Tool | Proves | Gate |
|---|---|---|---|
| Pure domain | Vitest + `fast-check` | §6 priority order and best cover on hand cases and 200+ generated combinations; proration for 28–31-day months; overuse across ISO weeks in `America/Santiago` including both DST changes; check-in window edges; session-charge preview never double charges; activity keys for every event; formatting in both locales | 100 % line and branch coverage of `src/lib/domain` |
| Database | Vitest + `pg` against a real Postgres, running each test under `set local role authenticated; set local request.jwt.claims` | the **RLS matrix** for every table × {admin A, student A, student B, admin B, anon} (§19: a student never reads another student's data; school A never sees school B); no policy recursion; composite FKs refuse mixed tenants; the activity trigger logs before/after and refuses actorless writes; owner protection; every RPC's error keys; `materialize_sessions` and `insert_monthly_charges` run twice = same rows; a migration lint (every public table has RLS and the log trigger; every security-definer function has `search_path` set and no `anon` execute unless allowlisted) | required |
| Tenant sweep | Vitest + two `supabase-js` clients | a `TABLES` constant typed against the generated `Database` type (a new table cannot be forgotten) is read with student B's client and must return zero rows of school A; each RPC rejects a foreign `school_id` | required |
| End to end | Playwright, iPhone viewport | sign in, scan → confirmation timing on a warm session, record a payment, review a session, approve a pending student | required, kept to five flows |
| Manual | `docs/testing/milestone-N.md` | your hand test after each milestone | milestone sign-off |

Why database tests are TypeScript rather than pgTAP: one runner for everything, and they run both against the Supabase CLI stack (GitHub CI, your laptop) and against a plain PostgreSQL 16 with a small `auth` shim (`auth.uid()`, `auth.jwt()`, `auth.users`) — which is what is available in the cloud environment this plan was written in (Postgres 16 installed, **no Docker**, so `supabase start` cannot run there). Migrations are applied there by a small psql runner; the Supabase CLI remains the tool everywhere else. See question Q11.

## 8. Milestones (§18)

The nine milestones keep the brief's order. Four things are pulled forward because later milestones cannot be hand-tested without them: the full core schema, RLS and the activity trigger (M1, also what §18.1's seed of "categories, rules, 20 students" literally requires); the cron transport and job ledger (M1, needed by session generation in M4); a minimal Settings page and a bare activity list (M1); the Team page and the WhatsApp link helper (M3, needed by invites). Each milestone is merged to `main`, pushed to staging with seed data dated relative to today, and closed with your sign-off on its test script. Staging is reset at the start of each milestone; production stays empty until M9 (question Q10).

**M1 — Foundation.** Repo reset (Q1) and scaffold; all migrations for the core schema, `private` helpers, RLS policies and grants, activity trigger, `job_runs`; auth (magic link + Google) with `next` handling; root resolver, `[slug]` layout with membership gate, empty admin and student shells; next-intl skeleton, `format.ts`, language toggle, lint rules; `settings/general`; bare activity list; `/api/cron/tick` with secret check and an empty job list; seed with two schools (demo + isolation control), owner, admin, 20 students (some without login, some pending, some inactive), 3 guests, categories, rules, override, enrollments; CI; staging deployment; README and DECISIONS.
*You can test:* magic link and Google sign-in on your phone; language toggle persists; a student URL of the other school is 404; editing a setting produces an activity row with your name and before/after; the tick returns 401 without the secret and a ledger row with it; the PR shows the RLS matrix green.

**M2 — Pricing catalogue and engine.** `src/lib/domain/{money,pricing}` with the full test suite; Categories (create, edit, archive, price, limit, colour, location); Rules (pick ≥ 2 categories + price, "affects N students" preview, duplicate-set refusal, pricier-than-parts warning); read-only student list and the student **pricing card** (active categories, amount, explanation, "default would have been") with the override editor.
*You can test:* the scenarios of §6 on seeded students, including an override and a rule price change; every edit in the activity list; `pnpm test` shows the pricing suite.

**M3 — Students, invites, self-registration, approval, team.** People CRUD (E.164 phones, language, enrollment history with dates, admin note), search and filters (location, category; payment status arrives in M6), deactivate/reactivate; invites with copy-link and WhatsApp buttons; `/invite/[token]` with the "¿eres tú?" step; `/join/{slug}` → pending → approval with duplicate hints, categories, optional override; reject; dashboard badge; Team (invite admin by email, deactivate, owner protected); guest conversion; unlink.
*You can test:* the full invite and join flows from a second phone or private window; the owner cannot be deactivated; a `demo` student URL is 404 while signed in to `otra`.

**M4 — Locations, schedule pattern, sessions, agenda, QR check-in.** Locations with printable QR (SVG and A4 PDF); weekly grid per location with inline edit, duplicate, overlap warning, end/delete rules; `materialize_sessions` + tick job + immediate generation; slot → future sessions sync; agenda day/week/month with filters and colours; session detail with cancel, move, note, single dated class; `/checkin/[token]` with window, one/several/none, duplicates, extras-only-if-expected; admin live list with manual check-in and removal (logged). The unpaid reminder branch exists but stays inert until M6.
*You can test:* build your real weekly pattern; cancel and move single dates; change a slot time and see only future untouched dates follow; scan the printed QR during a seeded session and get the confirmation in under 5 seconds; scan again; remove a check-in; run the tick twice with no change.

**M5 — Expected attendees, extra sessions, guests, review, flags.** Automatic expected lists and their sync; manual add/remove; extra sessions with the composer (categories, students, on-the-spot guests), price, charge mode, counts toggle; Guests screen; the session screen's live and review modes with the one-tap action, walk-ins marked, "nobody came", mark reviewed / unmark; unreviewed to-do on the dashboard; `src/lib/domain/overuse` with tests; flags on the student detail. Marking reviewed creates no charges yet (M6 adds a separate, re-runnable "confirm charges" step on any reviewed session).
*You can test:* enrol and un-enrol someone and watch future lists change; compose a workshop with a guest; review yesterday's seeded class; see a seeded over-user and an unenrolled attendance flagged, and an extra's toggle change the count.

**M6 — Charges and payments.** Monthly run (ledger claim, per-school local date, "generate now"), mid-month prompt with proration, charge edit with reason, void/unvoid, one-off charges (person or categories) with preview, extra-session charging on reviewed sessions with preview and skip of already-charged people, `record_payment` with split across charges, void payment, Payments screen, derived statuses, student money tabs, payment-status filter, the check-in reminder goes live, money seed.
*You can test:* generate September and press again (no duplicates); activate a pending student on the 20th and accept the proportional amount; edit a charge; a batch for Comp Team A; charge a workshop twice (second time: 0 new); partial then full payment; void; scan as an unpaid student and see the reminder.

**M7 — Dashboard and WhatsApp.** The four blocks in order (today's classes with live check-ins and correct button; unpaid this month with open amount, days overdue, WhatsApp reminder, quick record payment; overuse this week; income expected vs received by location and category) and the two badges; template editor in Settings; WhatsApp buttons on the unpaid list, on sessions (one link per expected person) and on invites, rendered in the recipient's language.
*You can test:* the dashboard on your phone against the seeded day; the WhatsApp button opens the app with name, month and amount; an English-speaking seeded student gets English.

**M8 — Student portal.** Overview, my categories and price with explanation (from the charge snapshot), payment status and history, attendance history, my agenda (expected sessions, extras, cancellations), settings (language, contact); school switcher for users with several memberships.
*You can test:* as a seeded student on the phone; another student's data is unreachable by URL; nothing from the other school is visible.

**M9 — Activity screen, PWA, hardening, go-live.** Activity with filters (admin, entity type, student, date range) and readable lines; PWA (manifest, icons, service worker, offline page) with a Lighthouse pass; CSP enforced; rate limits; production Supabase and Vercel environments, domain, SMTP with DKIM, Google consent screen; `bootstrap-school.ts` creates your real school; one migration squash; final README; go-live checklist.
*You can test:* install on iPhone and Android; airplane mode shows the offline page; the activity line reads "Carla registró un pago de $30.000 en efectivo de Juan Pérez, septiembre"; your real school works end to end with no demo data.

Estimate (opinion, not a commitment): M1 is the largest and least visible milestone; M4–M6 carry most of the logic; M7–M9 are mostly screens over data that already exists.

## 9. Questions, defaults and contradictions

### 9.1 Questions that change what gets built (please answer each)

| # | Question | My recommendation and why |
|---|---|---|
| **Q1** | **Repository.** This repo currently holds the unrelated EqualScore static demo (`index.html`, `scripts/`, `styles/`, `netlify.toml`, a Spanish README). May I replace the root contents with the Next.js app, keeping the demo as tag `equalscore-demo-final` and branch `equalscore-demo`? Rename the GitHub repo to `clave-studio`? | Yes to both. `netlify.toml` would mislead a Vercel deploy and its catch-all rewrite describes another product. If you still need the demo served somewhere, it moves to `legacy/equalscore/` instead. |
| **Q2** | **Accounts and plans.** A paid product needs Vercel **Pro** (Hobby forbids commercial use and its crons run once a day) and Supabase **Pro** for production (backups, no project pausing), plus custom SMTP (Resend free tier; Supabase's built-in mailer only delivers to project members), a product domain, and a Google Cloud OAuth client. Will you create these accounts (I will write the exact steps), and when can I have the Supabase project URL and keys for staging? | Estimate: about USD 45/month for the two Pro plans before domain and email. Staging can start on Supabase Free. **M1's testable deliverable (sign-in on your phone) needs a Supabase project**, so this is the first practical dependency. |
| **Q3** | **Second city.** Is the other location on Santiago time? Magallanes (`America/Punta_Arenas`, no DST) and Easter Island would make one school timezone wrong for part of the year. | If yes, one `schools.timezone`. If not, I add a nullable `locations.timezone` override before M4 (one column, one function). |
| **Q4** | **Payment model.** The brief links a payment to one charge. I propose exactly that: a transfer covering September and a costume becomes two payment rows from one form; a payment larger than what is open is refused; there are no credit balances ("keep the extra 5.000 for October") in v1. The alternative is a payments-and-allocations ledger with per-student credit and automatic application to new charges: more correct accounting, noticeably more to build and to explain. | Simple model for v1; the allocation ledger is an additive change later. Tell me if advance payments are common at your school, because then the alternative is worth it now. |
| **Q5** | **Pricing tie-break.** §6 says the rule covering the most categories wins, then the lowest price. Taken literally, a rule can win even when it is *more expensive* than the categories separately, and two small rules can beat one cheaper big rule if they cover more. Keep the literal order? | Yes, keep §6 literally (it is what you asked for and rules are yours), and the rules screen warns when a rule is pricier than its parts. The alternative "lowest total wins" is a one-line change in the comparator; say so if you prefer it. |
| **Q6** | **Rule shape.** A rule applies only when the student has *every* category in it. Your example "Comp Team A includes weekly classes" therefore needs one rule per combination (Comp A + Friday 2x, Comp A + Partnerwork, …). Acceptable for v1? | Yes; "required + optional categories" rules are an additive change later. |
| **Q7** | **Self-registration shape.** Sign in first (email code/link or Google), then a two-field form (name, phone), rather than an anonymous form. Slightly more friction, no bot pile, verified email, and the pending student immediately sees "waiting for approval". | Sign-in first. |
| **Q8** | **Extras and the door QR.** A student can QR-check-in to an extra session only if they are on its expected list (§9); regular classes accept any active student (flagged if not enrolled). A pending (unapproved) student cannot check in at all. | Yes; it prevents accidental charges under "charge attended". Walk-ins to extras are added by you in the review. |
| **Q9** | **Overuse rules.** (a) A regular session of an unlimited category (competition team) never consumes the weekly allowance even though it "counts toward limit" by default; (b) a student with no limited category is never flagged for overuse (only "not enrolled"); (c) attendances in limited categories the student is not enrolled in do count toward the allowance; (d) unreviewed check-ins count until you mark someone absent. | Yes to all four. |
| **Q10** | **Real data.** Production stays empty until M9 and staging is reset at every milestone boundary (what you typed during a test is wiped). If you want to start entering real students earlier (M3 is tempting), say so now: from that day migrations must be non-destructive and production is backed up before every push. | Empty until M9; start real data after M7 at the earliest. |
| **Q11** | **Build environment.** The cloud environment I run in has Node 22 and PostgreSQL 16 but **no Docker**, so the Supabase local stack cannot run here. Plan: migrations and RLS tests run here against a plain Postgres with a small `auth` shim; GitHub CI and your laptop use the Supabase CLI; auth flows are tested on the staging project. OK? | Yes; it is why the database tests are Vitest + `pg` rather than pgTAP. |
| **Q12** | **Additions beyond the brief** that I recommend for a sellable product, each cheap: bilingual privacy and terms pages (Google's consent screen requires a privacy URL); a `suspended_at` switch on schools (freeze a non-paying school without deleting data, no UI); Sentry error reporting from M1 (free tier). Account deletion for students stays a manual runbook in v1. | Yes to all three, deletion manual. |
| **Q13** | **Bot protection on sign-in** (Cloudflare Turnstile on the email-code request) — off by default, added if abuse appears. | Off. |

### 9.2 Defaults I will apply unless you object

Grouped by area; each is a single line so you can scan for anything that looks wrong.

**Roles and people**
- One membership per user per school; an admin who also dances has a linked `people` row and sees both navigations; no separate "teacher" role.
- Admin-created students are active immediately (charged, expected); self-registered ones are pending until approved.
- When a self-registration's verified email matches an existing unlinked student, the rows are linked without approval (you already created them). No uniqueness on phone or email (siblings share a phone); duplicates are hinted, not blocked.
- An inactive student loses portal access; their history and open charges remain visible to admins.
- Guests can be added to regular classes too (name + phone); they never get enrollments or monthly charges.
- Student invite links are bearer links with a "¿eres tú, {name}?" confirmation, 30-day expiry, single use; admin invites are bound to the email, 7 days.
- Students can read the school's categories (names, colours, limits, default prices) and locations; never rules, overrides, or other people's rows. Their own price is shown from the charge snapshot.
- Student actions (QR check-ins, contact edits, invite acceptance) are logged with `actor_kind = student`; the activity screen defaults to admins.
- First school: an `/onboarding` page for a signed-in user whose email is on an allowlist seeded with yours; your real school is created that way (or by a script) at go-live.

**Agenda and attendance**
- Sessions are generated 12 weeks ahead (brief: at least 8) and further on demand up to 52 when you open a later month.
- A pattern with a `valid_from` in the past generates from today unless you tick "also create sessions since {date}" (backfill).
- A pattern's weekday cannot change in place; "move to Thursday" ends it today and duplicates it.
- Ending or pausing a pattern removes untouched future sessions and cancels edited ones with reason "pattern ended".
- Classes cannot cross midnight (end after start, same day).
- Check-in window defaults: 30 minutes before start, 0 after end; editable within 0–180 / 0–120.
- A student may check in to two overlapping sessions (rare); both reviews show it and you remove one.
- Manual admin check-ins have no time window (late arrivals after the class).
- Removing a person from a list is remembered for that session even if their enrollment changes; refused while they have a check-in or a charge for it.
- Category links on extras stay live until the session starts (a new team member is expected automatically), labelled "via {category}".
- The session note is visible to expected students (single note field).
- Review controls are available from the start time; the to-do lists sessions whose end time has passed; older than 30 days are collapsed behind a count; no automatic review.
- All times are shown in the school timezone even when your phone is abroad; changing the timezone re-times future sessions only.
- Archiving a category or location ends every pattern that uses it (after showing the list); archiving a category with active enrollments is refused.
- Live check-in lists refresh every 10 seconds while open.

**Money**
- Overrides may start on any date; a monthly charge is priced as of the 1st, a mid-month charge as of the join date, so an override starting mid-month shows as "differs from current price" for that month (one-tap edit).
- Students with no categories on the 1st get no charge (listed on the dashboard); a $0 override or only $0 categories gives a $0 charge shown as paid.
- Proration is by calendar days including the join day, rounded half-up to whole pesos; the admin can type any amount.
- Category changes mid-month never rewrite the charge; the page suggests "use new amount" (a logged edit).
- Deactivating mid-month keeps the charge unless you choose prorate or void; inactive students with open charges stay in the unpaid list until voided.
- Charges are voided with a reason, never deleted; voiding frees the slot (a mistaken void can be recreated); to gift a month, set the amount to 0.
- Extra-session charges are due on the session day and belong to that month; "signed up" mode charges everyone on the list except `excused`; you can uncheck people and edit amounts in the preview.
- Regular sessions are never charged per attendance in v1 (the column exists; the UI hides it); drop-ins are flagged, not charged.
- Payment amounts are immutable (void and re-record); method, date and note are editable; backdating allowed.
- The unpaid list shows the current month first and a collapsed "older open charges" block; guests with open charges are a third block.
- Income "received" = payments on this month's charges whenever paid, with a second line "cash received this month"; rule money is attributed to categories proportionally to their default prices.
- The first billed month is the month after the school is created; earlier months only through "Generate now"; currency is locked once money exists.
- The monthly run skips people who already have any charge (live or voided) for the period.

**Platform**
- Money formatting follows the UI language (`$45.000` in Spanish, `$45,000` in English); dates and times in the school timezone, 24-hour clock.
- Phones are stored E.164 only; the school's default country (CL) fills the prefix; national display; `wa.me` from the digits.
- Non-users get a `language` field on their person record (default: school language) so WhatsApp messages are in their language; a user's own choice overrides it.
- PWA: installable; offline = a "no connection" page; no cached data, no push, no offline check-in queue; install card for admins, optional for students.
- Sessions never expire (no forced re-login); no passwords, no SMS.
- Supabase region São Paulo, Vercel `gru1`; two Supabase projects (staging, production); `main` deploys to staging, a `production` branch to production with manual approval.
- Code, commits and docs in English; UI default Spanish.
- Seed data: two schools (demo + isolation control), relative dates, written through the app's own RPCs; local seed users have a password shown only against a local database.

### 9.3 Contradictions and gaps in the brief, with the resolution I propose

| # | Where | Issue | Resolution |
|---|---|---|---|
| C1 | §5 `memberships` (user × school) vs §10 admin-created students, §5 guests "no login", §9b guests get charges | Business identity is tied to a login in one place and explicitly login-less in others. | `people` (identity, nullable `user_id`) separate from `memberships` (access). |
| C2 | §5 `memberships.status` has `pending` vs §10 the *student* is pending vs §7 "every active student" | Which object is pending or active? | `people.status` is canonical; the membership mirrors it for students. |
| C3 | §5 `session_attendees.charged` flag vs §9b "never double charge", §7 editable/voidable charges | A boolean cannot say which charge, survive a void, or power the preview. | `session_attendees.charge_id` + a unique index on `(session_id, person_id)`. |
| C4 | §5 `session_attendees` "check in time, source" vs §5 `check_ins` "timestamp, source" | The same fact stored twice with no rule after a removal. | `check_ins` is the log; the attendee columns are trigger-maintained caches. |
| C5 | §5 `charges` `one_off` has no period vs §9b "dated in the month of the session so it lands on that student's monthly total" | One-offs need a month. | Every charge has `period`. |
| C6 | §5 status set `unpaid/partial/paid` vs §7 "admins can edit any charge" | No way to cancel a charge except editing to $0, which corrupts "expected income". | `void` status with a reason. |
| C7 | §6 "prefer the rule covering the most categories; on a tie, the lowest price" | Can pick a cover more expensive than an alternative (see Q5). | Literal order + warning at save time. |
| C8 | §7 "on the 1st" vs §3 timezone per school and "Supabase cron or Vercel cron" | The 1st is a local date that differs per school; a daily cron cannot implement it. | Hourly tick, per-school local date, ledger. |
| C9 | §7 mid-month proration has no basis; "activated after the 1st" misses the 1st itself | Days vs classes, inclusive or not, rounding. | Calendar days including the join day; trigger is "active this month with no live charge". |
| C10 | §6 "one pure, well tested function" (TypeScript) vs §7 "Supabase cron" | `pg_cron` cannot call TypeScript; a SQL copy would be a second engine. | The run computes in TS and inserts through one SQL function; the scheduler only calls a route. |
| C11 | §12.4 split by location and category vs §5 optional category location, rules spanning categories, §8 one-offs, §9b free-address extras | Attribution undefined. | `breakdown` snapshot with proportional split and "no location"/"one-off"/"extras" buckets. |
| C12 | §9b "single dated class without any weekly pattern" vs §5 `kind (regular \| extra)` and "source slot" | Neither generated nor an extra. | `regular` with `slot_id null`. |
| C13 | §9 "extra sessions work the same way for students on the expected list" vs §9b review shows "anyone who checked in but was not expected" | Pull in opposite directions for extras. | Extras: QR only for expected people; regular: open and flagged (Q8). |
| C14 | §9 allowance "of active categories that have a limit" vs "flag when counted attendances in limited categories exceed the allowance" vs §5 `counts_toward_limit` default true for all regular sessions | Undefined with no limited category (allowance 0 would flag everything); a competition rehearsal would eat the weekly classes. | Q9 rules. |
| C15 | §5 status `scheduled/cancelled/moved` vs §9b cancel *and* move on one date | One column cannot say both. | `cancelled` wins; overrides persist; uncancel restores `moved`. |
| C16 | §9b "changes apply to future sessions only" vs per-date edits vs idempotent regeneration | No rule says which per-date edits survive a pattern edit. | Immutable `(slot_id, slot_date)`, explicit override flags, pristine rule, cancel-with-reason when a pattern shrinks. |
| C17 | §9 "week = Monday to Sunday" vs `check_ins` timestamp | Session date or check-in instant? They differ around midnight and DST. | Always the session's local date. |
| C18 | §3 settings list vs §9 check-in window "make it a school setting", §15 templates, phone normalisation needs a default country | §3 is incomplete. | Two window columns, `default_country`, `whatsapp_templates`. |
| C19 | §9b extra "location (or free text address)" vs §5 sessions have a location vs §9 QR by location | A free-address extra has no QR. | `location_id` nullable + `address_text`; attendance recorded by the teacher. |
| C20 | §4 admins "same rights as owner", owner "can invite and remove admins", §13 Team | Whether admins may manage other admins is implied, not stated. | Yes, except the owner. |
| C21 | §4 "owner creates the school" vs §17 "multi school signup flow" out of scope | Nobody can create the first school. | Allowlisted `create_school` + `/onboarding`. |
| C22 | §11 "every create, update and delete **by an admin** is logged" vs §5 `check_ins` as a door audit (student-initiated) vs §5 cron-generated sessions | Student and system events are outside the letter; logging every generated row would bury real actions. | Log all actors with `actor_kind`; skip pristine derived rows. |
| C23 | §10 admin creates a student with **email** + auth is email or Google | Many students have WhatsApp but no email they check; without one they can never log in. | Email optional; the person is a full record without a login; the invite page asks for an email or Google at sign-in. |
| C24 | §19 "check in under 5 seconds from scan to confirmation" vs §9 "must be logged in (redirect to login, then back)" | A first-ever scan includes an email round trip. | The budget applies to a signed-in phone (one round trip, auto check-in on a single match); sessions never expire so the first login happens once. |
| C25 | §18 order: overrides (M2) before any student screen (M3); Settings and Team have no milestone; §18.1 seed needs M2/M3 tables; §5 cron for sessions (M4) vs §7 cron mentioned only for charges (M6); §11 trigger vs "activity log screen" in M9; §9b review (M5) creates charges (M6); §10 invite WhatsApp button (M3) vs §18.7 WhatsApp (M7) | Milestone dependencies. | The reordering in section 8 (D-030). |
| C26 | §2 "Deploy on Vercel", §7 "Vercel cron", §19 "monthly subscription fee" | Hobby plan is non-commercial and daily-only crons. | Q2. |
| C27 | §14 "Check in (via door QR)" as a portal feature | The portal cannot check in without the QR. | The portal's check-in screen lists today's expected sessions with their state and says "scan the door QR"; no manual self check-in. |
| C28 | §19 README vs the current repository contents | The README, `.gitignore` and `netlify.toml` describe another product. | Q1. |
