-- What people tell us, which is the only channel the app has for hearing that
-- something is broken. Deliberately open to signed-out visitors: the most
-- valuable message is from somebody who could not get the thing to work at all,
-- and that person does not have an account.

CREATE TABLE IF NOT EXISTS feedback (
  id          uuid        PRIMARY KEY,
  subject     text        NOT NULL,
  body        text        NOT NULL,

  -- Optional, because demanding it costs more messages than it gains replies.
  email       text,

  -- Set when the sender happened to be signed in. Kept as a reference rather
  -- than a copy, and it survives the account being deleted so the message is
  -- not lost with it.
  user_id     uuid        REFERENCES users (id) ON DELETE SET NULL,

  -- "It does not work on my television" is unanswerable without this.
  user_agent  text,

  created_at  timestamptz NOT NULL DEFAULT now()
);

-- The only query anyone runs on this is "what came in lately".
CREATE INDEX IF NOT EXISTS feedback_created_at_idx ON feedback (created_at DESC);
