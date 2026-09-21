-- Folio schema. Idempotent so the migrate script can run it repeatedly.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Global monotonic sequence powering the sync change-log.
CREATE SEQUENCE IF NOT EXISTS change_seq;

CREATE TABLE IF NOT EXISTS users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  apple_sub    text UNIQUE NOT NULL,
  handle       text UNIQUE,
  display_name text,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS boards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id),
  name          text NOT NULL,
  emoji         text,
  cover_card_id uuid,
  kind          text NOT NULL DEFAULT 'solo' CHECK (kind IN ('solo','shared')),
  private       boolean NOT NULL DEFAULT false,   -- hidden from MCP / AI-tool access
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS board_members (
  board_id  uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id),
  role      text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, user_id)
);

CREATE TABLE IF NOT EXISTS cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id      uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  added_by      uuid NOT NULL REFERENCES users(id),
  source_url    text,
  source_kind   text CHECK (source_kind IN ('post','reel','media')),
  type          text NOT NULL DEFAULT 'other'
                CHECK (type IN ('recipe','place','interior','fit','link','other')),
  status        text NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','ready','failed','stale')),
  title         text,
  thumb_url     text,
  media_urls    jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_handle text,
  caption       text,
  extracted     jsonb,
  user_note     text,
  tried_at      timestamptz,
  raw_text      text,          -- capped source text for on-device record extraction
  event_at      timestamptz,   -- the one actionable date (arrives / due / check-in…)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_board_idx ON cards (board_id);
-- Backfill columns on already-deployed databases (CREATE above only covers fresh).
ALTER TABLE cards ADD COLUMN IF NOT EXISTS raw_text text;
ALTER TABLE cards ADD COLUMN IF NOT EXISTS event_at timestamptz;
-- Reconciliation key (family:reference, e.g. "flight:ZXRQ9T"): later emails about
-- the same booking update the same card. Null = not reconcilable.
ALTER TABLE cards ADD COLUMN IF NOT EXISTS ref text;
CREATE INDEX IF NOT EXISTS cards_owner_ref_idx ON cards (added_by, ref);
-- Opt-in public read-only page slug for a board (null = private).
ALTER TABLE boards ADD COLUMN IF NOT EXISTS public_slug text;
-- Boards the user has marked private (e.g. secret/Face-ID boards): excluded from
-- MCP so AI tools never see them.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS private boolean NOT NULL DEFAULT false;

