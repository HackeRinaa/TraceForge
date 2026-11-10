-- Request-level telemetry: one row per entry (server) span with an HTTP method. Time-first sorting key so
-- dashboard range queries prune granules; endpoint filters apply within the time prefix.
CREATE TABLE IF NOT EXISTS requests
(
    project_id   UUID,
    environment  LowCardinality(String),
    service      LowCardinality(String),
    method       LowCardinality(String),
    route        String,
    start_time   DateTime64(6, 'UTC'),
    trace_id     FixedString(32),
    span_id      FixedString(16),
    duration_ms  Float64,
    status_code  UInt16,
    is_error     UInt8,
    received_at  DateTime64(3, 'UTC'),
    ingested_at  DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(start_time)
ORDER BY (project_id, toStartOfHour(start_time), environment, service, method, route, trace_id, span_id)
TTL toDateTime(start_time) + INTERVAL 14 DAY DELETE
