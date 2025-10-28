# Product Requirements Document (PRD) - Wedding Seating App

## 1. Product Overview

The Wedding Seating App is a mobile-first, responsive web application that enables engaged couples, planners, and venue staff to create, visualize, manage, and share wedding seating plans through an intuitive drag-and-drop canvas. Key MVP capabilities include account-based saving and sharing, a canonical single-sheet XLSX import (with mapping, preview, fuzzy-duplicate detection and row-level validation), table creation with configurable shapes and capacities, automatic seat assignment within tables (randomized with canonical seat-order rules), soft single-editor locking, autosave with undo/redo and versioning, accessible UI (WCAG AA target), GDPR/CCPA-compliant PII handling, and print/export outputs (A4 PDF, high-res PNG, XLSX/CSV).

Primary technical targets:

- Mobile-first UX with touch gestures (pan, pinch-to-zoom, drag/drop).
- Initial render performance: under 1 second for 300 guests (mobile prioritized).
- Virtualized guest lists and canvas optimizations for large events.

Launch constraints:

- MVP supports a simple grid floorplan only (no blueprint/venue upload).
- Single-editor model (soft edit-lock); real-time multi-editor collaboration deferred.

## 2. User Problem

Engaged couples and event planners need an easy, fast, and reliable way to convert guest lists into seating charts that match venue constraints and guest relationships. Common pain points:

- Converting spreadsheets into usable seating layouts without manual per-guest editing.
- Detecting duplicate guest entries and resolving ambiguous imports.
- Visually arranging tables and seats on mobile devices with large guest lists.
- Sharing final seating with collaborators (planners/venues) in a secure, view-only way.
- Producing print-ready materials for venues and vendors.
- Ensuring privacy and compliance when handling PII (names, notes, contact data).
- Recovering from accidental edits or needing to revert to previous seating versions.
- Accessibility and colorblind-safe display for diverse users.

The app solves these problems by providing a streamlined import + visual layout flow, sensible default behaviors (random seat assignment per table using canonical rules), robust validation and auditing for imports, secure sharing controls, and export features for venue/print consumption—all while meeting legal and accessibility obligations.

## 3. Functional Requirements

The following requirements describe the functional capabilities for the MVP. Each item maps to user stories in Section 5.

### 3.1 Account & Authentication

- FR-001: Require user account for any saved/shared event.

  - Supported sign-up methods: email + password and Google OAuth.
  - Anonymous preview mode allowed; attempting to save or create a share link prompts for quick signup.

- FR-002: Authentication sessions with secure tokens and 2-week default session expiration (configurable).

### 3.2 XLSX Import

- FR-010: Provide canonical single-sheet XLSX template with columns: Name, InitialTable, Note, OptionalTag.
- FR-011: Import flow includes: upload, column mapping UI, import preview (first N rows), row-level validation, downloadable sample XLSX.
- FR-012: Row-level validation must identify and allow download of an error report.
- FR-013: Fuzzy duplicate detection in import preview with suggested merges and manual-confirm merge flow and audit trail.
- FR-014: Ambiguous rows flagged for user confirmation; import cannot finalize until ambiguous merges are resolved or explicitly accepted.

### 3.3 Seating Canvas & Table Management

- FR-020: Drag-and-drop canvas allowing:

  - Create tables of shapes: round, rectangular, long.
  - Edit table capacity, label, seat markers, per-table start index and head-of-table settings.
  - Table collision snapping and grid-based placement.
  - Touch gestures: pan, pinch-to-zoom, drag/drop (mobile-first).

- FR-021: When guests are assigned to a table (by drag or import InitialTable), the system randomly places them into concrete seats on that table by default, following canonical seat-order rules.
- FR-022: Canonical seat-order rules: default clockwise starting at 12 o’clock; per-table override for start-index and head-of-table.
- FR-023: Manual seat-level editing: users can swap guests between seats and move guests between tables. (Depth of manual seat-editing included for MVP: seat swapping and moving; seat-level rotation/seat shape changes not required.)
- FR-024: Visual seating overview shows full floorplan with labeled tables, color-coded guests (with colorblind-safe palettes available), guest initials/names, seat numbers, zoom and pan. Non-color indicators (icons, patterns) provided.

