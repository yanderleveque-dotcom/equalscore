# Build prompt: Clave Studio v1

You are building **Clave Studio**, a web app for managing students, attendance and payments at a Latin dance school (salsa, bachata). Version 1 serves **one school**, but the architecture must support **many schools later** without a rebuild.

Before writing code: read this whole document, propose a plan (data model, folder structure, milestones), list any questions or contradictions you find, and wait for my approval. Then build milestone by milestone, and stop after each one so I can test.

---

## 1. Context and goal

A dance teacher gives classes in two locations (Santiago and another city). He runs weekly classes, show/choreography groups and competition teams. Students combine these in many ways, and prices depend on the combination. Today he has no clear view of:

* who paid, and how much each person should pay
* who attends more than their pass allows (e.g. pays 1x/week, comes 2x/week)

The app must answer those questions at a glance, while giving the teacher **full control**: he defines his own categories, prices and combinations, and can override anything per student.

## 2. Tech stack

* **Next.js** (App Router, TypeScript, Server Actions or route handlers)
* **Supabase**: Postgres, Auth, Row Level Security
* **Tailwind CSS** + shadcn/ui
* Deploy on **Vercel**
* Mobile first: students use it on their phone, admins on phone and laptop
* Installable as a PWA (manifest + icons), no native app

## 3. Multi school architecture (critical)

* Every business table has a `school_id`.
* RLS policies ensure users only ever see data of schools they are a member of.
* School level settings: name, currency (default `CLP`, no decimals), timezone (default `America/Santiago`), payment due day (1 to 28), default language.
* No hardcoded school, location or category anywhere in the code.

## 4. Roles

| Role | Rights |
|---|---|
| **Owner** | Everything. Creates the school. Can invite and remove admins. |
| **Admin** | Same rights as owner (teachers/assistants who help with administration). Cannot remove the owner. |
| **Student** | Own portal only: check in, see own data. |

A user can in theory belong to several schools (future proofing), with a role per school.

## 5. Core concepts and data model

Propose the exact schema, but it must cover these entities:

* **schools**: settings above
* **profiles**: full name, phone (for WhatsApp), email, preferred language
* **memberships**: user × school × role × status (`pending`, `active`, `inactive`)
* **locations**: name, address, a unique `qr_token`
* **categories**: fully teacher defined. Fields: name, optional location, color, default monthly price, optional `classes_per_week_included` (integer, null = no attendance limit, e.g. competition team), active flag. Examples the teacher might create: "Friday Santiago 2x", "Partnerwork 1x", "Comp Team A", "Show Group B", "Shines".
* **schedule_slots**: the recurring weekly pattern, entered manually by the teacher: location, category, weekday, start time, end time, valid from, optional valid until, active. This is a template, not the agenda itself. Several slots per day and per location are normal.
* **class_sessions**: one concrete dated class. Generated from the slots (materialize at least 8 weeks ahead via cron, and immediately when a slot is created). Fields: school, location, date, start time, end time, source slot (nullable), category (nullable for extras), kind (`regular` or `extra`), extra type (`workshop`, `event`, `private`, `rehearsal`, `other`), status (`scheduled`, `cancelled`, `moved`), title, note, price (nullable), charge mode (`signed_up`, `attended`, `none`), `counts_toward_limit` (boolean, default true for regular sessions, default **false** for extras, always editable per session), reviewed_at, reviewed_by.
* **session_attendees**: who is linked to a session. Person = student **or** guest. Fields: source (`auto` from category enrollment, or `manual`), status (`expected`, `attended`, `absent`, `excused`), check in time, source of attendance (`qr` or `manual`), charged flag.
* **guests**: people who are not students: name, phone, optional email, note, school. No login. Can be converted into a full student later, keeping their history.
* **student_categories**: a student can have **multiple** categories, with start and optional end date (keeps history).
* **combination_rules**: teacher defined bundle prices. A rule = a set of categories + a monthly price. Examples: "Comp Team A + Friday Santiago 2x = 45.000", "Comp Team A includes weekly classes = price of Comp Team A only".
* **price_overrides**: per student custom monthly price, with reason and validity period.
* **charges**: what a student owes. Type `monthly` (with period YYYY-MM) or `one_off`. Stores `default_amount` (what the system calculated) and `amount_due` (what applies after edits), due date, description.
* **payments**: linked to a charge. Amount, method (`cash`, `transfer`, `other`, later `online`), paid_at, recorded_by, note. Include nullable `provider` and `provider_ref` columns so an online payment provider (Mercado Pago, Flow) can plug in later without schema changes. Partial payments allowed; charge status is derived (`unpaid`, `partial`, `paid`).
* **check_ins**: student, **class session**, timestamp, source (`qr` or `manual`), created_by, status (`valid`, `removed`). Keep this as its own table (the audit trail of what happened at the door); `session_attendees.status` is the teacher's confirmed truth after review.
* **activity_log**: see section 11.

## 6. Pricing engine

A student's monthly amount is calculated in this priority order:

