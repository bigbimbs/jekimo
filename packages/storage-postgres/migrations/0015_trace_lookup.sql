CREATE INDEX events_trace_received ON events (project_id, (context->>'trace_id'), received_at DESC, event_id DESC)
WHERE context->>'trace_id' IS NOT NULL;
