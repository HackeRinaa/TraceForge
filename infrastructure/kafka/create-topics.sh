#!/bin/bash
# Creates the TraceForge topics idempotently. Keep in sync with packages/messaging/src/topics.ts.
set -euo pipefail

KT=/opt/kafka/bin/kafka-topics.sh
BS="${BOOTSTRAP_SERVER:-kafka:19092}"

# Spans: keyed by trace ID, 6 partitions allows up to 6 parallel consumers.
$KT --bootstrap-server "$BS" --create --if-not-exists --topic telemetry.spans.v1 \
  --partitions 6 --replication-factor 1 \
  --config retention.ms=86400000 --config max.message.bytes=1048576 --config compression.type=producer

# Dead-letter topic: longer retention so operators have time to inspect and replay.
$KT --bootstrap-server "$BS" --create --if-not-exists --topic telemetry.dlq.v1 \
  --partitions 1 --replication-factor 1 \
  --config retention.ms=604800000 --config max.message.bytes=1048576

$KT --bootstrap-server "$BS" --list
