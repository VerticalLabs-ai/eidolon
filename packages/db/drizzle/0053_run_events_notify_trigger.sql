-- SSE LISTEN/NOTIFY: trigger on run_events INSERT emits a per-run NOTIFY
-- channel with the event sequence as the payload. The SSE stream
-- (stream.ts) LISTENs on `run_event_<runId>` for push-based delivery with
-- sub-200ms latency, falling back to 200ms polling as a safety net.
--
-- VAL-M1-077: Postgres trigger emits NOTIFY on run_events INSERT.
-- VAL-M1-078: NOTIFY payload contains only the sequence number.
-- VAL-M1-084: Per-run channel isolation (channel name parameterized by runId).
--
-- Idempotent: uses CREATE OR REPLACE FUNCTION and DROP TRIGGER IF EXISTS
-- so re-running the migration (or applying on a database where it was
-- manually installed) is safe. The trigger fires AFTER INSERT FOR EACH ROW
-- and calls pg_notify with the channel name `run_event_<runId>` and the
-- sequence number as the payload string.

CREATE OR REPLACE FUNCTION notify_run_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('run_event_' || NEW.run_id, NEW.sequence::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS run_events_notify_trigger ON "run_events";--> statement-breakpoint
CREATE TRIGGER run_events_notify_trigger
  AFTER INSERT ON "run_events"
  FOR EACH ROW
  EXECUTE FUNCTION notify_run_event();
