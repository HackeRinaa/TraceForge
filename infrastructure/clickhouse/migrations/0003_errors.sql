-- One row per errored span, ordered for "group by fingerprint" queries. Fingerprints are computed in the worker
-- from normalized exception type/message so volatile identifiers do not split a group.
CREATE TABLE IF NOT EXISTS errors
(
    project_id        UUID,
    fingerprint       String,
    start_time        DateTime64(6, 'UTC'),
    trace_id          FixedString(32),
    span_id           FixedString(16),
    environment       LowCardinality(String),
    service           LowCardinality(String),
    span_name         String,
    method            LowCardinality(String),
    route             String,
    http_status_code  UInt16,
    error_type        String,
    error_message     String,
    stack             String,
    ingested_at       DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(start_time)
ORDER BY (project_id, fingerprint, start_time, trace_id, span_id)
TTL toDateTime(start_time) + INTERVAL 14 DAY DELETE