-- Personal access tokens for the per-user MCP endpoint. The raw token is shown
-- once and only its SHA-256 hash is stored. `scope` gates write tools.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  label        text,
  scope        text NOT NULL DEFAULT 'read' CHECK (scope IN ('read','read_write')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_tokens_user_idx ON mcp_tokens (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS boards_public_slug_idx ON boards (public_slug);

-- Append-only log of the emails that contributed to a reconciled record. The
-- card's `extracted` is a projection folded from these in message-date order.
CREATE TABLE IF NOT EXISTS card_sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id      uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_date timestamptz NOT NULL,
  subject      text,
  rec          jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS card_sources_card_idx ON card_sources (card_id, message_date);

-- Brand logo cache: one row per registrable domain, url re-hosted on our bucket
-- (empty url marks a domain we tried and couldn't get a logo for).
CREATE TABLE IF NOT EXISTS brand_logos (
  domain     text PRIMARY KEY,
  url        text NOT NULL DEFAULT '',
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS card_comments (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_card_idx ON card_comments (card_id);

-- Per-user personal rating (1–5) on a card. One rating per (card, user).
CREATE TABLE IF NOT EXISTS card_ratings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  rating     int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, user_id)
);
CREATE INDEX IF NOT EXISTS ratings_card_idx ON card_ratings (card_id);

-- Per-user favourites. One per (card, user).
CREATE TABLE IF NOT EXISTS card_faves (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (card_id, user_id)
);
CREATE INDEX IF NOT EXISTS faves_card_idx ON card_faves (card_id);

-- Per-card checklist items (board-shared: anyone on the board can add/tick).
CREATE TABLE IF NOT EXISTS card_tasks (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id    uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  text       text NOT NULL,
  done       boolean NOT NULL DEFAULT false,
  position   double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_card_idx ON card_tasks (card_id);

-- APNs device tokens for push notifications (one row per device token).
CREATE TABLE IF NOT EXISTS device_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   text NOT NULL DEFAULT 'ios',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens (user_id);

-- One row per (user, week) once we've sent that user their weekly resurface
-- digest — claimed before sending so a crash mid-sweep never double-fires.
CREATE TABLE IF NOT EXISTS push_digests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week    date NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, week)
);

-- Email-to-Folio: a stable secret forwarding token per user. Mail sent to
-- <token>@<INBOUND_DOMAIN> creates cards for that user.
CREATE TABLE IF NOT EXISTS inbound_addresses (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creator_memory (
  user_id       uuid NOT NULL REFERENCES users(id),
  handle        text NOT NULL,
  last_board_id uuid REFERENCES boards(id) ON DELETE SET NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, handle)
);

CREATE TABLE IF NOT EXISTS board_invites (
  token      text PRIMARY KEY,
  board_id   uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Bookkeeping for the extraction retry/backoff schedule.
CREATE TABLE IF NOT EXISTS card_extraction_state (
  card_id       uuid PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
  attempts      int NOT NULL DEFAULT 0,
  next_stage    text,
  last_error    text,
  next_retry_at timestamptz NOT NULL DEFAULT now()
);

-- Unified change-log: one strict total order across entities for sync.
CREATE TABLE IF NOT EXISTS change_log (
  seq        bigint PRIMARY KEY DEFAULT nextval('change_seq'),
  entity     text NOT NULL,
  entity_id  uuid NOT NULL,
  board_id   uuid,
  op         text NOT NULL CHECK (op IN ('upsert','delete')),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS change_log_board_seq_idx ON change_log (board_id, seq);

-- Synced background (e.g. "gradient:sunset"). Added post-hoc; idempotent.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS background text;
ALTER TABLE cards  ADD COLUMN IF NOT EXISTS background text;

-- Last time the price-watch worker re-checked a product card's price. Server-
-- internal (not synced); paces re-fetches so we don't hammer stores.
ALTER TABLE cards  ADD COLUMN IF NOT EXISTS last_price_checked_at timestamptz;

-- Trigger helpers ----------------------------------------------------------

CREATE OR REPLACE FUNCTION log_change() RETURNS trigger AS $$
DECLARE
  v_entity   text := TG_ARGV[0];
  v_board    uuid;
  v_id       uuid;
  v_op       text;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    v_op := 'delete';
    v_id := OLD.id;
  ELSE
    v_op := 'upsert';
    v_id := NEW.id;
  END IF;

  -- Resolve the owning board for authorization scoping in sync.
  IF v_entity = 'board' THEN
    v_board := v_id;
  ELSIF v_entity = 'card' THEN
    v_board := COALESCE(NEW.board_id, OLD.board_id);
  ELSIF v_entity = 'comment' THEN
    SELECT board_id INTO v_board FROM cards WHERE id = COALESCE(NEW.card_id, OLD.card_id);
  ELSIF v_entity = 'rating' THEN
    SELECT board_id INTO v_board FROM cards WHERE id = COALESCE(NEW.card_id, OLD.card_id);
  ELSIF v_entity = 'fave' THEN
    SELECT board_id INTO v_board FROM cards WHERE id = COALESCE(NEW.card_id, OLD.card_id);
  ELSIF v_entity = 'task' THEN
    SELECT board_id INTO v_board FROM cards WHERE id = COALESCE(NEW.card_id, OLD.card_id);
  END IF;

  INSERT INTO change_log (entity, entity_id, board_id, op)
  VALUES (v_entity, v_id, v_board, v_op);

  IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

-- board_member changes stamp the board so members learn about roster changes.
CREATE OR REPLACE FUNCTION log_member_change() RETURNS trigger AS $$
DECLARE
  v_board uuid;
BEGIN
  v_board := COALESCE(NEW.board_id, OLD.board_id);
  INSERT INTO change_log (entity, entity_id, board_id, op)
  VALUES ('board_member', v_board, v_board,
          CASE WHEN TG_OP = 'DELETE' THEN 'delete' ELSE 'upsert' END);
  IF (TG_OP = 'DELETE') THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_board_change ON boards;
CREATE TRIGGER trg_board_change
  AFTER INSERT OR UPDATE OR DELETE ON boards
  FOR EACH ROW EXECUTE FUNCTION log_change('board');

DROP TRIGGER IF EXISTS trg_card_change ON cards;
CREATE TRIGGER trg_card_change
  AFTER INSERT OR UPDATE OR DELETE ON cards
  FOR EACH ROW EXECUTE FUNCTION log_change('card');

DROP TRIGGER IF EXISTS trg_comment_change ON card_comments;
CREATE TRIGGER trg_comment_change
  AFTER INSERT OR UPDATE OR DELETE ON card_comments
  FOR EACH ROW EXECUTE FUNCTION log_change('comment');

DROP TRIGGER IF EXISTS trg_member_change ON board_members;
CREATE TRIGGER trg_member_change
  AFTER INSERT OR UPDATE OR DELETE ON board_members
  FOR EACH ROW EXECUTE FUNCTION log_member_change();

DROP TRIGGER IF EXISTS trg_rating_change ON card_ratings;
CREATE TRIGGER trg_rating_change
  AFTER INSERT OR UPDATE OR DELETE ON card_ratings
  FOR EACH ROW EXECUTE FUNCTION log_change('rating');

DROP TRIGGER IF EXISTS trg_fave_change ON card_faves;
CREATE TRIGGER trg_fave_change
  AFTER INSERT OR UPDATE OR DELETE ON card_faves
  FOR EACH ROW EXECUTE FUNCTION log_change('fave');

DROP TRIGGER IF EXISTS trg_task_change ON card_tasks;
CREATE TRIGGER trg_task_change
  AFTER INSERT OR UPDATE OR DELETE ON card_tasks
  FOR EACH ROW EXECUTE FUNCTION log_change('task');