### 3.4 Save, Autosave, Undo/Redo, Versioning

- FR-030: Auto-save on every meaningful change (table edits, guest assignments, import completion).
- FR-031: Session undo/redo stack (per session).
- FR-032: Snapshot/version browser:

  - Automatic snapshots retained by default for 30 days.
  - Users can create unlimited named backups (manual snapshots).
  - Version browser shows timestamp, author, and diff preview for snapshots.
  - Per-user snapshot management UI for listing/deleting/restoring snapshots (cap to be defined for named backups UI; default unlimited but subject to admin limits).

- FR-033: Soft edit-lock (single-editor mode): when a user opens an event for editing, show “Currently editing” indicator to other viewers and prevent simultaneous edits. Provide stale-editor timeout and explicit release action.

### 3.5 Sharing & Access Controls

- FR-040: Shared links are view-only by default; owner can enable optional password protection, set expiration/revocation, and toggle visibility of additional PII (notes/contact).
- FR-041: Shared view displays Name + Table + Seat by default; owner can opt to include notes/contact.
- FR-042: Access logs: log shared-link access events (timestamp, IP, user agent, action) for audit and compliance.
- FR-043: Owner can list, revoke, and regenerate share links; revocation immediately denies further access.

### 3.6 Exports

- FR-050: PDF export:

  - Print-ready A4 landscape.
  - Contains floorplan with legend, labeled tables, timestamp, and optional notes.
  - 300 DPI output.

- FR-051: PNG export: high-resolution full floorplan image.
- FR-052: XLSX/CSV export of final assignments with columns: Name, Table, Seat, Note, Tag, RSVP. Include options for orientation and inclusion of notes.
- FR-053: Export requests are logged and subject to rate limits.

### 3.7 Privacy, Security & Compliance

- FR-060: GDPR/CCPA compliance for PII:

  - Explicit checkbox consent at upload with timestamp and uploader IP logged.
  - Data encryption in transit (TLS) and at rest.
  - Data export and deletion endpoints for DSAR/erasure requests; admin/user workflows and audit trail.
  - Published Privacy Policy and DPA available to users.
  - Logs of share link access and exports retained for compliance.

- FR-061: PII minimization in shared views by default.

### 3.8 Accessibility

- FR-070: Meet WCAG AA at launch:

  - Keyboard navigation for all interactive controls.
  - Screen reader labels and ARIA attributes for canvas elements.
  - Color contrast passes AA thresholds.
  - Provide colorblind-safe palettes and non-color indicators (patterns/icons) for critical status.

### 3.9 Analytics & Support

- FR-080: Minimal, privacy-conscious analytics instrumenting core events:

  - event_created, import_started, import_completed, import_errors, first_save, share_link_created, share_link_clicked, export_generated, feedback_submitted.
  - Analytics excludes raw PII; uses hashed identifiers where needed.

- FR-081: In-app support: inline validation messages, downloadable row-level import error reports, “report issue” form, searchable FAQ. Live chat deferred.

### 3.10 Performance and Scalability

- FR-090: Performance target: initial render < 1s for 300 guests on typical modern mobile devices (optimize canvas rendering and virtualization).
- FR-091: Use virtualization for guest lists and efficient canvas rendering; lazy load heavy assets.
- FR-092: Rate limits and safeguards for high-frequency API calls (autosave, exports).

## 4. Product Boundaries

The following items are explicitly out of scope for the MVP:

- PB-001: No venue/blueprint image upload or irregular-shape venue floorplan support. Floorplan is a simple grid layout only.
- PB-002: No real-time multi-user simultaneous editing (true collaborative editing). Soft edit-lock single-editor model only.
- PB-003: No advanced seat-level features such as seat rotation, custom seat geometry, or per-seat accessibility markers.
- PB-004: No integrated payment or billing flows in initial MVP.
- PB-005: Live chat support is deferred until justified by volume; support via “report issue” form and FAQ only.
- PB-006: No automatic RSVP syncing with third-party RSVP providers (outside scope for MVP).
- PB-007: No ability to import venue floorplans as PDFs or images for layout tracing.
- PB-008: No workplace or enterprise SSO beyond Google OAuth at launch.

## 5. User Stories

All user stories are listed below with unique IDs, descriptions, and acceptance criteria. Each story is testable and maps back to the functional requirements.

