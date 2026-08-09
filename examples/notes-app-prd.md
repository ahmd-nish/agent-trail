# PRD: Notes API

**Version:** 1.0
**Status:** Draft
**Purpose:** End-to-end test PRD for inventarium — exercises CRUD, search, and a many-to-many relationship under the TDD gate.

---

## Overview

A minimal personal notes API. Single user, no auth. Notes are markdown text with a title; each note can have zero or more tags. The API supports create / list / get / update / delete on notes, attach/detach for tags, and full-text search over title + body.

The goal is a small but non-trivial backend: enough variety (CRUD + relationships + search + pagination) to produce a realistic 8-12 task graph, and small enough to actually finish in one session.

---

## Goals

1. CRUD a `Note` with `title`, `body`, `created_at`, `updated_at`
2. CRUD a `Tag` with a unique `name`
3. Attach and detach tags from notes (many-to-many)
4. List notes with filtering by tag and pagination (`limit`, `offset`)
5. Full-text search over note title + body (case-insensitive substring)
6. Validate inputs and return clear 4xx errors

---

## Non-goals

- Authentication or user accounts
- Sharing / multi-user
- Markdown rendering (store raw text, return raw text)
- File attachments
- Soft delete / trash
- Webhooks or background jobs

---

## Technical requirements

- **Runtime:** Bun
- **Framework:** Hono
- **Storage:** SQLite (bun:sqlite) with foreign keys ON
- **IDs:** UUID v4 strings
- **Timestamps:** ISO-8601 UTC strings (`2026-05-22T13:14:15.123Z`)
- **Port:** 3100 (do not collide with inventarium's 3002)
- **Test framework:** bun:test

---

## Data model

```
notes:    id, title, body, created_at, updated_at
tags:     id, name UNIQUE
note_tags: note_id FK, tag_id FK, PRIMARY KEY (note_id, tag_id)
```

---

## API

### Notes

#### `POST /notes`

Request:
```json
{ "title": "Grocery list", "body": "milk, eggs, bread" }
```

Response (201):
```json
{ "id": "…", "title": "Grocery list", "body": "milk, eggs, bread",
  "tags": [], "created_at": "…", "updated_at": "…" }
```

Errors: 400 if `title` missing or empty.

#### `GET /notes`

Query params (all optional):
- `q` — search string, case-insensitive substring match against `title` and `body`
- `tag` — only return notes that have this tag name
- `limit` — max 100, default 20
- `offset` — default 0

Response (200):
```json
{ "items": [ { "id": "…", "title": "…", "body": "…", "tags": ["work"], "created_at": "…", "updated_at": "…" } ],
  "total": 42 }
```

`total` is the count *before* limit/offset, so pagination UIs work.

#### `GET /notes/:id`

Response (200): single note with embedded `tags: string[]`.
Errors: 404 if not found.

#### `PATCH /notes/:id`

Partial update: any of `title`, `body`. Updates `updated_at`.
Response (200): updated note. Errors: 404; 400 if no fields provided.

#### `DELETE /notes/:id`

Response (204) no body.
Cascade: also deletes `note_tags` rows for that note. Tags themselves remain.

### Tags

#### `POST /tags`

Request: `{ "name": "work" }`. Trim + lowercase server-side.
Response (201): `{ "id": "…", "name": "work" }`.
Errors: 400 if `name` empty; 409 if name already exists (return the existing row).

#### `GET /tags`

Response (200): `[ { "id": "…", "name": "work", "note_count": 3 } ]`, sorted by name ascending.

#### `DELETE /tags/:id`

Response (204). Removes the tag and all `note_tags` rows referencing it. Notes themselves remain.

### Note ↔ Tag

#### `POST /notes/:id/tags`

Attach a tag. Creates the tag if it doesn't exist.

Request: `{ "name": "work" }`
Response (200): the updated note (with the new tag in its `tags` array).
Errors: 404 if note not found.

#### `DELETE /notes/:id/tags/:tagName`

Detach a tag from a note. The tag itself stays.
Response (204). 404 if note or attachment doesn't exist.

---

## Acceptance criteria

- [ ] `POST /notes` with title + body returns 201 and a UUID
- [ ] `POST /notes` with empty title returns 400
- [ ] `GET /notes/:id` returns the note with `tags: []` when none attached
- [ ] `PATCH /notes/:id` updates only the provided fields and bumps `updated_at`
- [ ] `DELETE /notes/:id` returns 204 and the note is gone from `GET /notes`
- [ ] `POST /tags` with a new name returns 201; with an existing name returns 409 + the existing row
- [ ] Tag names are stored lowercase ("Work" → "work")
- [ ] `POST /notes/:id/tags` with a brand-new tag name creates the tag and attaches it in one call
- [ ] `DELETE /notes/:id/tags/:tagName` detaches but leaves the tag and the note intact
- [ ] `GET /notes?tag=work` only returns notes with the "work" tag
- [ ] `GET /notes?q=milk` matches notes containing "milk" in title OR body, case-insensitive
- [ ] `GET /notes?limit=2&offset=2` returns the 3rd–4th items and `total` reflects the full count
- [ ] Deleting a tag removes all its attachments but leaves the notes
- [ ] All endpoints have at least one passing test (bun:test) covering the happy path and at least one error path

---

## Out of scope (do NOT implement)

- A `/health` endpoint (not needed for tests)
- OpenAPI / Swagger docs
- Rate limiting
- CORS configuration
- Logging beyond what Hono provides by default
- Any frontend
