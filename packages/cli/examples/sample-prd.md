# PRD: URL Shortener Service

**Version:** 1.0  
**Status:** Draft  
**Purpose:** Dogfood PRD for agent-trail Day 7 end-to-end test

---

## Overview

A minimal URL shortener that creates short aliases for long URLs, tracks click counts, and exposes a REST API. Single-user, no auth required for MVP.

---

## Goals

1. Accept a long URL and return a short code (e.g. `/r/abc123`)
2. Redirect short codes to their original URL
3. Track click count per short code
4. Expose a `/stats/:code` endpoint returning click count + creation date
5. Reject invalid URLs with a clear error message

---

## Non-goals

- User accounts or authentication
- Custom aliases
- Link expiry
- Analytics dashboard (just the count endpoint)

---

## Technical requirements

- **Runtime:** Bun
- **Framework:** Hono
- **Storage:** SQLite (bun:sqlite)
- **Short code generation:** 6-character base62 (alphanumeric)
- **Collision handling:** retry up to 5 times, then error
- **API versioning:** none for MVP

---

## API

### `POST /shorten`

Request:
```json
{ "url": "https://example.com/very/long/path" }
```

Response (201):
```json
{ "code": "abc123", "short_url": "http://localhost:3000/r/abc123" }
```

Error (400):
```json
{ "error": "Invalid URL" }
```

### `GET /r/:code`

Redirects (302) to the original URL. Returns 404 if code not found.

### `GET /stats/:code`

Response (200):
```json
{ "code": "abc123", "original_url": "https://...", "clicks": 42, "created_at": "2025-01-01T00:00:00Z" }
```

---

## Acceptance criteria

- [ ] `POST /shorten` with a valid URL returns a 6-char code
- [ ] `GET /r/:code` redirects to the original URL and increments click count
- [ ] `GET /stats/:code` returns correct click count after 3 redirects
- [ ] `POST /shorten` with an invalid URL returns 400
- [ ] `GET /r/nonexistent` returns 404
- [ ] All endpoints have at least one passing test (bun:test)