### Account & Authentication

- ID: US-001  
  Title: Sign up with email and password  
  Description: A new user can sign up using an email address and password to create an account and then create/save events.  
  Acceptance Criteria:

  1.  User can visit sign-up page and enter email, password, and accept terms; submission creates an account and sends verification email.
  2.  Email verification link verifies the account when clicked and allows sign-in.
  3.  Attempting to sign up with an existing email returns a clear error message.
  4.  Password must meet configured complexity rules; weak passwords are rejected with guidance.
  5.  Created accounts persist and can create/save events.

- ID: US-002  
  Title: Sign in with email/password and Google OAuth  
  Description: Existing users can sign in via email/password or via Google OAuth.  
  Acceptance Criteria:

  1.  User can sign in with correct email/password; incorrect credentials are rejected.
  2.  User can sign in using Google OAuth; successful OAuth sign-in links/creates an account.
  3.  Account sessions persist per configured session expiration.
  4.  Failed OAuth flow displays an error and retry option.

- ID: US-003  
  Title: Anonymous preview and prompt to create account on save/share  
  Description: Visitors can preview the app anonymously but must create an account before saving an event or creating a share link.  
  Acceptance Criteria:

  1.  Anonymous user can create an event in preview mode without account and interact with the canvas; no server-side save is persisted.
  2.  When anonymous user selects Save or Create Share Link, a modal requires sign-up/sign-in; modal supports quick email/password sign-up and Google OAuth.
  3.  If user completes sign-up, the current event state is persisted to the new account and the user is redirected to the saved event.

### Event Creation & Basic Flows

- ID: US-010  
  Title: Create a new event  
  Description: Authenticated users can create a new seating event with a name, date, and basic settings (grid dimensions).  
  Acceptance Criteria:

  1.  User can create event by entering event name and optional date; event is created and accessible under My Events.
  2.  Default grid layout provided; user can change grid size before opening canvas.
  3.  Creating an event triggers an initial autosave snapshot.

- ID: US-011  
  Title: Rename and edit event metadata  
  Description: Users can edit event name, date, and settings.  
  Acceptance Criteria:

  1.  User edits metadata in event settings; changes autosave and are visible to owner immediately.
  2.  Metadata changes are captured in version history as a snapshot.

### XLSX Import & Guest Management

- ID: US-020  
  Title: Download sample XLSX template  
  Description: Users can download the canonical sample XLSX file with required columns.  
  Acceptance Criteria:

  1.  Clicking Download Sample returns an XLSX file with columns: Name, InitialTable, Note, OptionalTag and example rows.
  2.  File opens with the specified columns in common spreadsheet tools.

- ID: US-021  
  Title: Upload XLSX and map columns  
  Description: Users can upload a single-sheet XLSX and map the file columns to canonical fields.  
  Acceptance Criteria:

  1.  After upload, UI shows detected columns and allows mapping to canonical fields (Name, InitialTable, Note, OptionalTag).
  2.  Mapping preview shows the first 50 rows after mapping.

- ID: US-022  
  Title: Row-level validation and downloadable error report  
  Description: The import preview validates each row and allows downloading a row-level error report.  
  Acceptance Criteria:

  1.  The preview lists rows with errors (e.g., missing Name, invalid capacity values).
  2.  User can download a CSV/XLSX that lists row number, original data, and specific error messages.
  3.  If any required errors remain, import cannot finalize.

- ID: US-023  
  Title: Fuzzy duplicate detection and suggested merges during import  
  Description: The import preview performs fuzzy duplicate detection, suggests merges, and requires user confirmation for ambiguous merges.  
  Acceptance Criteria:

  1.  System flags potential duplicates and provides suggested groupings with similarity scores.
  2.  User can Accept Merge, Reject Merge, or Review Manually for each suggested grouping.
  3.  Ambiguous groupings requiring user input must be resolved before finalizing import.
  4.  Merges and user decisions are recorded in the import audit trail.

- ID: US-024  
  Title: Manual guest add/edit/delete  
  Description: Users can add, edit, and delete guests from the guest list UI.  
  Acceptance Criteria:

  1.  Add guest dialog accepts at minimum Name; optional fields: Note, Tag, RSVP.
  2.  Editing a guest updates the canvas and autosaves.
  3.  Deleting a guest removes them from tables and the guest list with a confirmation prompt and audit entry.

