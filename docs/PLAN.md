# Clave v1 — Implementation plan

Status: **proposed, awaiting approval** (nothing in `src/` exists yet). Companion documents: `docs/SPEC.md` (the brief, verbatim; `§n` below refers to its sections) and `DECISIONS.md` (choices the brief does not specify; entries are marked *proposed* until this plan is approved).

How to read this: sections 1–8 are the design and the build order. **Section 9 is what needs your answer**: a short list of questions that change what gets built, a longer table of defaults I will apply unless you object, and the contradictions I found in the brief with the resolution I propose. Section 10 lists what is deliberately deferred. Replying "approved, defaults are fine" plus answers to the numbered questions is enough to start milestone 1.

---

## 1. Guiding principles

1. **The database is the security boundary.** Every business table carries `school_id`; Row Level Security, composite foreign keys, unique and exclusion constraints, and triggers make the invariants true even if application code has a bug. Next.js is a typed client of that boundary.
2. **Two identities, one link.** `auth.users` + `profiles` + `memberships` say *who can log in and what they may access*. `people` says *who the school does business with* (students and guests), whether or not they ever log in. The only link is `people.user_id`, nullable.
3. **Money is integers, snapshotted, never rewritten.** Every charge stores what the engine computed, how it got there, and what applies after edits. Price changes reach future charges only (§6).
4. **Numbers and explanations shown to a human are pure TypeScript functions** (pricing, proration, overuse, charge previews, income split), unit-tested exhaustively. Anything that must be atomic with a write or decide what the database does (session generation, expected-attendee sync, the check-in window match, overlap detection, idempotent inserts, the audit trail) is SQL, tested against a real database. **Nothing is implemented twice**; where TypeScript needs the same predicate for display only ("starts in 12 min"), that helper is labelled display-only and is not the authority.
5. **Every scheduled job is idempotent by natural key plus a ledger row**, whoever calls it (Vercel Cron, pg_cron, an admin's "run now", a retry).
6. **Nothing is hardcoded that §3 and §16 say is a setting.** Enforced by tooling (lint rule for literal UI strings, seed data outside `src/`, tenant-isolation sweep over every table and every RPC), not discipline.
7. **"Today", "this month" and "this week" are always the school's local date.** SQL never uses `current_date` or `now()::date`; it uses `private.local_date(school_id)`, and a migration lint enforces it.

## 2. Domain model overview

```
auth.users ─1:1─ profiles                 (global; name, phone default, email cache, preferred_language)
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
        ──< categories ──< schedule_slots ──< class_sessions ──< session_attendees, session_expected_categories
        ──< combination_rules ──< combination_rule_categories
        ──< charge_batches, whatsapp_templates, invites, job_runs, activity_log
```

Why one `people` table for students and guests: attendance, check-ins and charges reference *a person*; guest → student conversion is a status change that keeps every row (§5 "keeping their history"); the alternative (two tables, nullable `student_id`/`guest_id` pairs on every referencing table) doubles every join and every policy.

Why business status lives on `people` and not on `memberships`: admin-created students are charged and expected in class before they ever accept an invite (§10), and guests never log in (§5). `memberships.status` mirrors `people.status` by trigger for students; owner/admin memberships are only `active`/`inactive`.

## 3. Data model

Conventions: Postgres on Supabase. Every table has `id uuid primary key default gen_random_uuid()` (except `activity_log`, `bigint identity`), `created_at timestamptz default now()`; mutable tables also `updated_at` (trigger). Every business table has `school_id uuid not null references schools(id)` plus `unique (id, school_id)` when other tables reference it, so children use **composite foreign keys** `(child.x_id, child.school_id) → parent(id, school_id)`: a row can never point across tenants, whatever path wrote it. Money is `bigint` in the currency's smallest unit (CLP: pesos), `check (>= 0)`. Calendar concepts (`date`, `period`, `valid_from`) are `date` in the school's timezone, computed through `private.local_date(school_id)`; instants are `timestamptz`. Extensions: `pgcrypto`, `citext`, `btree_gist`, `pg_trgm`.

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
| `charge_source` | `monthly_run`, `mid_month`, `batch`, `extra_session` |
| `charge_status` | `unpaid`, `partial`, `paid`, `void` |
| `payment_method` | `cash`, `transfer`, `other`, `online` |
| `job_status` | `running`, `completed`, `failed` |

Languages are `text check (in ('es','en'))` so adding a language is a data change, not an enum migration.

### 3.2 Tenant, users, access

**`schools`** — the tenant and its settings (§3, §13 Settings)

| Column | Type | Notes |
|---|---|---|
| `name` | text not null | |
| `slug` | citext not null unique | `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$`, reserved words excluded (`admin`, `api`, `join`, `invite`, `checkin`, `login`, `auth`, `me`, `legal`, `onboarding`); public join link `/join/{slug}`; changing it breaks printed links (the UI warns) |
| `currency` | char(3) not null default `'CLP'` | locked by trigger once any charge or payment exists |
| `timezone` | text not null default `'America/Santiago'` | validated against `pg_timezone_names` |
| `payment_due_day` | smallint not null default 5 | `check between 1 and 28` |
| `default_language` | text not null default `'es'` | |
| `default_country` | char(2) not null default `'CL'` | for phone normalisation to E.164 |
| `checkin_window_before_min` | smallint not null default 30 | `check between 0 and 180` (§9 "make it a school setting") |
| `checkin_window_after_end_min` | smallint not null default 0 | `check between 0 and 120` |
| `join_enabled` | boolean not null default true | public self-registration on/off |
| `billing_start_period` | date not null | first-of-month; set by `create_school` to the month after creation; shown in Settings as "start billing from"; the tick, the first-month prompt and the "needing a charge" list never consider earlier periods |
| `suspended_at` | timestamptz | suspension switch for a non-paying school (set by script only; data preserved; members see a "suspended" page; the tick skips the school) |
| `created_by` | uuid → profiles | |

Admin-updatable columns (column grant): `name`, `slug`, `currency`, `timezone`, `payment_due_day`, `default_language`, `default_country`, both check-in windows, `join_enabled`, `billing_start_period`. Never `suspended_at`, `created_by`.

**`profiles`** — one row per `auth.users` row, created by trigger on sign-up (§5)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk → auth.users on delete cascade | |
| `full_name` | text | from Google `name` when available |
| `phone` | text | E.164 `check (phone ~ '^\+[1-9][0-9]{6,14}$')`; the user's default, copied onto `people.phone` when a person row is created or linked with no phone |
| `email` | citext | cache of `auth.users.email`, maintained by trigger; not writable by users |
| `preferred_language` | text | null = never chosen |
| `avatar_url` | text | optional, from Google |

`profiles` is global, not a business table: no `school_id`, no activity trigger (its writes are the user's own preferences).

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
| `phone` | text | E.164 check; **the canonical WhatsApp number for this person in this school** (§5, §15); `update_my_contact` writes it on every person row linked to the user |
| `email` | citext | school's contact record, optional; never proof of identity |
| `language` | text | admin-entered language for people who never log in; effective language = `coalesce(profiles.preferred_language, people.language, schools.default_language)` (read-time rule, no trigger) |
| `note` | text | the brief's guest/student note; **visible to the person if they ever log in** (the form says so); admin-only remarks belong in activity-log reasons |
| `activated_at`, `deactivated_at` | timestamptz | `activated_at` (as a local date) drives the mid-month suggestion and the monthly run's eligibility (§7) |
| `merged_into_person_id` | uuid → people (composite) | set when a duplicate self-registration is merged into an existing record |
| `created_by` | uuid → profiles | |

Indexes: `(school_id, kind, status)`, `(school_id, email) where email is not null`, trigram on `full_name` for search and duplicate hints. Trigger `assert_student` on `student_categories`, `price_overrides`, `invites (role student)` refuses guests.

### 3.4 Catalogue

**`locations`** (§5, §13): `name text not null`, `address text`, `archived_at timestamptz`; `unique (school_id, name)`. Archiving ends every active slot at that location (after listing them).

**`location_qr_tokens`** (§9; rotation-ready): `location_id` (composite FK), `token text not null unique` (32 hex chars from `gen_random_bytes(16)`), `kind text default 'printed'` (a later rotating tablet QR is another row kind), `active boolean not null default true`, `created_by`, `revoked_at`; `unique (location_id) where active`. Satisfies §5 "a unique `qr_token`" while keeping tokens out of any table students can read.

**`categories`** (§5): `name text not null`, `location_id uuid null` (composite FK; reporting attribute, slots are the truth), `color text not null` (hex), `default_monthly_price bigint not null check (>= 0)`, `attendance_tracking text not null default 'qr' check (in ('qr','none'))` (**`qr`** = a class: sessions are checked in at the door and count toward the weekly allowance; **`none`** = a rehearsal-type category such as a competition team or show group: no QR check-in, attendance is the student's own responsibility, sessions never count), `classes_per_week_included smallint null check (>= 0)` (the number of tracked classes per week the fee includes: for a `qr` category its own classes, e.g. "Friday Santiago 2x" → 2, must be ≥ 1; for a `none` category the weekly regular classes the team fee grants, e.g. "Comp Team A, 1 class included" → 1, 0 = none; **null = unlimited**), `active boolean not null default true`; `unique (school_id, lower(name)) where active`. Archiving a category that still has active enrollments is refused with the list of students (or "end all enrollments today"); archiving ends its active slots.

**`schedule_slots`** — the weekly pattern (§5, §9b, §13)

| Column | Type | Notes |
|---|---|---|
| `location_id`, `category_id` | uuid not null (composite FKs) | |
| `weekday` | smallint not null | ISO, `check between 1 and 7`, 1 = Monday; **immutable after creation** ("move to Thursday" = end this slot + duplicate) |
| `start_time`, `end_time` | time not null | `check (end_time > start_time)` (no classes past midnight in v1) |
| `valid_from` | date not null | first occurrence = first date ≥ `valid_from` on that weekday; generation starts at `greatest(local today, valid_from)` |
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
| `cancel_reason`, `cancelled_at`, `cancelled_by` | text / timestamptz / uuid | `check ((status = 'cancelled') = (cancelled_at is not null))`; the reason is visible to expected students by design (§9b "greyed out with the reason") |
| `override_time`, `override_location` | boolean not null default false | set by `move_session`; a slot edit skips overridden fields |
| `moved_from` | jsonb | `{date, start_time, end_time, location_id}` before the first move, for "moved from Fri 19:00" labels |
| `extra_type`, `title` | extra_type / text | `check (kind = 'regular' or (extra_type is not null and title is not null))`; regular sessions display the category name |
| `note` | text | visible to expected students |
| `price` | bigint | `check (price is null or price >= 0)` |
| `charge_mode` | charge_mode not null default `'none'` | |
| `qr_checkin` | boolean not null | filled by trigger when omitted: regular → the category's `attendance_tracking = 'qr'`; extra → `extra_type <> 'rehearsal'`; editable per session. When false the door QR never matches the session and it is not listed in the review to-do |
| `counts_toward_limit` | boolean not null | filled by trigger when omitted: `kind = 'regular' and the category's attendance_tracking = 'qr'` (§5: regular true, extras false); editable per session |
| `reviewed_at`, `reviewed_by` | timestamptz / uuid | |
| `created_by` | uuid | null = generated |

Three kinds of session, one table: generated from a pattern (`regular`, `slot_id` set), **single dated class** (§9b; `regular`, `slot_id` null, category set: auto expected list, counts by default when its category is tracked) and extra (`extra`, teacher-composed list, counts off by default). Sessions of rehearsal-type categories (`attendance_tracking = 'none'`) are regular sessions with `qr_checkin = false` and `counts_toward_limit = false`: on the agenda with an expected list (for WhatsApp), but never at the door.

**Pristine** session (may be hard-deleted by the pattern sync): `created_by is null and status = 'scheduled' and not override_time and not override_location and note is null and reviewed_at is null`, no attendee row with `source <> 'auto'` or `removed_at`/`checked_in_at`/`charge_id` set, and no `check_ins`. `session_attendees.session_id` is `on delete cascade` (safe under that definition: only untouched auto rows exist); `check_ins.session_id` and `charges.session_id` are `on delete restrict`.

Indexes: `(school_id, date)`, `(location_id, starts_at) where status <> 'cancelled'`, partial `(school_id, ends_at) where reviewed_at is null and status <> 'cancelled' and qr_checkin` (to-do), gist `(location_id, tstzrange(starts_at, ends_at)) where status <> 'cancelled'` (overlap warnings).

**`session_expected_categories`** — category links of an extra's expected list (§9b "whole categories"; also usable on a regular session to invite a second category): `session_id`, `category_id`, `school_id`, `added_by`; pk `(session_id, category_id)`. Live until the session starts (a new team member is expected automatically); each auto row shows "via Comp Team A".

**`session_attendees`** — the list and the teacher's verdict (§5, §9b)

| Column | Type | Notes |
|---|---|---|
| `session_id`, `person_id` | uuid (composite FKs) | `unique (session_id, person_id)`; session `on delete cascade`, person `on delete restrict` |
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
| `removed_at`, `removed_by` | timestamptz / uuid | `check ((status = 'removed') = (removed_at is not null))`; the removal reason lives in `activity_log.reason` (students can read their own check-in rows, admin remarks must not sit on them) |

`unique (session_id, person_id) where status = 'valid'` (§9 "no duplicate check in"); trigger refuses deletes and any update other than `valid → removed`. A wrong check-in is an audit row, never a missing one.

### 3.6 Enrollment and pricing

**`student_categories`** (§5): `person_id`, `category_id` (composite FKs), `start_date date not null`, `end_date date null`, `created_by`; `exclude using gist (person_id with =, category_id with =, daterange(start_date, end_date, '[]') with &&)` (no overlapping enrollment in the same category; history kept).

**`combination_rules`** (§5, §6): `name text not null`, `monthly_price bigint not null check (>= 0)`, `active boolean not null default true`, `categories_key text not null default ''` (sorted member ids joined; recomputed by the trigger on `combination_rule_categories`; direct update revoked); `unique (school_id, categories_key) where active and categories_key <> ''` (no two active rules with the same set). A deferred constraint trigger requires ≥ 2 members at commit.

**`combination_rule_categories`**: `rule_id`, `category_id`, `school_id`; pk `(rule_id, category_id)`; composite FKs (rule on delete cascade, category on delete restrict).

**`price_overrides`** (§5, §6): `person_id` (composite FK), `monthly_price bigint not null check (>= 0)` (0 = scholarship), `reason text not null` (admin-only; never copied into a charge snapshot), `valid_from date not null`, `valid_until date null`, `created_by`; `exclude using gist (person_id with =, daterange(valid_from, valid_until, '[]') with &&)` (at most one override at any date, so step 1 of §6 is deterministic).

### 3.7 Money

**`charges`** (§5, §7, §8, §9b)

| Column | Type | Notes |
|---|---|---|
| `person_id` | uuid (composite FK, on delete restrict) | students and guests; `unique (id, person_id, school_id)` is the target of the payments FK |
| `type` | charge_type not null | |
| `source` | charge_source not null | `check (type = 'one_off' or source in ('monthly_run','mid_month'))`; `check (source <> 'batch' or batch_id is not null)`; `check (source <> 'extra_session' or session_id is not null)` |
| `period` | date not null | first day of the month this charge counts toward, **for all charges** (§9b "lands on that student's monthly total"); `check (period = date_trunc('month', period))`; displayed as `YYYY-MM` |
| `session_id` | uuid (composite FK, on delete restrict) | extra-session charges |
| `batch_id` | uuid (composite FK → charge_batches) | one-off batches |
| `default_amount` | bigint not null | what the engine computed; **immutable** |
| `amount_due` | bigint not null | what applies after edits |
| `paid_total` | bigint not null default 0 | recomputed from scratch by trigger from non-voided payments |
| `status` | charge_status **generated always as** (`void` if `voided_at`, `paid` if `paid_total >= amount_due`, `partial` if `paid_total > 0`, else `unpaid`) stored | one truth for dashboard, portal, reminder and filters; indexable |
| `pricing_snapshot` | jsonb | engine input + result (basis, rule/category ids and labels at the time, override **id** only, engine version); **immutable**; powers "how the amount was reached" and "what the default would have been" (§6) |
| `breakdown` | jsonb | `[{category_id, location_id, amount}]` allocation of `default_amount` for the income split (§12.4), largest-remainder rounding; immutable |
| `proration` | jsonb | `{days_in_month, days_charged, full_amount, prorated_amount, choice}` for mid-month charges |
| `due_date` | date not null | snapshotted from `payment_due_day` at creation (setting changes affect future charges only) |
| `description` | text | free text for one-offs, visible to the person; monthly charges render from `period` in the reader's locale |
| `created_by` | uuid | null = system |
| `voided_at`, `voided_by` | timestamptz / uuid | charges are never deleted; the reason lives in `activity_log.reason` |

Partial unique indexes (the idempotency backbone): `(person_id, period) where type = 'monthly' and voided_at is null`; `(session_id, person_id) where session_id is not null and voided_at is null`; `(batch_id, person_id) where batch_id is not null and voided_at is null`. Trigger `charges_guard`: immutable columns listed above; `amount_due >= paid_total` (a charge is never overpaid); void refused while `paid_total > 0`; no `paid_total` change on a void charge. All writes go through RPCs (no direct insert/update grants).

**`charge_batches`** (§8): `client_key uuid not null` with `unique (school_id, client_key)` (a retried submit returns the existing batch and its charges), `description text not null`, `amount bigint not null`, `due_date date not null`, `period date not null`, `target jsonb not null` (`{category_ids:[...]}` or `{person_id}`), `category_id uuid null` (income attribution when a single category is targeted), `created_by`. **Every one-off charge belongs to a batch**, even for one person, so every one-off is idempotent on `(batch_id, person_id)`. Recipients are resolved once at creation (active students with an enrollment active today in any target category, deduplicated); "add person to batch" covers late joiners.

**`payments`** (§5)

| Column | Type | Notes |
|---|---|---|
| `charge_id`, `person_id` | uuid | composite FK `(charge_id, person_id, school_id) → charges (id, person_id, school_id)`: a payment can never sit on someone else's charge |
| `amount` | bigint not null `check (> 0)` | immutable; mistakes are voided and re-recorded |
| `method` | payment_method not null | `online` reserved for the future provider |
| `paid_at` | timestamptz not null default now() | backdating allowed |
| `recorded_by` | uuid not null → profiles | |
| `note` | text | visible to the person (e.g. transfer reference); admin remarks go to the activity log |
| `provider`, `provider_ref` | text | nullable; `unique (provider, provider_ref) where provider is not null` (§5 future Mercado Pago / Flow) |
| `client_key` | uuid not null | one per row, generated by the form; `unique (school_id, client_key)`; a conflict with an **identical** `(charge_id, amount, method)` returns the existing row, a different payload raises `client_key_reused` |
| `voided_at`, `voided_by` | timestamptz / uuid | reason in `activity_log.reason` |

One payment is linked to exactly one charge, as the brief says. A single transfer covering two charges is recorded as two rows by `record_payments(rows[], method, paid_at, note)` in one transaction. Overpayment is refused; credit balances are not a v1 feature (question Q4 in §9).

**`whatsapp_templates`** (§15): `key text`, `language text`, `body text`, `updated_by`; `unique (school_id, key, language)`. Keys and their consumers: `payment_reminder` (unpaid list, student page), `student_invite` (invite button), `session_cancelled` and `session_changed` (session "WhatsApp expected attendees" after a cancel or move), `session_reminder` (the same action on an unchanged session), `extra_charge` (guest detail and extra-session charges). Seeded in both languages at school creation; placeholders validated at save time.

### 3.8 Operations

**`activity_log`** (§11) — append-only, written by one trigger on every business table

| Column | Type | Notes |
|---|---|---|
| `id` | bigint identity | |
| `school_id` | uuid not null | |
| `actor_kind` | text `check in ('admin','student','system')` | |
| `actor_user_id`, `actor_name` | uuid / text | name snapshotted (survives account deletion) |
| `actor_label` | text | system jobs: `cron`, `seed`, `trigger:auth`; an admin-triggered job carries `actor_kind = 'admin'` with the admin's id |
| `event` | text not null | semantic key set by RPCs (`payment.recorded`, `checkin.removed`, `person.approved`), default `<table>.<op>` |
| `action` | text `check in ('insert','update','delete')` | |
| `entity_type`, `entity_id` | text / uuid | |
| `subject_person_id` | uuid → people on delete set null | §11 "filter by student" |
| `before`, `after`, `changed_keys` | jsonb / jsonb / text[] | redacted (`token_hash`, `updated_at`) |
| `reason` | text | from `app.reason` (charge edits, voids, check-in removals, attendee removals) |
| `txid` | bigint | groups rows written by one action (bulk charges, review confirm) |

Indexes: `(school_id, created_at desc)`, `(school_id, subject_person_id, created_at desc)`, `(school_id, actor_user_id, created_at desc)`, `(school_id, entity_type, entity_id)`. Human-readable lines are rendered by the app from `event + after + subject + reason` in the reader's language; the sentence is not stored.

**`job_runs`** — idempotency ledger for every scheduled job: `job text` (`tick`, `materialize_sessions`, `monthly_charges`), `school_id` (null for `tick`), `period_key text` (`2026-09` for the monthly run, the local date for materialisation, the UTC hour for the tick), `status job_status`, `started_at`, `finished_at`, `summary jsonb`, `error text`; partial `unique (job, school_id, period_key) where status <> 'failed'` is the claim; a `running` row older than 15 minutes is treated as crashed and reclaimed.

**Schema `private`** (not exposed through the API): RLS helper functions, `local_date(school_id)` / `local_now(school_id)`, trigger functions, `school_creation_allowlist (email citext pk)`.

**Views** (all `with (security_invoker = true)`, so the caller's RLS applies): `v_agenda_sessions` (session + category/location names + expected/checked-in/attended counts), `v_unreviewed_sessions`, `v_counted_attendances` (the attendance predicates, single definition), `v_person_month_status` (worst charge status and open amount per person and period), `v_people_needing_monthly_charge` (active this local month, enrolled today, no live monthly charge, period ≥ `billing_start_period`).

## 4. Access model (RLS, grants, RPCs)

### 4.1 Helpers

All in `private`, `language sql stable security definer set search_path = ''`, owned by `postgres`, `execute` granted to `authenticated` only. The three set-returning helpers take no arguments, so `school_id in (select private.admin_school_ids())` plans as a one-time InitPlan per statement, and because they bypass RLS on `memberships` there is no policy recursion (no `force row level security` on `memberships` or `people`).

```sql
private.admin_school_ids()      -- schools where I am owner/admin with an active membership, school not suspended
private.member_school_ids()     -- schools where I have any active membership, school not suspended
private.my_person_ids()         -- my people rows in those schools
private.is_owner_of(school)     -- owner check for the Team page
private.assert_admin(school)    -- raises 'forbidden' unless school in admin_school_ids(); first statement of every admin RPC
private.assert_member(school)   -- same for members
private.local_date(school)      -- (now() at time zone schools.timezone)::date
private.local_now(school)       -- now() at time zone schools.timezone
```

Every business table has an index whose leading column is `school_id`. A migration lint fails on `current_date`, `now()::date` or `date_trunc('month', now())` anywhere in `supabase/migrations`, and on any `security definer` function in `public` that does not call `assert_admin`, `assert_member`, or is not on the explicit public/service allowlist.

### 4.2 Policy matrix

`anon` has no table policies at all; its only entry points are three public RPCs. Permissive policies OR together, so each table has at most one admin policy and one student policy. A **pending** student has only their own `memberships` row and `get_school_public`; the waiting card is built from those two.

| Table | Owner / admin (active membership) | Student (active membership) |
|---|---|---|
| `schools` | select; update the admin-updatable columns of §3.2 | select own school |
| `profiles` | select own + profiles of members of my schools; update own (`email` excluded) | select/update own (`email` excluded) |
| `memberships` | select school rows; writes via RPC only | select own rows (any status) |
| `invites` | select school rows (hash never selected by the app); writes via RPC | none |
| `people` | select/insert/update school rows (state-machine columns via RPC); no delete | select own row |
| `locations` | all (archive, not delete) | select school rows |
| `location_qr_tokens` | select; writes via RPC | none (lookup by RPC) |
| `categories` | all | select school rows (names, colours, limits, default prices) |
| `schedule_slots`, `combination_rules(+_categories)`, `whatsapp_templates`, `charge_batches`, `session_expected_categories` | all (`charge_batches` insert via RPC) | none |
| `class_sessions` | all except delete (cancel instead); side-effect columns via RPC | select sessions where I have a live attendee row |
| `session_attendees` | select; status/removal via RPC | select own rows |
| `check_ins` | select; insert/remove via RPC | select own rows |
| `student_categories` | all | select own rows |
| `price_overrides` | all | none (the student's live price comes from `get_my_pricing`) |
| `charges` | select; all writes via RPC | select own rows |
| `payments` | select; insert/void via RPC | select own rows |
| `activity_log`, `job_runs` | select school rows | none |

Grants: `authenticated` keeps table-level `select` everywhere (row scope by RLS; column-level select revokes are never used because they break `select *`; anything a student must not read lives on a table they cannot read at all, which is why admin remarks are activity-log reasons, override reasons stay on `price_overrides`, and QR tokens and invites have their own tables). Writes are narrowed with column-level `revoke insert/update` for state-machine columns (`people.status/user_id/kind/activated_at/deactivated_at/merged_into_person_id`, `class_sessions.slot_id/slot_date/starts_at/ends_at/status/cancel*/override*/moved_from/reviewed_*`, `session_attendees.status/removed_*/checked_in_at/attendance_source/charge_id/source`, `combination_rules.categories_key`) and `revoke insert, update, delete` entirely on `memberships`, `invites`, `check_ins`, `charges`, `payments`, `activity_log`, `job_runs`, `location_qr_tokens`. `school_id` is immutable everywhere (revoke + `forbid_school_change` trigger, because grants do not apply inside security-definer functions).

Hardening on every security-definer function: `set search_path = ''` with qualified names, `revoke execute from public, anon` right after creation (Postgres grants execute to public by default), `assert_admin`/`assert_member` as the first statement with the school derived from the entity id (never from a client-supplied `school_id`), and the tenant sweep calls every RPC with a foreign id in every id-typed parameter expecting `not_found` or `forbidden`.

### 4.3 RPCs (security definer, in `public`)

| Audience | Functions |
|---|---|
| `anon` + `authenticated` | `get_school_public(slug)` → name, language, join_enabled, suspended; `get_invite_public(token)` → school name, role, state; `get_checkin_public(token)` → school name, slug, join_enabled |
| `authenticated` | `join_school(slug, full_name, phone, language)`, `accept_invite(token)`, `checkin(token, session_id?)`, `update_my_contact(full_name, phone)` (writes every linked `people` row and `profiles.phone`), `get_my_pricing(school)` → the engine input for the caller only (active enrollments with prices and limits, applicable active rules with labels and prices, active override amount without its reason), `can_create_school()`, `create_school(...)` (allowlisted email) |
| admins | people: `create_invite`, `revoke_invite`, `approve_student(person, categories[], override?)`, `approve_as_existing(pending, existing)`, `reject_registration`, `deactivate_person`, `reactivate_person`, `unlink_person_user` (also sets the student membership inactive), `convert_guest_to_student`, `find_possible_duplicates`, `set_membership_status`; agenda: `duplicate_slot`, `end_slot`, `find_slot_overlaps`, `find_session_overlaps`, `create_single_session`, `create_extra_session`, `duplicate_session` (copies kind, category, location or address, title, extra type, price, charge mode, counts flag and expected-category links to a new date/time; `slot_id` null; status scheduled), `cancel_session`, `uncancel_session`, `move_session`, `revert_session_to_pattern`, `delete_session` (pristine only), `add_attendee`, `add_guest_attendee`, `remove_attendee`, `add_expected_category`, `remove_expected_category`; door and review: `admin_checkin`, `remove_checkin`, `set_attendee_status`, `mark_checked_in_attended`, `mark_session_reviewed`, `unmark_session_reviewed`; money: `create_first_month_charge`, `update_charge(charge, expected_updated_at, amount_due?, due_date?, description?, reason)`, `void_charge`, `unvoid_charge`, `create_one_off_charges`, `confirm_session_charges`, `record_payments`, `void_payment`; locations: `rotate_location_qr`; account: `sign out everywhere` is a server action (`signOut({scope:'global'})`), not an RPC |
| service role only | `claim_job_run(job, school?, period_key)` → run id, `finish_job_run(run_id, status, summary)`, `materialize_sessions(school, run_id?)`, `recompute_expected_school(school)`, `insert_monthly_charges(run_id, rows)` |

Single-row edits of admin-owned reference data (a category's price, a slot's time, a session note) are plain updates under RLS and column grants; the activity trigger logs them like everything else. Multi-row or state-machine writes are RPCs so they are atomic and carry `app.event` / `app.reason` for the log.

### 4.4 Application-side boundaries

- Server components and server actions use the **user's session** (cookie → anon key → RLS). Every server action is declared through one `defineAction({access, schema, handler, revalidate})` wrapper (role check for the slug, zod parse, Postgres error key → i18n key, `revalidatePath`); a lint rule fails on a bare exported action.
- The **service-role key** is read by exactly one file (`src/lib/supabase/service.ts`, `server-only`) and importable only from `src/server/jobs/**`, `src/app/api/cron/**` and `scripts/**` (lint rule); CI greps the build output for it. Jobs (`src/server/jobs/*`) are the only code that runs with it: the cron route calls them with `app.actor_label = 'cron'`; the Settings buttons "Generate charges for {month} now" and "Rebuild expected lists" are server actions that verify admin membership for the slug, then call the same job functions with `app.actor_kind = 'admin'` and `app.actor_user_id = <uid>`. No RPC ever accepts client-supplied charge rows. The activity trigger **raises** on a write with no `auth.uid()` and no `app.actor_label`, so an accidental service-role write elsewhere fails instead of being logged as "system"; when both exist, `auth.uid()` wins.
- Every app URL is scoped by school slug: `/{slug}/...` for admins, `/{slug}/me/...` for students. The `[slug]` layout looks up the caller's membership row for that school: `active` → the app (admin or student shell by role); `pending` → the waiting card; `inactive` or none → 404 (not 403). A suspended school renders a "suspended" page for everyone (from `get_school_public`). This honours §4 "several schools" now: two schools can be open in two tabs with no server-side "current school".
- Public URLs never carry a locale or a school id: `/checkin/{token}` (printed), `/join/{slug}` (flyers), `/invite/{token}` (WhatsApp).

## 5. Key mechanisms

### 5.1 Pricing engine (§6)

`priceStudent(input): PricingResult` in `src/lib/domain/pricing/engine.ts`, pure, no I/O.

Input: `asOf` (local date), the student's enrollments active on `asOf` in **active** categories (with default prices and limits), all active rules of the school, and the override whose validity contains `asOf` (at most one, by constraint).

1. **Override** active on `asOf` → `amount = override.monthly_price`, `basis = override`; the result also carries `withoutOverride` (steps 2–3) so the UI can say "Override — would have been $60.000" (the admin UI adds the reason from `price_overrides`; the student sees only that an override applies).
2. **Best cover of rules.** A rule is *applicable* iff it is active, has ≥ 2 categories, and all of them are in the student's active set `A`. A *cover* is a set of applicable, pairwise-disjoint rules (the empty set included). Score: maximise the number of categories covered, then minimise the total (`Σ rule prices + Σ default prices of uncovered categories`), then fewest rules, then lexicographic rule ids (determinism). Exhaustive depth-first search over applicable rules sorted by size/price/id with disjointness pruning; a guard raises above 24 applicable rules. Uncovered categories add their default price (§6).
3. **Sum of defaults** of active categories; `basis = none` with amount 0 when there are none.

Output: `amount`, `defaultAmount` (steps 2–3 result, equal when no override), `basis` (`override | rules | sum | none`) with the applied rule/category ids and prices, `sumOfDefaults`, `engineVersion`. Explanation strings are rendered by the UI from ids through next-intl, using current names for a live price and the snapshot's labels for a historical charge.

The same function serves three places: the admin pricing card (inputs loaded under RLS), the monthly run (inputs loaded by the job), and the **student portal** through `get_my_pricing`, which returns the caller's own inputs so "my monthly price" is live even before the first charge exists or after a mid-month change; "this month's charge" is shown separately from the charge row.

Edge cases pinned by tests: a rule pricier than its categories separately still wins by coverage (§6 literal order; the rules screen warns at save time); two disjoint small rules beat one big cheaper rule if they cover more; rules sharing a category are mutually exclusive; archived categories never price and never enable a rule; zero-price categories count as covered; a student with no categories but an override; overlapping-rule ties resolved deterministically; property test: the chosen cover is always disjoint and applicable, and with discount-only rules the amount never exceeds the sum of defaults.

`previewRuleImpact(draft)` runs the engine for every active student with and without the draft rule and lists those whose amount or basis changes (§13 "preview which students it affects").

### 5.2 Monthly charges (§7)

- **When.** The hourly tick (5.15) computes each school's local date. If `period = date_trunc('month', local_date) >= billing_start_period` and no completed `job_runs` row exists for `(monthly_charges, school, period)`, `claim_job_run` takes the run (partial unique index; a stale `running` row is reclaimed after 15 minutes). The condition is "no completed run for this period", not "today is the 1st", so an outage on the 1st self-heals on the next tick; DST never matters. The Settings button "Generate charges for {month} now" runs the same job for the current or the previous period regardless of `billing_start_period` (that is how the creation month gets billed if you want it), harmless to press twice.
- **Who.** People with `kind = 'student'`, `status = 'active'`, whose `activated_at` local date is **on or before the first day of the period** (later activations go through the mid-month prompt even if the run is late), and with at least one enrollment active on the 1st in an active category **or** an override active on the 1st. People who already have a monthly charge for the period, live or voided, are skipped (a void is a decision; the mid-month path below can recreate a mistaken void by hand). Active students with nothing to charge are listed on the dashboard ("active, no categories").
- **How.** The job loads inputs and computes each amount with the engine **as of the 1st of the period** (enrollments and override active that day, prices as of the run), builds `pricing_snapshot`, `breakdown` and `due_date = period + payment_due_day − 1`, and calls `insert_monthly_charges(run_id, rows)` in batches of 50; each batch inserts in one transaction with `on conflict do nothing` on the monthly unique index and validates that every row belongs to the run's school. `finish_job_run` marks the run completed only after the last batch and only when the eligibility query returns nobody without a charge; otherwise it records `failed` with the error and the next tick retries (resumable by construction).
- **Mid-month join (§7).** Trigger condition: *active this local month, an enrollment active today, no live monthly charge for this period, period ≥ `billing_start_period`* (view `v_people_needing_monthly_charge`), which covers approvals, admin-created students, reactivations, enrollments starting today and a charge voided by mistake. The approval/activation flow ends with a prompt: full amount as of the join date, proportional suggestion (`prorate`), custom amount, or none. "None" creates a $0 charge with the reason, so the person leaves the to-do list and the decision is visible. Proration: calendar days including the join day (local date of `activated_at`), `floor((2·full·days + D) / (2·D))` (half-up, integers only), stored in `proration`.
- **Changes during the month.** Never rewrite the existing charge. The student page shows "September was calculated with X; today's price would be Y" with one-tap "use new amount" (a logged edit with reason) or keep. Deactivation mid-month leaves the charge; the dialog offers keep / prorate / void (void only if unpaid).
- **Edits.** `update_charge` requires a reason and `expected_updated_at` (optimistic concurrency) and refuses void charges. `default_amount` and the snapshot never change, so "what the system calculated" is always visible next to the edits. Voiding frees the unique slot; to gift a month, set the amount to 0 instead.

### 5.3 One-off charges (§8)

`create_one_off_charges({client_key, target, amount, due_date, period?, description})`: target = one person or one or more categories. Always creates a `charge_batches` row; a retry with the same `client_key` returns the existing batch and its charges. Recipients for categories: active students with an enrollment active today in any of them, deduplicated. The screen previews names, count and total before writing; the write is one transaction, per-row `on conflict do nothing` on `(batch_id, person_id)`. `period` defaults to the month of `due_date`.

### 5.4 Extra-session charging (§9b)

`confirm_session_charges(session, rows, mark_reviewed)` runs on any non-cancelled session whose start time has passed. When `mark_reviewed` is true it applies `mark_session_reviewed` **first**, and the preview the teacher saw was computed against those post-review statuses, so what is shown is what is written. `previewSessionCharges(session, attendees, existingCharges)` (pure TS) returns one row per attendee with `willCharge`, `reason`, `amount`:
- `price is null or charge_mode = 'none'` → nothing (button disabled).
- `charge_mode = 'attended'` → `status = 'attended'`.
- `charge_mode = 'signed_up'` → status in (`expected`, `attended`, `absent`); `excused` is the teacher's explicit waiver.
- Anyone whose `charge_id` points to a live charge → skipped, "already charged" (§9b never double charge; the partial unique index is the guarantee).
- Guests are rows like any other. The admin can uncheck a row or edit its amount before confirming.

The RPC inserts `one_off` / `extra_session` charges with `period = month of the session`, `due_date = session date`, sets `session_attendees.charge_id`, in one transaction. Re-running charges only people added since. Changing the price afterwards never touches existing charges; marking someone absent after charging shows "charged but absent — void?".

### 5.5 Payments and status (§5)

`record_payments(rows[{charge_id, amount, client_key}], method, paid_at, note)` in one transaction: each amount ≤ the charge's open amount (`amount_due − paid_total`) or `payment_exceeds_open_amount`; void charges refused (`charge_void`); `recorded_by = auth.uid()`; per-row `client_key` semantics as in §3.7. The Payments screen lists the person's open charges oldest due first and lets the admin split one transfer across them. `void_payment(payment, reason)`; amounts are immutable, method/date/note editable. `paid_total` is recomputed from scratch by trigger on every payment insert/void; `status` is a stored generated column: `void` / `paid` (`paid_total >= amount_due`, so a $0 charge is paid) / `partial` / `unpaid`. A CI check re-derives every `paid_total` and fails on drift.

Person-level status for a month (§12.2, §13 filter, §14, the §9 reminder): `v_person_month_status` = worst status over live charges of that period (`unpaid > partial > paid`), open amount, earliest due date → days overdue (school-local today).

### 5.6 Session generation and edits (§5, §9b)

- **Time model.** Slots and sessions store wall-clock (`weekday`/`date`, `start_time`, `end_time`); `starts_at`/`ends_at` are derived per date by trigger through the school timezone, so a 19:00 class stays 19:00 across Chile's DST changes (pinned by tests on the 2026 transition dates). A timezone change recomputes future sessions only. Every date/time shown is formatted in the school timezone, never the device's.
- **`materialize_sessions(school, run_id?)`** (SQL, idempotent): for each active slot of an active category, generate occurrences from `greatest(local_date, valid_from)` to `least(valid_until, local_date + 12 weeks)` and insert `on conflict (slot_id, slot_date) do nothing`. Horizon 12 weeks (brief: at least 8), extended on demand up to 52 when the agenda is opened further ahead (the page calls the job for that range). Called by the tick (per-school ledger row per local day; an advisory lock per school serialises it with the slot trigger) and immediately by the trigger on slot insert/update. No backfill of past dates in v1.
- **Pattern edits apply to future sessions only.** Future = `starts_at > now()`. Trigger `sync_slot_sessions` on slot update: time/location changes propagate to future occurrences whose `override_time`/`override_location` is false; category change propagates and recomputes expected lists; validity shrink or `active = false` hard-deletes *pristine* future occurrences (definition in §3.5) and cancels the rest with reason `pattern_ended`; validity extension fills gaps. `weekday` is immutable (move = end + duplicate). Deleting a slot is refused once any occurrence has been held or touched (`end_slot` instead).
- **Per-session edits** (`cancel_session` with reason, `move_session` to another time/location/date for that date only, note) set the override flags and `moved_from`; `slot_date` never changes, so regeneration cannot recreate the original occurrence or duplicate the moved one. `cancelled` wins as status; overrides survive underneath so `uncancel_session` restores `moved`.
- **Overlap warning** (§9b): `find_slot_overlaps` / `find_session_overlaps` (same location, half-open time ranges, overlapping validity); the form asks "save anyway?". Different locations never warn.
- **Duplicate** (§9b): `duplicate_slot(slot, weekday, start, end?, location?, category?)` and `duplicate_session` (contract in §4.3); "duplicate a whole day" loops the former.

### 5.7 Expected attendees (§9b)

Materialised rows in `session_attendees`, kept right by **one idempotent function** `recompute_expected(session_ids[])`: for each *future* session, the set that *should* be expected = active students with an enrollment valid on the session's date in any of the session's expected categories (a regular session's own category ∪ `session_expected_categories`). Insert missing rows as `auto` (`on conflict do nothing`, so manual rows, walk-ins and tombstones win); delete `auto` rows that are still untouched (`expected`, no check-in, no charge, not removed) and no longer in the set. Held sessions are frozen history, edited only by review.

Triggers call it on: session insert (statement-level), session category/date change, expected-category link changes, enrollment insert/update/delete (both old and new category), person status change, category archive. The tick calls `recompute_expected_school` for each school as a safety net.

Manual control: `add_attendee` (upsert; clears a tombstone), `add_guest_attendee(name, phone)` (creates the guest and the row), `remove_attendee` (tombstone; refused while the person has a valid check-in or a live charge for that session; the tombstone survives enrollment churn), category links on extras are live until start ("via Comp Team A" shown per row).

### 5.8 QR check-in (§9)

`/checkin/[token]` requires a session; the proxy redirects to `/login?next=/checkin/{token}` and the magic-link and Google callbacks carry `next` through (validated by `safeNext`: same-origin path only). Signed in, the page calls **one** RPC, `checkin(token, session_id?)`, which returns result codes rather than raising so every outcome is one round trip:

1. Token → active `location_qr_tokens` row → school and location (`invalid_token` otherwise).
2. The caller must have an active student `people` row in that school (`not_member`, `pending`, `inactive` results render friendly messages; `not_member` offers the join link when enabled).
3. Candidates = sessions at that location with `qr_checkin` (rehearsals are never matched), `status <> 'cancelled'`, `now()` within `[starts_at − window_before, ends_at + window_after]` (school settings), and for **extras** only if the caller has a live attendee row (§9 "for students who are on the expected list"). Regular sessions accept any active student; enrollment is a flag, not a gate.
4. One candidate → insert `check_ins` (`qr`, `qr_token_id`, `created_by`) `on conflict do nothing` on the valid-per-session index; a conflict returns `already_checked_in` with the original time. Several → `choose` list (enrolled class first, "in progress" vs "starts in N min"); the second call re-derives candidates instead of trusting the client. None → `no_session` with the next session at that location.
5. The response includes `unpaid_period` (current local month's status) so the confirmation shows the reminder; nothing blocks an unpaid student.

The window match lives only in this SQL function (tested in `tests/db` at the exact boundaries); the TS helper that says "starts in 12 min" is display-only. A trigger on `check_ins` keeps `session_attendees` consistent: ensures a row exists (`auto` if enrolled on that date, else `walk_in`; a tombstoned row is revived as `walk_in`) and refreshes the `checked_in_at`/`attendance_source` caches from the valid row. A check-in never sets `attended` by itself.

Admin corrections: `admin_checkin(session, person)` (no window; guests included), `remove_checkin(check_in, reason)` (`valid → removed`, reason to the log; a walk-in row with no remaining check-in is tombstoned, an `attended` row becomes `absent`). The session screen polls every 10 s while open (Realtime is a contained upgrade later).

Speed: proxy + one RPC + a static confirmation; the 5-second target (§19) is measured on a warm session in the E2E suite. A first-ever scan includes the email round trip and cannot meet it; sessions never expire, so that happens once per phone.

### 5.9 Post-class review (§9b)

One session screen with two modes: **live** until `ends_at` (expected list with check-in badges, manual check-in, remove, add person, WhatsApp, cancel/move/note) and **review** from the start time (three-way control per row, walk-ins marked "checked in, not expected", "via {category}" on auto rows, add person or new guest as attended, remove wrong check-in, charge preview). RPCs: `set_attendee_status`, `mark_checked_in_attended(session)` (the one tap), `mark_session_reviewed(session)` (check-ins → `attended`, remaining `expected` → `absent`, `excused` is always explicit; idempotent), `unmark_session_reviewed`. Everything stays editable afterwards and every change is a logged RPC. The dashboard to-do lists unreviewed past sessions with `qr_checkin` (rehearsals are never nagged about; their review stays available for a teacher who wants to record who came) (last 30 days expanded, older collapsed behind a count) with inline "nobody came" and "mark checked-in attended + reviewed".

### 5.10 Overuse and unenrolled flags (§9)

Single definition of the predicates in `v_counted_attendances`; aggregation and rules in pure TS `computeWeeklyFlags` (unit-tested reference, §19). The rules follow your clarification that rehearsals are not tracked at the door while a team fee may include weekly classes that are.

- **Attendance** = live attendee row at a non-cancelled session with `status = 'attended'`, or `status = 'expected'` with a valid check-in (unreviewed sessions count; a review verdict of absent/excused wins over a lingering check-in).
- **Counts toward the allowance** iff the session's `counts_toward_limit` is true. Defaults: regular sessions of tracked (`qr`) categories true; sessions of rehearsal-type categories and all extras false; the teacher flips it per session (a free extra rehearsal he wants to count, a class he wants to gift).
- **Week** = Monday–Sunday of the session's local `date` (never the check-in instant).
- **Allowance** for a student and week = over the categories whose enrollment overlaps the week: **unlimited** if any has `classes_per_week_included = null`; otherwise the **sum** ("Friday 2x" → 2, "Comp Team A, 1 class included" → 1, "Show Group B, 0 included" → 0). A student with no categories has no allowance.
- **Overuse** = the allowance is a finite number greater than 0 and counted attendances exceed it. Attendances at tracked classes the student is not enrolled in **do** count (a "Friday 2x" student who slips into Partnerwork has used a third class, exactly §1's case; a team member with one class included who attends two is over).
- **Class access** (for the second flag) = the student is enrolled in the session's category on that date, **or** has an active rehearsal-type category whose fee includes classes (`classes_per_week_included` > 0 or unlimited): a team fee that includes weekly classes opens **any** tracked class (question Q14).
- **Unenrolled** = per attendance at a tracked regular session without class access. Rows the teacher added by hand (`manual`) are excluded and shown as "added by you" in the evidence instead (question Q9f); walk-ins and auto rows whose enrollment ended are flagged. Extras and rehearsals never raise it.
- Both flags carry their evidence ("3 of 2: Fri 19:00, Sat 11:00, Tue 20:00 Partnerwork — not enrolled"). Nothing is persisted, so flipping a session's toggle or editing a review is reflected immediately. Dashboard = current week; student detail = last 12 weeks.

### 5.11 Activity log (§11)

One security-definer trigger function `log_activity()` installed as `00_log_activity after insert or update or delete for each row` on every business table (named so it fires before any other trigger on the same event; a CI check asserts no table is missing it). It resolves the actor (`auth.uid()` → membership role → `admin`/`student`, name snapshotted; no uid → `app.actor_kind`/`app.actor_user_id` set by an admin-triggered job, else `app.actor_label` (`cron`, `seed`, `trigger:auth` for the sign-up and email-cache triggers), else raise), the school (`school_id` of the row), the subject person (table-specific column), the event key (`app.event` set by RPCs, else `<table>.<op>`), the reason (`app.reason`), redacts secrets, skips no-op updates. Noise control: `materialize_sessions`, `sync_slot_sessions` and `recompute_expected` set `app.system_op` with `set_config(..., true)` and **restore the previous value before returning**; while it is set, inserts and deletes of pristine derived rows are not logged; every human action and every sync-caused cancellation is. A test asserts one slot edit produces exactly one log row for the slot. Student actions are logged with `actor_kind = 'student'`; the screen defaults to admins.

### 5.12 Income split (§12.4)

`charges.breakdown` allocates `default_amount` to `(category_id, location_id)` at creation: defaults → one entry per category at its price; rules → the rule price split across its categories proportionally to their default prices (equal split if all zero) with largest-remainder rounding; override → the without-override breakdown rescaled; one-offs → the batch's attribution category or "one-off"; extra sessions → the session's category/location or "extras". The dashboard scales each charge's entries to `amount_due` (expected) and `paid_total` (received) in TS and groups by location and category, with "no location" / "one-off" / "extras" buckets. A second line "cash received this month" sums payments by `paid_at` in the school's local month.

### 5.13 Onboarding (§10)

- **Admin creates** a student (name, phone with the school's default country, optional email, categories, language): `status = 'active'` immediately (chargeable and expected whether or not they ever log in). "Invitar" → `create_invite` returns the link once; copy or WhatsApp (`student_invite` template). `/invite/[token]` → sign in → "Vas a unirte a {school} como {name}. ¿Eres tú?" → `accept_invite` links `people.user_id`, fills the contact email and phone if empty, creates the student membership with the person's status. Forwarded-link defence: the name confirmation, single use, 30-day expiry, 192-bit token, `person_already_linked` for a second taker, admin `unlink_person_user`.
- **Self-registration**: `/join/{slug}` → sign in first (magic link 6-digit code + link, or Google) → name and phone → `join_school` **always** creates a `pending` person and membership (an admin-typed contact email is never treated as proof of identity, so nothing is linked silently). Pending students see a waiting card, cannot check in, and appear as a dashboard badge. The approval screen shows possible duplicates (same E.164 phone, same email, similar name) with "approve as new" (`approve_student` with categories and optional override, then the first-month prompt) or "same person as X" (`approve_as_existing`, which links the login onto the existing record and marks the pending row merged). `reject_registration` keeps the row inactive for the audit trail.
- **Admin invites** are email-bound: acceptance requires the login email to match. Admins may invite and deactivate other admins; only the owner row is protected. Deactivating a membership takes effect on the person's next request (no roles in tokens); "sign out everywhere" is available to every user in their settings.
- **Guest → student**: `convert_guest_to_student(person, email?, categories[])` is a status change on the same row; every attendee, check-in and charge stays attached.
- **First school**: `/onboarding` → `create_school` for a signed-in user whose email is in `private.school_creation_allowlist` (seeded with yours). The same function becomes the multi-school signup once billing exists (§17).

### 5.14 WhatsApp, i18n, formatting, PWA

- **WhatsApp (§15)**: `waLink(e164, text)` = `https://wa.me/{digits}?text={encoded}`; `renderTemplate(body, vars, {locale, currency, timeZone})` is pure, validates placeholders at save time, formats `{amount}` and `{month}` in the recipient's effective language (§3.3 rule). Multi-person actions are one button per person with a tick once tapped (not persisted).
- **Phones**: stored E.164 only (CHECK), parsed with `libphonenumber-js` using `schools.default_country`, echoed before save, re-parsed server-side, displayed nationally.
- **i18n (§16)**: next-intl **without URL routing**; locale from `cs_locale` cookie ← profile preference ← school default (public pages) ← `Accept-Language` ← `es`. Toggle on every page updates the profile and the cookie. `messages/es.json` canonical, `en.json` checked for key and ICU-placeholder parity in CI; typed keys; every Postgres enum value has an `enums.*` key (test); `no-literal-string` lint on `src/app` and `src/components`; database errors are snake_case keys mapped to `errors.*`. The Supabase sign-in email is one template per project, so it is **bilingual** (Spanish block, then English) with the 6-digit code at the top.
- **Formatting**: one module `src/lib/format.ts` (`Intl` with explicit locale, currency and school timezone: `$45.000` in es, `$45,000` in en for CLP); `toLocale*` and bare `Intl` banned elsewhere by lint; `date-fns` + `@date-fns/tz` for local-day arithmetic; DST fixtures in tests.
- **PWA (§2)**: `manifest.ts`, icons (192, 512, maskable, apple-touch), hand-written `public/sw.js`: static assets cache-first, navigations network-only with an `/offline` page, **no HTML ever cached** (shared phones), cache name per build, "new version" toast. No push, no offline queue. Install card for admins; optional for students (iOS installed PWA has its own cookie jar, so the 6-digit code flow is the answer there).

### 5.15 Jobs, security, operations

- **Tick**: `GET|POST /api/cron/tick`, `Authorization: Bearer $CRON_SECRET` (constant-time compare, 401 with no body, inert on previews without the secret), `maxDuration 300`, service client, `app.actor_label = 'cron'`. It writes one `tick` ledger row per UTC hour (so the "last successful run" badge has data from M1), then for each non-suspended school, in a `try/catch` per school: claim + `materialize_sessions` + `recompute_expected_school` + finish; claim + monthly charges (5.2) + finish. Scheduler: Vercel Cron `0 * * * *` (Pro) or `pg_cron` + `pg_net` calling the same route; the route does not care. Dashboard badge when the last successful tick is older than 3 hours; Settings shows the ledger.
- **Auth**: magic link (`token_hash` flow, verified on POST so link scanners cannot consume it, 6-digit code in the same email) + Google OAuth (PKCE); custom SMTP with SPF/DKIM/DMARC is a launch blocker (Supabase's built-in mailer only delivers to project members); no roles in JWT claims (revocation is immediate); `getUser()` on the server; sessions do not expire, and every user has "sign out everywhere" in their settings.
- **Abuse control (v1)**: sign-in-first on `/join`, Supabase Auth's own OTP send/verify limits, single-use high-entropy tokens (invites 192 bits, QR 128 bits), idempotent check-ins, and per-IP rate-limit rules at the edge (Vercel WAF, no code). An in-database throttle is deferred (§10).
- **Headers**: HSTS, `X-Content-Type-Options nosniff`, `X-Frame-Options DENY`, `Referrer-Policy strict-origin-when-cross-origin` (tokens in paths never reach `wa.me` or Google), `Permissions-Policy` off for camera etc., `robots.txt Disallow: /`. A nonce-based CSP is deferred (§10).
- **Environments**: local (Postgres or Supabase CLI), staging (own Supabase project, `main` → `staging.<domain>`), production (`production` branch, manual approval, `supabase db push` before the deploy hook). Supabase region `sa-east-1`, Vercel `gru1`. Secrets: the service key never has a `NEXT_PUBLIC_` prefix (CI grep); SMTP and Google secrets live only in the Supabase dashboard. Error reporting: Sentry (free tier, PII scrubbing) from M1 if Q12 is yes.

## 6. Folder structure

```
clave/                          (this repository, root replaced — see Q1)
├── .github/workflows/ci.yml, deploy.yml
├── docs/  SPEC.md · PLAN.md · testing/milestone-N.md (hand-test scripts)
├── DECISIONS.md · README.md · .env.example · vercel.json · components.json
├── messages/  es.json (canonical) · en.json
├── public/    icons/ · sw.js · robots.txt
├── scripts/   seed.ts · bootstrap-school.ts · i18n-check.ts · check-build.ts (secrets + hardcoded names) · db/ (Docker-less migration runner + auth shim)
├── supabase/
│   ├── config.toml
│   ├── migrations/            forward-only, one concern per file (extensions, private schema, activity_log, schools/profiles/memberships,
│   │                          people, catalogue, schedule+sessions, attendance, pricing, money, jobs+templates, rls+grants, rpc_*)
│   ├── seed/*.sql             demo school + isolation-control school, relative dates; runs as postgres with app.actor_label = 'seed'
│   └── tests/fixtures/        JSON fixtures shared by Vitest and the database tests (breakdown split, occurrences)
├── tests/
│   ├── db/                    Vitest + pg: RLS matrix, composite-FK refusals, trigger and RPC contracts, window boundaries, run-twice idempotency
│   ├── stack/                 Vitest + supabase-js (tenant sweep, RPC sweep with foreign ids); needs the Supabase CLI stack (CI only)
│   └── e2e/                   Playwright, mobile viewport; needs the stack (CI only)
└── src/
    ├── app/
    │   ├── layout.tsx · page.tsx (root resolver) · manifest.ts · globals.css · error/not-found
    │   ├── (public)/login · join/[slug] · invite/[token] · legal/{privacy,terms} · offline
    │   ├── auth/{confirm,callback,signout}/route.ts
    │   ├── checkin/[token]/                      printed URL, outside every group
    │   ├── onboarding · schools · welcome
    │   ├── (app)/[slug]/layout.tsx               membership gate (active → app, pending → waiting card, else 404), SchoolProvider
    │   │   ├── (admin)/ page (dashboard) · students · categories · rules · guests · team · activity · payments · charges
    │   │   │            · locations/[id]/print (QR page with print CSS) · schedule · agenda · agenda/sessions/[id] · settings/{general,templates,jobs}
    │   │   └── me/      page (today's expected sessions + check-in state + "scan the door QR") · categories · payments · attendance · agenda · settings
    │   └── api/cron/tick/route.ts · api/health/route.ts
    ├── components/  ui (shadcn) · layout · forms (MoneyInput, PhoneInput, DateField) · money · agenda · students · checkin · activity · whatsapp
    ├── lib/
    │   ├── domain/     PURE, no I/O, 100 % covered: money/ · pricing/ (engine, proration, breakdown) · overuse/ · charges/ (status, session-charges preview)
    │   │               · activity/ (describe) · agenda/display.ts (display-only helpers, explicitly not the authority)
    │   ├── supabase/   types.ts (generated) · browser.ts · server.ts · proxy.ts · service.ts (server-only, import-restricted)
    │   ├── format.ts · phone.ts · whatsapp.ts · safe-next.ts · dates.ts · validation/ (zod schemas shared by forms and actions)
    ├── server/  action.ts (defineAction) · school-context.ts · queries/ (read models per page) · people/ · invites/ · pricing/ · charges/
    │            · payments/ · sessions/ · attendance/ · jobs/ (tick, materialize, monthly-charges; the only service-client callers)
    ├── i18n/request.ts · resolve.ts
    └── proxy.ts  (Next 16 name for middleware: session refresh, locale cookie)
```

Toolchain (pinned in `package.json`): Node 22, pnpm 10, Next.js 16 / React 19, TypeScript strict (`noUncheckedIndexedAccess`), Tailwind CSS 4, shadcn/ui, next-intl 4, Vitest, Playwright, `zod`, `react-hook-form`, `date-fns` + `@date-fns/tz`, `libphonenumber-js`, `qrcode` (SVG), `supabase` CLI as a devDependency.

## 7. Testing strategy (§19)

| Layer | Tool | Proves | Runs | Gate |
|---|---|---|---|---|
| Pure domain | Vitest + `fast-check` | §6 priority order and best cover on hand cases and 200+ generated combinations; proration for 28–31-day months; overuse across ISO weeks in `America/Santiago` including both DST changes; session-charge preview never double charges; breakdown split sums exactly; activity keys for every event; formatting in both locales | everywhere | 100 % line and branch coverage of `src/lib/domain` |
| Database (`tests/db`) | Vitest + `pg` against a real Postgres; each test runs under `set local role authenticated; set local request.jwt.claims` from a **non-superuser** connection | the **RLS matrix** for every table × {admin A, student A, student B, admin B, pending student, anon} (§19: a student never reads another student's data; school A never sees school B); no policy recursion; composite FKs refuse mixed tenants; the activity trigger logs before/after, refuses actorless writes, logs exactly one row per slot edit; owner protection; every RPC's error keys; the `checkin` window at its exact boundaries, cancelled excluded, moved found at its new time; `materialize_sessions` and `insert_monthly_charges` run twice = same rows; `client_key` replay and reuse; migration lint (RLS + log trigger on every table, `search_path` and assert calls in every security-definer function, no `current_date`) | everywhere (Supabase CLI stack, or plain Postgres 16 with the `auth` shim: roles `anon`/`authenticated`/`service_role`, `auth.uid()`, `auth.jwt()`, `auth.email()`, `auth.users(id, email, raw_user_meta_data)`) | required |
| Stack (`tests/stack`) | Vitest + two `supabase-js` clients (test users created with passwords through the admin API) | the **tenant sweep**: a `TABLES` constant typed against the generated `Database` type (a new table cannot be forgotten) read with student B's client must return zero rows of school A; every RPC called with a foreign id in every id-typed parameter returns `not_found`/`forbidden` | GitHub CI with the Supabase CLI stack (Docker) | required in CI |
| End to end (`tests/e2e`) | Playwright, iPhone viewport, magic links read from the CLI stack's mail catcher | sign in, scan → confirmation timing on a warm session, record a payment, review a session, approve a pending student | GitHub CI | required in CI, kept to five flows |
| Manual | `docs/testing/milestone-N.md` | your hand test after each milestone on staging | | milestone sign-off |

Why database tests are TypeScript rather than pgTAP: one runner for everything, and the same files run against the Supabase CLI stack (GitHub CI, your laptop) and against a plain PostgreSQL 16 with the `auth` shim, which is what is available in the cloud environment this plan was written in (Postgres 16 installed, **no Docker**, so `supabase start` cannot run there). Migrations are applied there by a small psql runner (`scripts/db`); the Supabase CLI remains the tool everywhere else. Suites that need PostgREST or GoTrue (`tests/stack`, `tests/e2e`) are tagged and run only in CI. See question Q11.

## 8. Milestones (§18)

The nine milestones keep the brief's order. Four things are pulled forward because later milestones cannot be hand-tested without them: the full core schema, RLS and the activity trigger (M1, also what §18.1's seed of "categories, rules, 20 students" literally requires); the cron transport and job ledger (M1, needed by session generation in M4); a minimal Settings page and a bare activity list (M1); the Team page and the WhatsApp link helper (M3, needed by invites). Each milestone is merged to `main`, pushed to staging with seed data dated relative to today, and closed with your sign-off on its test script. Staging is reset at the start of each milestone; production stays empty until M9 (question Q10).

Seed mechanism: `supabase/seed/*.sql` runs as `postgres` with `app.actor_label = 'seed'`. Reference data and people are direct inserts (including pending, linked and inactive students, so M1 needs no M3 RPCs); from M4 the seed calls `materialize_sessions`, and from M6 `insert_monthly_charges`, so derived data is produced by the same code the app uses. Relative dates everywhere (`db reset` on any day gives "today's classes" and "unpaid this month").

**M1 — Foundation.** Repo reset (Q1) and scaffold; all migrations for the core schema, `private` helpers (including `local_date`, `assert_admin`), RLS policies and grants, activity trigger, `job_runs`, `claim_job_run`/`finish_job_run`; auth (magic link with bilingual email + Google) with `next` handling; root resolver, `[slug]` layout with the three-way membership gate, empty admin and student shells, waiting card; next-intl skeleton, `format.ts`, language toggle, lint rules; `settings/general` (all §3 settings, both windows, default country, billing start); bare activity list; `/api/cron/tick` with secret check writing its `tick` ledger row; seed with two schools (demo + isolation control), owner, admin, 20 students (some without login, some pending, some inactive), 3 guests, 2 locations with active QR tokens, categories (classes plus a rehearsal-type competition team that includes one weekly class), rules, override, enrollments; CI; staging deployment; Sentry (Q12); README and DECISIONS.
*You can test:* magic link and Google sign-in on your phone; language toggle persists; a student URL of the other school is 404; a seeded pending student sees the waiting card; editing a setting produces an activity row with your name and before/after; the tick returns 401 without the secret and a ledger row with it; the PR shows the RLS matrix green.

**M2 — Pricing catalogue and engine.** `src/lib/domain/{money,pricing}` with the full test suite; Categories (create, edit, archive, price, limit, colour, location); Rules (pick ≥ 2 categories + price, "affects N students" preview, duplicate-set refusal, pricier-than-parts warning); a read-only student list and the student **pricing card** (active categories, amount, explanation, "default would have been") with the override editor (the one write of this milestone).
*You can test:* the scenarios of §6 on seeded students, including an override and a rule price change; every edit in the activity list; `pnpm test` shows the pricing suite.

**M3 — Students, invites, self-registration, approval, team.** People CRUD (E.164 phones, language, note, enrollment history with dates), search and filters (location, category, kind incl. guests; payment status arrives in M6), deactivate/reactivate; invites with copy-link and WhatsApp buttons; `/invite/[token]` with the "¿eres tú?" step; `/join/{slug}` → pending → approval with duplicate hints, "same person as X", categories, optional override; reject; dashboard badge; Team (invite admin by email, deactivate, owner protected); unlink; "sign out everywhere".
*You can test:* the full invite and join flows from a second phone or private window; approving a self-registration as an existing seeded student; the owner cannot be deactivated; a `demo` student URL is 404 while signed in to `otra`.

**M4 — Locations, schedule pattern, sessions, agenda, QR check-in.** Locations with a printable QR page (SVG + print stylesheet, school and location name); weekly grid per location with inline edit, duplicate, overlap warning, end/delete rules; `materialize_sessions` + tick job + immediate generation; slot → future sessions sync; agenda day/week/month (default day below the `md` breakpoint, week above; last view remembered per device) with filters and colours; session detail with cancel, move, note, single dated class, duplicate; `/checkin/[token]` for regular sessions with window, one/several/none, duplicates, pending/inactive/not-member states; admin live list with manual check-in and removal with reason (logged); seed adds a weekly pattern, generated sessions and check-ins on relative dates. The unpaid reminder branch exists but stays inert until M6.
*You can test:* build your real weekly pattern; cancel and move single dates; change a slot time and see only future untouched dates follow; scan the printed QR during a seeded session and get the confirmation in under 5 seconds; scan again; a seeded team rehearsal running at the same location and time is ignored by the QR; remove a check-in; run the tick twice with no change.

**M5 — Expected attendees, extra sessions, guests, review, flags.** Automatic expected lists and their sync; manual add/remove; extra sessions with the composer (categories, students, on-the-spot guests), price, charge mode, counts toggle; the extras-only-if-expected rule in `checkin`; Guests screen (list, detail with sessions and status, convert to student; charges tab arrives in M6); admin student detail gains the attendance history tab (sessions, verdict, check-in source, counted toward limit); the session screen's live and review modes with the one-tap action, walk-ins marked, "nobody came", mark reviewed / unmark; unreviewed to-do on the dashboard; `src/lib/domain/overuse` with tests (tracked vs rehearsal-type categories, included classes, unlimited); flags on the student detail. Marking reviewed creates no charges yet; M6 adds a confirm-charges step that also marks the session reviewed.
*You can test:* enrol and un-enrol someone and watch future lists change; compose a workshop with a guest and confirm that only listed students can scan into it; review yesterday's seeded class; see a seeded over-user and an unenrolled attendance flagged; a seeded team member with one class included who attended two classes is flagged while their rehearsals never count; an extra's toggle changes the count.

**M6 — Charges and payments.** Monthly run (ledger claim, per-school local date, eligibility by activation date, "generate now"), mid-month prompt with proration gated by billing start, charge edit with reason and optimistic concurrency, void/unvoid, one-off batches (person or categories) with preview and `client_key`, extra-session charging on past sessions with preview and skip of already-charged people, `record_payments` with split across charges and per-row keys, void payment, Payments screen, derived statuses, student money tabs, guest charges tab, payment-status filter, the check-in reminder goes live, money seed.
*You can test:* generate September and press again (no duplicates); activate a pending student on the 20th and accept the proportional amount; edit a charge; a batch for Comp Team A, submitted twice (one batch); charge a workshop twice (second time: 0 new); partial then full payment; void; scan as an unpaid student and see the reminder.

**M7 — Dashboard and WhatsApp.** The four blocks in order (today's classes with live check-ins and correct button; unpaid this month with open amount, days overdue, WhatsApp reminder, quick record payment; overuse this week; income expected vs received by location and category) and the two badges; template editor in Settings; WhatsApp buttons on the unpaid list, on sessions (one link per expected person) and on invites, rendered in the recipient's language.
*You can test:* the dashboard on your phone against the seeded day; the WhatsApp button opens the app with name, month and amount; an English-speaking seeded student gets English.

**M8 — Student portal.** Overview with today's expected sessions and their check-in state and the "scan the door QR" hint; my categories and my live monthly price with explanation (`get_my_pricing` + the engine) next to this month's charge; payment status and history; attendance history; my agenda (expected sessions, extras, cancellations with reason); settings (language, contact, sign out everywhere); school switcher for users with several memberships.
*You can test:* as a seeded student on the phone; the price and explanation match the admin card; another student's data is unreachable by URL; nothing from the other school is visible.

**M9 — Activity screen, PWA, hardening, go-live.** Activity with filters (admin, entity type, student, date range) and readable lines; PWA (manifest, icons, service worker, offline page) with a Lighthouse pass; security headers; edge rate-limit rules; legal pages (Q12); production Supabase and Vercel environments, domain, SMTP with DKIM, Google consent screen; `bootstrap-school.ts` creates your real school with `billing_start_period` chosen by you before any student is entered; one migration squash; final README; go-live checklist.
*You can test:* install on iPhone and Android; airplane mode shows the offline page; the activity line reads "Carla registró un pago de $30.000 en efectivo de Juan Pérez, septiembre"; your real school works end to end with no demo data.

Estimate (opinion, not a commitment): M1 is the largest and least visible milestone; M4–M6 carry most of the logic; M7–M9 are mostly screens over data that already exists.

## 9. Questions, defaults and contradictions

### 9.1 Questions that change what gets built (please answer each)

| # | Question | My recommendation and why |
|---|---|---|
| **Q1** | **Repository.** This repo currently holds the unrelated EqualScore static demo. | **Answered:** delete the demo files outright (git history keeps them); no tag, branch or legacy folder. The product is called **Clave**. Renaming the GitHub repo to `clave` is optional and best done between sessions. |
| **Q2** | **Accounts and plans.** A paid product needs Vercel **Pro** (Hobby forbids commercial use and its crons run once a day) and Supabase **Pro** for production (backups, no project pausing), plus custom SMTP (Resend free tier; Supabase's built-in mailer only delivers to project members), a product domain, and a Google Cloud OAuth client. Will you create these accounts (I will write the exact steps), and when can I have the Supabase project URL and keys for staging? | Estimate: about USD 45/month for the two Pro plans before domain and email. Staging can start on Supabase Free. **M1's testable deliverable (sign-in on your phone) needs a Supabase project**, so this is the first practical dependency. |
| **Q3** | **Second city.** Is the other location on Santiago time? Magallanes (`America/Punta_Arenas`, no DST) and Easter Island would make one school timezone wrong for part of the year. | If yes, one `schools.timezone`. If not, I add a nullable `locations.timezone` override before M4 (one column, one function). |
| **Q4** | **Payment model.** The brief links a payment to one charge. I propose exactly that: a transfer covering September and a costume becomes two payment rows from one form; a payment larger than what is open is refused; there are no credit balances ("keep the extra 5.000 for October") in v1. The alternative is a payments-and-allocations ledger with per-student credit and automatic application to new charges: more correct accounting, noticeably more to build and to explain. | Simple model for v1; the allocation ledger is an additive change later. Tell me if advance payments are common at your school, because then the alternative is worth it now. |
| **Q5** | **Pricing tie-break.** §6 says the rule covering the most categories wins, then the lowest price. Taken literally, a rule can win even when it is *more expensive* than the categories separately, and two small rules can beat one cheaper big rule if they cover more. Keep the literal order? | Yes, keep §6 literally (it is what you asked for and rules are yours), and the rules screen warns when a rule is pricier than its parts. The alternative "lowest total wins" is a one-line change in the comparator; say so if you prefer it. |
| **Q6** | **Rule shape.** A rule applies only when the student has *every* category in it. Your example "Comp Team A includes weekly classes" therefore needs one rule per combination (Comp A + Friday 2x, Comp A + Partnerwork, …). Acceptable for v1? | Yes; "required + optional categories" rules are an additive change later. |
| **Q7** | **Self-registration shape.** Sign in first (email code/link or Google), then a two-field form (name, phone), rather than an anonymous form. Every self-registration is pending until you approve it, even when the email matches a student you already created (the approval screen then offers "same person as X" in one tap). | Sign-in first, always pending. Silent linking on an admin-typed email would hand a stranger a student's history if the address is stale or shared. |
| **Q8** | **Extras and the door QR.** A student can QR-check-in to an extra session only if they are on its expected list (§9); regular classes accept any active student (flagged if not enrolled). A pending (unapproved) student cannot check in at all. | Yes; it prevents accidental charges under "charge attended". Walk-ins to extras are added by you in the review. |
| **Q9** | **Attendance and overuse rules** (rewritten after your note on rehearsals). (a) Each category is either a *class* (QR check-in at the door, counts toward the weekly allowance) or a *rehearsal-type* category such as a competition team or show group (no QR, never counted, attendance is the student's responsibility); extras of type "rehearsal" behave the same, and you can flip either per session. (b) A rehearsal-type category can include N tracked classes per week in its fee (0, 1, 2… or unlimited); those classes are checked in with the QR and count. (c) A student's weekly allowance is the sum over their categories, unlimited if any category says unlimited; overuse is flagged when counted classes exceed it. (d) A student who attends a class they have no access to (not enrolled, and no team fee that includes classes) gets the "not enrolled" flag; the attendance still counts toward their allowance. (e) Unreviewed check-ins count until you mark someone absent. (f) A student you added to a class list by hand is not flagged as "not enrolled" (shown as "added by you"). | Yes to all six; this is how I read your note. |
| **Q14** | **Scope of included classes.** When a team fee includes N weekly classes, may those be *any* class category, or do you need to restrict them to chosen categories (e.g. only Partnerwork)? | Any class in v1; a per-category list of allowed class categories is an additive change if you need it. |
| **Q10** | **Real data.** Production stays empty until M9 and staging is reset at every milestone boundary (what you typed during a test is wiped). If you want to start entering real students earlier (M3 is tempting), say so now: from that day migrations must be non-destructive and production is backed up before every push. | Empty until M9; start real data after M7 at the earliest. |
| **Q11** | **Build environment.** The cloud environment I run in has Node 22 and PostgreSQL 16 but **no Docker**, so the Supabase local stack cannot run here. Plan: migrations and the database test suite run here against a plain Postgres with a small `auth` shim; GitHub CI and your laptop use the Supabase CLI for everything including the tenant sweep and the end-to-end flows; auth flows are tested by hand on staging. OK? | Yes; it is why the database tests are Vitest + `pg` rather than pgTAP. |
| **Q12** | **Additions beyond the brief** that I recommend for a sellable product, each cheap: bilingual privacy and terms pages (Google's consent screen requires a privacy URL); a `suspended_at` switch on schools (freeze a non-paying school without deleting data, no UI); Sentry error reporting from M1 (free tier). Account deletion for students stays a manual runbook in v1. | Yes to all three, deletion manual. |
| **Q13** | **Bot protection on sign-in** (Cloudflare Turnstile on the email-code request) — off by default, added if abuse appears. | Off. |

### 9.2 Defaults I will apply unless you object

Grouped by area; each is a single line so you can scan for anything that looks wrong.

**Roles and people**
- One membership per user per school; an admin who also dances has a linked `people` row and sees both navigations; no separate "teacher" role.
- Admin-created students are active immediately (charged, expected); self-registered ones are pending until approved.
- No uniqueness on phone or email (siblings share a phone); duplicates are hinted at approval, never auto-merged.
- An inactive student loses portal access; their history and open charges remain visible to admins.
- Guests can be added to regular classes too (name + phone); they never get enrollments or monthly charges.
- Student invite links are bearer links with a "¿eres tú, {name}?" confirmation, 30-day expiry, single use; admin invites are bound to the email, 7 days.
- Students can read the school's categories (names, colours, limits, default prices) and locations; never rules, overrides, or other people's rows. Their live price comes from their own inputs through `get_my_pricing`.
- The person's note, a session's cancel reason, a charge description and a payment note are visible to the person; admin-only remarks are the reasons attached to actions in the activity log.
- Student actions (QR check-ins, contact edits, invite acceptance) are logged with `actor_kind = student`; the activity screen defaults to admins.
- First school: an `/onboarding` page for a signed-in user whose email is on an allowlist seeded with yours; your real school is created that way (or by a script) at go-live.
- The sign-in email is bilingual (Spanish, then English) because Supabase has one template per project.

**Agenda and attendance**
- Sessions are generated 12 weeks ahead (brief: at least 8) and further on demand up to 52 when you open a later month; a pattern whose "valid from" is in the past generates from today (no backfill of past dates in v1).
- A pattern's weekday cannot change in place; "move to Thursday" ends it today and duplicates it.
- Ending or pausing a pattern removes untouched future sessions and cancels edited ones with reason "pattern ended".
- Classes cannot cross midnight (end after start, same day).
- Rehearsal sessions (categories with attendance tracking off, extras of type rehearsal) show on the agenda with their expected list, are skipped by the door QR and by the review to-do; the teacher can still mark attendance by hand and can enable QR per session.
- Check-in window defaults: 30 minutes before start, 0 after end; editable within 0–180 / 0–120.
- A student may check in to two overlapping sessions (rare); both reviews show it and you remove one.
- Manual admin check-ins have no time window (late arrivals after the class).
- Removing a person from a list is remembered for that session even if their enrollment changes; refused while they have a check-in or a charge for it.
- Category links on extras stay live until the session starts (a new team member is expected automatically), labelled "via {category}".
- Review controls are available from the start time; the to-do lists sessions whose end time has passed; older than 30 days are collapsed behind a count; no automatic review.
- All times are shown in the school timezone even when your phone is abroad; changing the timezone re-times future sessions only.
- Archiving a category or location ends every pattern that uses it (after showing the list); archiving a category with active enrollments is refused.
- Live check-in lists refresh every 10 seconds while open.
- The printable QR is a print-ready web page (SVG); no PDF export in v1.

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
- The first billed month defaults to the month after the school is created and is shown in Settings as "start billing from"; earlier months only through "Generate now"; currency is locked once money exists.
- The monthly run skips people who already have any *monthly* charge (live or voided) for the period and people activated after the 1st (they get the mid-month prompt instead).

**Platform**
- Money formatting follows the UI language (`$45.000` in Spanish, `$45,000` in English); dates and times in the school timezone, 24-hour clock.
- Phones are stored E.164 only; the school's default country (CL) fills the prefix; national display; `wa.me` from the digits; a person's number in a school is the canonical one and the portal's contact edit updates it everywhere.
- Non-users get a `language` field on their person record (default: school language) so WhatsApp messages are in their language; a user's own choice overrides it.
- PWA: installable; offline = a "no connection" page; no cached data, no push, no offline check-in queue; install card for admins, optional for students.
- Sessions never expire (no forced re-login); "sign out everywhere" in settings; no passwords, no SMS.
- Supabase region São Paulo, Vercel `gru1`; two Supabase projects (staging, production); `main` deploys to staging, a `production` branch to production with manual approval.
- Code, commits and docs in English; UI default Spanish.
- Seed data: two schools (demo + isolation control), relative dates; local seed users have a password shown only against a local database.

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
| C9 | §7 mid-month proration has no basis; "activated after the 1st" misses the 1st itself and a late run | Days vs classes, inclusive or not, rounding; a delayed run would bill a mid-month joiner in full. | Calendar days including the join day; the run only bills people activated on or before the 1st; everyone else gets the prompt. |
| C10 | §6 "one pure, well tested function" (TypeScript) vs §7 "Supabase cron" | `pg_cron` cannot call TypeScript; a SQL copy would be a second engine. | The job computes in TS and inserts through one SQL function; the scheduler only calls a route. |
| C11 | §12.4 split by location and category vs §5 optional category location, rules spanning categories, §8 one-offs, §9b free-address extras | Attribution undefined. | `breakdown` snapshot with proportional split and "no location"/"one-off"/"extras" buckets. |
| C12 | §9b "single dated class without any weekly pattern" vs §5 `kind (regular \| extra)` and "source slot" | Neither generated nor an extra. | `regular` with `slot_id null`. |
| C13 | §9 "extra sessions work the same way for students on the expected list" vs §9b review shows "anyone who checked in but was not expected" | Pull in opposite directions for extras. | Extras: QR only for expected people; regular: open and flagged (Q8). |
| C14 | §9 allowance "of active categories that have a limit" vs "flag when counted attendances in limited categories exceed the allowance" vs §5 `counts_toward_limit` default true for all regular sessions vs §5 "null = no attendance limit, e.g. competition team" | Undefined with no limited category; a competition rehearsal would eat the weekly classes; and, per your note, rehearsals are not tracked at the door at all while a team fee may include weekly classes that are. | Categories carry an attendance-tracking mode; rehearsal-type sessions have no QR and never count; `classes_per_week_included` on a rehearsal-type category is the number of tracked classes its fee includes (Q9). |
| C15 | §5 status `scheduled/cancelled/moved` vs §9b cancel *and* move on one date | One column cannot say both. | `cancelled` wins; overrides persist; uncancel restores `moved`. |
| C16 | §9b "changes apply to future sessions only" vs per-date edits vs idempotent regeneration | No rule says which per-date edits survive a pattern edit. | Immutable `(slot_id, slot_date)`, explicit override flags, pristine rule, cancel-with-reason when a pattern shrinks. |
| C17 | §9 "week = Monday to Sunday" vs `check_ins` timestamp | Session date or check-in instant? They differ around midnight and DST. | Always the session's local date. |
| C18 | §3 settings list vs §9 check-in window "make it a school setting", §15 templates, phone normalisation needs a default country, §7 needs a first billed month | §3 is incomplete. | Two window columns, `default_country`, `billing_start_period`, `whatsapp_templates`. |
| C19 | §9b extra "location (or free text address)" vs §5 sessions have a location vs §9 QR by location | A free-address extra has no QR. | `location_id` nullable + `address_text`; attendance recorded by the teacher. |
| C20 | §4 admins "same rights as owner", owner "can invite and remove admins", §13 Team | Whether admins may manage other admins is implied, not stated. | Yes, except the owner. |
| C21 | §4 "owner creates the school" vs §17 "multi school signup flow" out of scope | Nobody can create the first school. | Allowlisted `create_school` + `/onboarding`. |
| C22 | §11 "every create, update and delete **by an admin** is logged" vs §5 `check_ins` as a door audit (student-initiated) vs §5 cron-generated sessions | Student and system events are outside the letter; logging every generated row would bury real actions. | Log all actors with `actor_kind`; skip pristine derived rows. |
| C23 | §10 admin creates a student with **email** + auth is email or Google | Many students have WhatsApp but no email they check; without one they can never log in. | Email optional; the person is a full record without a login; the invite page asks for an email or Google at sign-in. |
| C24 | §19 "check in under 5 seconds from scan to confirmation" vs §9 "must be logged in (redirect to login, then back)" | A first-ever scan includes an email round trip. | The budget applies to a signed-in phone (one round trip, auto check-in on a single match); sessions never expire so the first login happens once. |
| C25 | §5 `profiles.phone` "for WhatsApp" vs §10 admin-created students and §5 guests who have no profile | The WhatsApp number must exist for people without a login. | `people.phone` is canonical per school; `profiles.phone` is the user's default copied in when linking. |
| C26 | §14 "my monthly price" vs §4/§19 students may not read rules or overrides | The portal cannot run the engine on data it may not read. | `get_my_pricing` returns the caller's own inputs; the same pure engine renders the explanation. |
| C27 | §18 order: overrides (M2) before any student screen (M3); Settings and Team have no milestone; §18.1 seed needs M2/M3 tables; §5 cron for sessions (M4) vs §7 cron mentioned only for charges (M6); §11 trigger vs "activity log screen" in M9; §9b review (M5) creates charges (M6); §10 invite WhatsApp button (M3) vs §18.7 WhatsApp (M7) | Milestone dependencies. | The reordering in section 8 (D-031). |
| C28 | §2 "Deploy on Vercel", §7 "Vercel cron", §19 "monthly subscription fee" | Hobby plan is non-commercial and daily-only crons. | Q2. |
| C29 | §14 "Check in (via door QR)" as a portal feature | The portal cannot check in without the QR. | The portal overview lists today's expected sessions with their check-in state and says "scan the door QR"; no manual self check-in. |
| C30 | §19 README vs the current repository contents | The README, `.gitignore` and `netlify.toml` describe another product. | Q1 (answered: delete them). |

## 10. Deferred on purpose (additive later, nothing in v1 blocks them)

Payments-and-allocations ledger with credit balances (Q4); "required + optional" rule shapes (Q6); rotating tablet QR (another `location_qr_tokens.kind`); in-database per-user rate limiting and a nonce-based Content Security Policy; Cloudflare Turnstile (Q13); Supabase Realtime for live lists; backfilling past sessions from a pattern; admin-only private notes on people; ownership transfer; per-location timezones (Q3); restricting a team fee's included classes to chosen categories (Q14); a student self-service account-deletion flow; online payments (`provider` columns ready); multi-school signup and billing (`create_school` and `suspended_at` ready); PDF export of the QR page.