1. **Active price override** for that student → use it.
2. **Combination rules**: if the student's active categories contain one or more rules, apply the best cover: prefer the rule covering the most categories; on a tie, the lowest price. Categories not covered by a rule add their individual default price. Rules may not overlap within one calculation.
3. **Otherwise**: sum of the default prices of the student's active categories.

Requirements:
* Put this logic in one pure, well tested function (unit tests with many combinations).
* In the UI, always show **how** the amount was reached ("Rule: Comp Team A + Friday 2x" or "Override: family discount") and what the default would have been.
* All prices editable by admins at any time. Price changes apply to future charges, never silently rewrite past charges.

## 7. Monthly charges

* Calendar months. Due day configurable per school.
* On the 1st of each month (Supabase cron or Vercel cron), create a `monthly` charge for every active student using the pricing engine. Snapshot the amount in the charge.
* Admins can edit any charge amount (logged).
* **Mid month join**: when a student is activated after the 1st, the system suggests a proportional amount; the admin confirms, edits, or chooses full month. Decided per student.

## 8. One off charges

* Admin creates a one off charge (costume, competition fee, event) with description, amount, due date.
* Target: a **single student** or **all students in one or more categories** (creates one charge per student).
* Same payment tracking as monthly charges.

## 9. Attendance and check in

**Door QR flow**
* Each location has one printable QR (admin can download/print it) encoding a URL like `/checkin/{qr_token}`.
* Student scans with their normal phone camera → opens the web app → must be logged in (redirect to login, then back).
* The app finds the **class session** at that location happening now (window: 30 min before start until end, make it a school setting). Cancelled sessions are excluded.
  * One match → check in, show confirmation.
  * Several overlapping → student taps which class.
  * None → friendly message, no check in.
* Extra sessions work the same way for students who are on the expected list. Guests have no login, so an admin marks them present manually.
* No duplicate check in for the same session.
* **Unpaid students can always check in.** The confirmation screen also shows a friendly reminder if the current month is unpaid ("Recuerda que tienes pendiente el pago de septiembre").

**Admin corrections**
* On each class, admins see the live list of check ins, can add a student manually, and remove a wrong check in. All logged.

**Overuse flag**
* Week = Monday to Sunday in the school timezone.
* Weekly allowance = sum of `classes_per_week_included` of the student's active categories that have a limit.
* Only attendances at sessions with `counts_toward_limit = true` are counted. Regular classes count by default, extra sessions do not, and the teacher can flip this per session (e.g. a free extra rehearsal that should count, or a regular class he wants to gift).
* Flag when counted attendances in limited categories exceed the allowance that week.
* Separate flag: student checked into a class whose category they are **not** enrolled in.
* Flags are informational only, nothing is blocked.

**Known v1 risk, accept for now**: a photo of the door QR could allow remote check ins. Admins can remove those manually. Keep the design open for a rotating QR shown on the teacher's tablet later.

## 9b. Agenda, expected attendees and post class review

This is a core screen, not an afterthought. The teacher opens the agenda to know what he teaches today, who should be there, and to settle afterwards who actually was.

**Agenda views**
* Day, week and month view. Week is the default on laptop, day on phone.
* Filter by location and by category. Color per category.
* Each session shows: time, category or title, location, number expected, number attended (after the class), and its status.
* Cancelled sessions stay visible, greyed out with the reason.

**Building the agenda (fully manual, the teacher decides everything)**
* The teacher fills his own timetable: for each class he picks **location, category, weekday, start time, end time**, and from which date the pattern runs (and optionally until when). Nothing is preset or guessed by the app.
* Multiple classes on the same day are normal (e.g. two Friday classes in Santiago, back to back or at different hours), including at different locations. Overlapping times are allowed, but warn him when two classes at the same location overlap.
* He can also create a **single dated class** without any weekly pattern, for a one off or an irregular schedule.
* Duplicate a class to another day or time in one action, so filling a full week is quick.
* A clear weekly grid per location where he sees his pattern at a glance and edits it inline.

**Managing sessions**
* Edit the weekly pattern (schedule slots). Changes apply to **future** sessions only, never to sessions already held.
* Per session, the teacher can: cancel (with reason), change time or location for that one date only, add a note.
* Add an **extra session**: title, type (`workshop`, `event`, `private`, `rehearsal`, `other`), date, time, location (or free text address), price, charge mode, and the **counts toward weekly limit** toggle (off by default).
* A "WhatsApp expected attendees" action on a session (opens one prefilled message per person) so he can warn people about a cancellation or a change.

**Expected attendees**
* For a regular session: automatically everyone with an active enrollment in that session's category.
* For an extra session: the teacher composes the list, mixing three sources:
  * whole categories (e.g. all of Comp Team A)
  * individual existing students
  * **guests**, added on the spot with just name and phone
* He can always add or remove individuals on any session, including regular classes (e.g. a student trying out a class).