- ID: US-025  
  Title: Import preview shows fuzzy duplicates and validation errors with merge audit trail  
  Description: After mapping, the preview shows all rows, flagged duplicates, and validation errors; the audit trail stores all merge decisions.  
  Acceptance Criteria:

  1.  Preview shows every row and status (OK, Error, Duplicate Suggested).
  2.  Each merge action appends an audit record with timestamp and user ID.
  3.  Audit trail export is available for admin review.

### Table & Seat Management

- ID: US-030  
  Title: Create and place tables on the grid canvas  
  Description: Users can add round, rectangular, and long tables to the grid and position them.  
  Acceptance Criteria:

  1.  User adds a table and chooses shape and capacity; table appears on canvas and autosaves.
  2.  Tables snap to grid and avoid overlapping where possible.
  3.  Table properties (label, capacity, start-index, head-of-table) are editable.

- ID: US-031  
  Title: Edit table capacity and seat markers  
  Description: Users can change a table's capacity; seat markers update accordingly.  
  Acceptance Criteria:

  1.  Changing capacity increases/decreases seat markers visually and in underlying data.
  2.  If capacity is reduced below assigned guests, user is warned and must resolve overflow (move guests or increase capacity).

- ID: US-032  
  Title: Canonical seat-order rules and per-table overrides  
  Description: Seats are ordered by default clockwise from 12 o'clock; user can override start index and mark head-of-table per table.  
  Acceptance Criteria:

  1.  Default seat numbering is clockwise from top; seat numbers persist across exports and visual renders.
  2.  Per-table settings change seat numbering for that table and are reflected in exports.
  3.  Exported CSV/XLSX seat numbers align with configured seat-order rules.

- ID: US-033  
  Title: Random auto-placement into seats within a table upon assignment  
  Description: When the user assigns guests to a table (drag or bulk assign via InitialTable), the system randomly assigns actual seats on that table following canonical rules.  
  Acceptance Criteria:

  1.  Assigning N guests to a table with M seats results in those guests occupying distinct seat numbers 1..M in a randomized order.
  2.  Randomization is deterministic for the session (documented seed optional) and preserved until the user reassigns seats or triggers reshuffle.
  3.  User can manually swap seats afterward.

- ID: US-034  
  Title: Manual seat swapping and moving guests between tables  
  Description: Users can click/tap to swap seat occupants or drag a guest to another table.  
  Acceptance Criteria:

  1.  Swapping two seats updates seat assignments and autosaves.
  2.  Dragging a guest to another table assigns them a seat on destination table (random seat allocation if multiple seats available or explicit seat drop if user drops to a seat marker).
  3.  Overflow scenarios (table full) block the drop and show a clear message.

- ID: US-035  
  Title: Seat-level visual indicators and non-color cues  
  Description: Seat markers include guest initials/name, seat number, and a non-color indicator to show special statuses (e.g., RSVP: Declined).  
  Acceptance Criteria:

  1.  Non-color indicators (icons/labels/patterns) present for status; they are visible and described to screen readers.
  2.  Colorblind-safe palette is selectable in settings and defaulted.

### Save, Undo/Redo & Versioning

- ID: US-040  
  Title: Automatic save on meaningful changes  
  Description: The app auto-saves on meaningful user actions.  
  Acceptance Criteria:

  1.  Actions such as adding/editing guests, creating/updating tables, seat swaps trigger an autosave call.
  2.  Autosave success/failure is indicated to the user.
  3.  Autosave call rate-limits to avoid excessive network calls, but no user-visible data loss.

- ID: US-041  
  Title: Session undo/redo  
  Description: Users can undo and redo actions in the current session.  
  Acceptance Criteria:

  1.  Undo reverts the most recent meaningful action and updates UI; redo reapplies undone action.
  2.  Undo/redo stack persists across transient autosaves in the same session but not across full session restarts.

- ID: US-042  
  Title: Snapshot/version browser with restore capability  
  Description: Users can view automatic and named snapshots and restore any snapshot.  
  Acceptance Criteria:

  1.  Version browser lists snapshots with timestamp, author, and change summary/diff preview.
  2.  Restoring a snapshot replaces current event state and creates a new snapshot of the previous state.
  3.  Automatic snapshots are retained for 30 days by default; named snapshots are retained indefinitely unless user deletes them.

