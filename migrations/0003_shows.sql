-- What a show is, so that one outlives the process running it.
--
-- Until now every broadcast lived only in one Node process's memory, which
-- meant a deploy — or a crash, or the platform moving a container — ended every
-- show that was running. Hand-off is sold on a one-to-48-hour promise that the
-- server could not actually keep.
--
-- What is stored here is the show's identity and its clock. What is NOT stored
-- is the pictures: those stay on the presenter's device and on the screens that
-- copied them, which is the claim the whole product rests on. This table would
-- let a restarted server say "yes, that code is real, here is what it is" — it
-- would never let it serve a slide by itself.
--
-- Nothing here needs writing per slide. A handed-off show derives the current
-- slide from created_at, interval_ms and the wall clock, so those three columns
-- restore it exactly; a live show is driven by the presenter, who pushes the
-- state again on reconnecting. So the write pattern is one insert when a show
-- starts, one update if its life is extended, and one delete when it ends.

CREATE TABLE IF NOT EXISTS shows (
  code           text        PRIMARY KEY,

  -- Joining proves knowledge of the password without the password being here.
  salt           text        NOT NULL,
  password_hash  text        NOT NULL,
  -- Binds a cast ticket to this show, and is re-issued if the show is remade.
  nonce          text        NOT NULL,

  -- Deleting an account takes its shows with it; there is nobody left to run them.
  user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Denormalised on purpose: viewers are shown the presenter's display name, and
  -- a restarted server should not need a join to answer a poll.
  username       text        NOT NULL,

  title          text,
  photo_count    integer     NOT NULL,
  mode           text        NOT NULL,
  interval_ms    integer     NOT NULL,

  created_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL
);

-- The sweeper asks "what has expired" far more often than anything else.
CREATE INDEX IF NOT EXISTS shows_expires_at_idx ON shows (expires_at);

-- "My shows" is the other query, and it runs on every visit to the library.
CREATE INDEX IF NOT EXISTS shows_user_id_idx ON shows (user_id);
