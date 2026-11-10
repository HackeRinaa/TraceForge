import type { AlertMetric } from '@traceforge/contracts';

export interface RuleCondition {
  metric: AlertMetric;
  operator: 'gt' | 'lt';
  threshold: number;
  windowMinutes: number;
  minRequests: number;
}

/** Aggregates over the rule's evaluation window, computed from stored request telemetry. */
export interface WindowObservation {
  requests: number;
  errors: number;
  p95: number | null;
  p99: number | null;
}

export interface Evaluation {
  /** The value compared against the threshold; null when it cannot be computed. */
  observed: number | null;
  breached: boolean;
  /** True when too little traffic exists to judge a ratio or percentile; the incident state must not change. */
  insufficientData: boolean;
}

export function observedValue(rule: RuleCondition, obs: WindowObservation): number | null {
  switch (rule.metric) {
    case 'request_rate':
      return obs.requests / rule.windowMinutes;
    case 'error_rate':
      return obs.requests === 0 ? null : (obs.errors / obs.requests) * 100;
    case 'p95_latency_ms':
      return obs.requests === 0 ? null : obs.p95;
    case 'p99_latency_ms':
      return obs.requests === 0 ? null : obs.p99;
  }
}

export function evaluateRule(rule: RuleCondition, obs: WindowObservation): Evaluation {
  const observed = observedValue(rule, obs);
  // Zero traffic is a real observation for request_rate ("traffic drop"); for ratios it means "unknown".
  const sampleTooSmall =
    rule.metric !== 'request_rate' && obs.requests < Math.max(1, rule.minRequests);
  if (observed === null || sampleTooSmall)
    return { observed, breached: false, insufficientData: true };
  const breached = rule.operator === 'gt' ? observed > rule.threshold : observed < rule.threshold;
  return { observed, breached, insufficientData: false };
}

export interface OpenIncidentState {
  /** Consecutive healthy evaluations since the condition last held. */
  recoveryStreak: number;
}

export type IncidentDecision =
  | { action: 'none' }
  | { action: 'open' }
  | { action: 'refresh' }
  | { action: 'recovering'; recoveryStreak: number }
  | { action: 'resolve' };

/** Healthy evaluations required before an open incident auto-resolves, to avoid flapping. */
export const RECOVERY_EVALUATIONS = 2;

/**
 * The incident lifecycle as a pure function. At most one non-resolved incident exists per rule, so an already-active
 * alert never creates a duplicate; an acknowledged incident still refreshes and can still auto-resolve.
 */
export function decideIncidentAction(
  open: OpenIncidentState | null,
  ev: Evaluation,
  recoveryEvaluations: number = RECOVERY_EVALUATIONS,
): IncidentDecision {
  if (open === null) return ev.breached ? { action: 'open' } : { action: 'none' };
  if (ev.insufficientData) return { action: 'none' };
  if (ev.breached) return { action: 'refresh' };
  const streak = open.recoveryStreak + 1;
  return streak >= recoveryEvaluations
    ? { action: 'resolve' }
    : { action: 'recovering', recoveryStreak: streak };
}