**Post class review**
* After the end time, the session opens a review screen: the expected list with each person's state, plus anyone who checked in but was not expected (clearly marked).
* The teacher can set each person to attended, absent or excused, add people who were not on the list (student or new guest), and remove wrong check ins.
* One tap "mark all who checked in as attended" to keep it fast.
* Marking the session **reviewed** timestamps it and shows it as settled in the agenda. Unreviewed past sessions appear as a small to do list on the dashboard.
* Everything here is editable afterwards, and every edit lands in the activity log.

**Charging for extra sessions**
* If an extra session has a price, the teacher chooses per session whether to charge **everyone signed up** or **only those who attended** (or nobody).
* On confirming the review, the app creates a one off charge per person, dated in the month of the session, so it lands on that student's monthly total. It shows a preview of who gets charged how much before creating anything.
* Guests get charges too; they have no login, so payment is recorded manually and reminders go through the WhatsApp button.
* Never double charge: a person already charged for a session is skipped if the review is confirmed again.

## 10. Student onboarding

Both paths must work:
* **Admin creates** a student (name, phone, email, categories) and sends an invite link (copy link or WhatsApp button).
* **Self registration** via a public school link: student enters name, phone, email → status `pending`. Admin approves and assigns categories (and optionally a price override). Pending students appear clearly on the dashboard.

Auth: Supabase email magic link, plus Google sign in. Keep it simple for non technical students.

## 11. Activity log

* Every create, update and delete by an admin is logged: actor, action, entity type, entity id, before and after values (jsonb), timestamp.
* Covers at least: prices, categories, rules, overrides, charges, payments, check in corrections, student status, admin invites.
* Admin screen: chronological list, filter by admin, by entity type, by student, by date range. Human readable lines ("Carla recorded a 30.000 cash payment for Juan Pérez, September").
* Implement with database triggers or one central server side helper so nothing slips through.

## 12. Admin dashboard (in this order, top to bottom)

1. **Today's classes + live check ins**: each class of today, count and names checked in, button to correct.
2. **Unpaid this month**: students with unpaid or partial charges, amount open, days overdue, **WhatsApp reminder button**, quick "record payment" action.
3. **Overuse**: students above their weekly allowance or attending unenrolled categories this week.
4. **Monthly income**: expected vs received for the current month, split by location and category.

Plus small badges when relevant: pending registrations, and past sessions not yet reviewed.

## 13. Other admin screens

* **Students**: search, filter by location/category/payment status. Student detail: categories, calculated price with explanation, override, charges and payments history, attendance history, flags.
* **Categories**: create, edit, archive; price and weekly limit.
* **Combination rules**: create by picking categories + price; preview which students it affects.
* **Agenda**: day/week/month views, session detail, expected attendees, post class review, extra sessions (see section 9b).
* **Schedule pattern**: weekly grid per location where the teacher manually enters which class he gives on which day, at which time, in which category, and duplicates or edits entries inline. Feeds the agenda.
* **Guests**: list of non students, their sessions and charges, convert to student.
* **Locations**: manage, print QR.
* **Payments**: record payment (select student, charge, amount, method, date, note).
* **Team**: invite and remove admins.
* **Activity log**.
* **Settings**: school name, currency, timezone, due day, check in window, language.

## 14. Student portal

* Check in (via door QR)
* My categories and my monthly price
* Payment status and history (monthly and one off)
* My attendance history
* My agenda: upcoming sessions I am expected at, including extra sessions and cancellations

## 15. WhatsApp reminders (v1)

* No WhatsApp API. A button that opens `https://wa.me/{phone}?text={prefilled message}` with the student's name, month and amount, in the student's language.
* Message templates editable in settings.

## 16. Languages

* Spanish and English from the start, full i18n (e.g. next-intl), switch per user.
* No hardcoded UI strings. Dates and money formatted per locale (CLP: `$45.000`).

## 17. Out of scope for v1 (design for, do not build)

* Online payments (keep provider columns ready)
* Native app
* Automated WhatsApp/email sending
* Rotating QR
* Multi school signup flow and billing of schools

## 18. Suggested milestones

1. Project setup, Supabase schema, RLS, auth, roles, i18n skeleton, seed data (1 school, 2 locations, sample categories, rules, 20 students).
2. Categories, combination rules, overrides, pricing engine with unit tests.
3. Students: CRUD, invites, self registration, approval.
4. Locations, schedule pattern, session generation, agenda views, QR check in.
5. Expected attendees, extra sessions, guests, post class review, overuse flags.
6. Charges (monthly cron, mid month suggestion, one off, extra session charging), payments.
7. Dashboard, WhatsApp buttons.
8. Student portal.
9. Activity log screen, polish, PWA, deploy.

## 19. Quality bar

* TypeScript strict. Pricing engine and overuse logic fully unit tested.
* Test RLS: a student can never read another student's data; school A never sees school B.
* Every money amount stored as integer in the smallest unit.
* Clean mobile UI, big tap targets, check in flow under 5 seconds from scan to confirmation.
* Keep a `README.md` with setup steps and a `DECISIONS.md` logging any choice you make that this document does not specify.

This is something I'd like to build and ask a monthly subscription fee for, so it has to be airtight.