### Collaboration & Edit Locking

- ID: US-050  
  Title: Soft edit-lock single-editor mode  
  Description: Only one user can edit an event at a time; other users see a “Currently editing” indicator.  
  Acceptance Criteria:

  1.  When User A opens event in edit mode, User B opening the same event while User A is active sees a non-editable view and a “Currently editing by User A since <timestamp>” message.
  2.  If User A loses connection or closes the browser, lock times out after a configurable period (e.g., 10 minutes) and another user can take the lock.
  3.  Owner can force-release a lock with confirmation and audit log entry.

- ID: US-051  
  Title: Conflict detection on resume after offline edit attempt  
  Description: If a user edits offline (local changes saved) and later attempts to sync while another user has edited on server, conflict resolution UI appears.  
  Acceptance Criteria:

  1.  If server state differs from local state at sync time, app presents a side-by-side diff and options: Keep Local, Keep Server, Merge (manual).
  2.  Chosen resolution is applied and recorded in version history.

### Sharing & Access

- ID: US-060  
  Title: Generate view-only share link (default)  
  Description: Owner can create a view-only link for collaborators to view the seating chart.  
  Acceptance Criteria:

  1.  Owner clicks Create Share Link; system returns a unique URL and a toggle to password-protect, set expiration, or revoke.
  2.  By default the shared view shows Name + Table + Seat; notes/contact hidden unless owner opts in.
  3.  Generating a shared link creates a log entry.

- ID: US-061  
  Title: Password protect and set expiration on share links  
  Description: Owner can secure share links with a password and set an expiration timestamp.  
  Acceptance Criteria:

  1.  Owner can add a password to a link; visiting link prompts for password to view.
  2.  Owner can set expiration datetime; after expiration, link returns an unauthorized message.
  3.  Owner can revoke link immediately and revocation is effective across access attempts.

- ID: US-062  
  Title: Shared view shows configurable fields only (PII controls)  
  Description: Owner can toggle additional fields to include in the shared view (notes/contact).  
  Acceptance Criteria:

  1.  Toggling on additional fields updates what anonymous/shared viewers see immediately.
  2.  Access logs reflect whether PII was exposed via a share link.

- ID: US-063  
  Title: Shared link access logs and admin/reporting UI  
  Description: Owner can view recent access events for shared links.  
  Acceptance Criteria:

  1.  Access log shows timestamp, IP, user agent, and optionally anonymized location.
  2.  Owner can filter logs by link and export logs for a date range.

### Exports

- ID: US-070  
  Title: Export print-ready PDF (A4 landscape, 300 DPI)  
  Description: Users can export the floorplan to print-ready PDF with legend and timestamp.  
  Acceptance Criteria:

  1.  Export dialog offers PDF options (include notes, orientation); generating PDF returns an A4 landscape file at 300 DPI including floorplan, legend, table labels, and timestamp.
  2.  Exported PDF visually matches on-screen floorplan in layout and seat numbers.

- ID: US-071  
  Title: Export high-resolution PNG of full floorplan  
  Description: Users can export a high-resolution PNG of the floorplan.  
  Acceptance Criteria:

  1.  Generated PNG captures full floorplan at minimum configured resolution suitable for printing.
  2.  File rendering includes legend and table labels.

- ID: US-072  
  Title: Export XLSX/CSV of final assignments  
  Description: Users can export final guest assignments as XLSX or CSV with configurable columns.  
  Acceptance Criteria:

  1.  Export includes columns: Name, Table, Seat, Note, Tag, RSVP.
  2.  Orientation and notes inclusion options respected.
  3.  Exports are downloaded or accessible via a generated link and logged.

### Privacy, Security & Compliance

- ID: US-080  
  Title: Capture explicit consent at upload with timestamp/IP  
  Description: When importing guest lists, users must check a consent checkbox that logs timestamp and IP.  
  Acceptance Criteria:

  1.  Import upload requires checkbox that states consent; checkbox unchecked blocks upload.
  2.  On upload, backend logs upload event with user ID, timestamp, and uploader IP and stores consent record for compliance.

