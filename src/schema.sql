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
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cards_board_idx ON cards (board_id);

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

-- APNs device tokens for push notifications (one row per device token).
CREATE TABLE IF NOT EXISTS device_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   text NOT NULL DEFAULT 'ios',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_tokens_user_idx ON device_tokens (user_id);

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
