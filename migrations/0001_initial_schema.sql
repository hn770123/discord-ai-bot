-- Phase 1 の初期スキーマ。Discord の snowflake は精度損失を避けるため TEXT で保持する。
CREATE TABLE users (
  discord_user_id TEXT PRIMARY KEY NOT NULL,
  brief TEXT,
  timezone TEXT NOT NULL,
  brief_updated_at TEXT
);

CREATE TABLE channel_checkpoints (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  last_ai_message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY NOT NULL,
  created_by_user_id TEXT NOT NULL,
  target_user_id TEXT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message TEXT NOT NULL CHECK (length(message) > 0),
  remind_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT
);

CREATE INDEX reminders_due_idx
  ON reminders (status, next_attempt_at);

CREATE INDEX reminders_context_idx
  ON reminders (guild_id, channel_id, id);

CREATE TABLE allowed_guilds (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE allowed_users (
  user_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);
