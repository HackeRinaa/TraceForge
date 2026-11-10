-- Every span, keyed for trace lookup. Re-delivered spans share the sorting key and collapse during merges.
-- Queries that need exact counts must not rely on merges having happened (see docs/decisions/0004-idempotent-persistence.md).
CREATE TABLE IF NOT EXISTS spans
(
    project_id        UUID,
    trace_id          FixedString(32),
    span_id           FixedString(16),
    parent_span_id    String,
    name              String,
    kind              UInt8,
    service           LowCardinality(String),
    environment       LowCardinality(String),
    start_time        DateTime64(6, 'UTC'),
    duration_us       UInt64,
    status_code       UInt8,
    status_message    String,
    http_method       LowCardinality(String),
    http_status_code  UInt16,
    route             String,
    is_root           UInt8,
    is_entry          UInt8,
    error_fingerprint String,
    attributes        Map(String, String),
    resource          Map(String, String),
    events            String,
    received_at       DateTime64(3, 'UTC'),
    ingested_at       DateTime64(3, 'UTC'),
    INDEX idx_service service TYPE set(256) GRANULARITY 4,
    INDEX idx_start start_time TYPE minmax GRANULARITY 1,
    INDEX idx_duration duration_us TYPE minmax GRANULARITY 4
)
ENGINE = ReplacingMergeTree(ingested_at)
PARTITION BY toYYYYMMDD(start_time)
ORDER BY (project_id, trace_id, span_id)
TTL toDateTime(start_time) + INTERVAL 14 DAY DELETE
