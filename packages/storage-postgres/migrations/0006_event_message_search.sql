-- Word search on events.message (docs/architecture.md, "How the event tables
-- must be built"). Punctuation becomes a word break before the text is
-- parsed, so "db.internal" or "charge-invoice" match a search for either
-- half, and the 'simple' configuration lowercases words without
-- language-specific stemming or stop words. A search therefore means "every
-- word appears in the message", which another engine can answer with a token
-- index. The expression must match MESSAGE_VECTOR in src/event-store.ts.
--
-- Created on the partitioned parent, so every day partition, existing and
-- future, gets its own index.

CREATE INDEX events_message_search_idx ON events
  USING gin (to_tsvector('simple', regexp_replace(message, '[[:punct:][:space:][:cntrl:]]+', ' ', 'g')));