- ID: US-081  
  Title: Data export & deletion endpoints for DSAR/erasure  
  Description: Users can request data export or deletion; admins/automation process DSAR/erasure requests.  
  Acceptance Criteria:

  1.  User can request a data export which returns a ZIP including event data, guest lists, and audit logs.
  2.  User can request deletion; system queues deletion and reports completion. Deletion removes PII from primary systems and stores a minimal timestamped audit record confirming erasure (not containing PII).
  3.  Requests are rate-limited and logged.

- ID: US-082  
  Title: Encryption in transit and at rest and secure storage of PII  
  Description: All PII is encrypted in transit (TLS) and at rest.  
  Acceptance Criteria:

  1.  All API endpoints require TLS; non-TLS connections are rejected.
  2.  Persistent storage uses encrypted storage and appropriate key management practices (devops verification).

### Accessibility

- ID: US-090  
  Title: Keyboard navigation and screen-reader support for core flows  
  Description: All core app functions (event creation, import mapping, canvas actions) support keyboard navigation and are labeled for screen readers.  
  Acceptance Criteria:

  1.  All interactive elements are reachable via keyboard with logical focus order.
  2.  Canvas elements expose ARIA roles and meaningful labels (e.g., table name, seat number, guest name).
  3.  Automated accessibility scans pass the configured WCAG AA tests for the pages covering core flows.

- ID: US-091  
  Title: Colorblind-safe palettes and non-color indicators  
  Description: Users can select a colorblind-safe palette; important statuses also use icons/patterns.  
  Acceptance Criteria:

  1.  Palette switch updates UI and is preserved per-user settings.
  2.  Status icons/patterns are present and described to screen readers.

### Analytics & Support

- ID: US-100  
  Title: Instrument privacy-conscious analytics for core events  
  Description: Track event_created, import_started/completed, import_errors, first_save, share_link_created/clicked, export_generated, feedback_submitted while avoiding PII.  
  Acceptance Criteria:

  1.  Events are emitted for each instrumented action to analytics backend.
  2.  No PII is included in analytics payload; identifiers are hashed/anonymous.
  3.  Analysts can view aggregated metrics via admin dashboard.

- ID: US-101  
  Title: Inline validation, downloadable import error reports, and report-issue form  
  Description: Provide immediate validation and clear remediation, and a way to report issues.  
  Acceptance Criteria:

  1.  Validation errors appear inline with actionable guidance.
  2.  Users can download error report containing row-level details.
  3.  Report-issue form captures event ID, user description, optional attachments, and creates a ticket.

### Edge Cases & Error Handling

- ID: US-110  
  Title: Handle very large guest lists ( > 300 ) gracefully with virtualization  
  Description: The app supports guest lists beyond 300 guests with acceptable performance degradation.  
  Acceptance Criteria:

  1.  UI remains responsive; guest list virtualization ensures rendering performance.
  2.  Initial render target defined: <1s for 300 guests. For >300, degrade gracefully with progress indicators.

- ID: US-111  
  Title: Import file with unknown/malformed columns  
  Description: If uploaded XLSX has extra or missing columns, mapping UI guides the user.  
  Acceptance Criteria:

  1.  Mapping UI shows unknown columns and allows user to ignore or map them.
  2.  Missing required column Name blocks import until mapped.

- ID: US-112  
  Title: Ambiguous duplicates requiring manual confirmation  
  Description: Ambiguous duplicates must be confirmed before import completes.  
  Acceptance Criteria:

  1.  Import preview prevents finalizing while ambiguous duplicates exist.
  2.  User decisions recorded in audit trail.

- ID: US-113  
  Title: Network failure during autosave or export  
  Description: App handles temporary network failures without data loss.  
  Acceptance Criteria:

  1.  Autosave failures are queued and retried; user is notified.
  2.  If retries fail, local state is preserved until connectivity resumes; conflict resolution applied on sync.

- ID: US-114  
  Title: Attempt to change seat order after export  
  Description: If a user changes canonical seat-order settings after an export, system warns that previously exported seat numbers may no longer match current view.  
  Acceptance Criteria:

  1.  Changing seat-order triggers a confirmation modal warning about export consistency.
  2.  System records note in version history documenting the seat-order change.
