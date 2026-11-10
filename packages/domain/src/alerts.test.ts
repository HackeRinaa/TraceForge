import { describe, expect, it } from 'vitest';
import { decideIncidentAction, evaluateRule, observedValue, type RuleCondition } from './alerts';

const rule = (over: Partial<RuleCondition> = {}): RuleCondition => ({
  metric: 'error_rate',
  operator: 'gt',
  threshold: 5,
  windowMinutes: 5,
  minRequests: 20,
  ...over,
});

describe('observedValue', () => {
  it('computes each metric from window aggregates', () => {
    const obs = { requests: 200, errors: 20, p95: 640, p99: 1200 };
    expect(observedValue(rule({ metric: 'error_rate' }), obs)).toBe(10);
    expect(observedValue(rule({ metric: 'p95_latency_ms' }), obs)).toBe(640);
    expect(observedValue(rule({ metric: 'p99_latency_ms' }), obs)).toBe(1200);
    expect(observedValue(rule({ metric: 'request_rate', windowMinutes: 5 }), obs)).toBe(40);
  });
  it('is null for ratios and percentiles without traffic', () => {
    const none = { requests: 0, errors: 0, p95: null, p99: null };
    expect(observedValue(rule(), none)).toBeNull();
    expect(observedValue(rule({ metric: 'p95_latency_ms' }), none)).toBeNull();
    expect(observedValue(rule({ metric: 'request_rate' }), none)).toBe(0);
  });
});

describe('evaluateRule', () => {
  it('breaches when the threshold is exceeded with enough traffic', () => {
    const ev = evaluateRule(rule(), { requests: 100, errors: 10, p95: 1, p99: 1 });
    expect(ev).toEqual({ observed: 10, breached: true, insufficientData: false });
  });
  it('does not alert on small samples', () => {
    const ev = evaluateRule(rule({ minRequests: 50 }), {
      requests: 10,
      errors: 10,
      p95: 1,
      p99: 1,
    });
    expect(ev.breached).toBe(false);
    expect(ev.insufficientData).toBe(true);
  });
  it('threshold comparison is strict', () => {
    expect(evaluateRule(rule(), { requests: 100, errors: 5, p95: 1, p99: 1 }).breached).toBe(false);
  });
  it('supports "less than" traffic-drop rules, including zero traffic', () => {
    const drop = rule({ metric: 'request_rate', operator: 'lt', threshold: 10, windowMinutes: 10 });
    expect(evaluateRule(drop, { requests: 0, errors: 0, p95: null, p99: null }).breached).toBe(
      true,
    );
    expect(evaluateRule(drop, { requests: 500, errors: 0, p95: 1, p99: 1 }).breached).toBe(false);
  });
});

describe('decideIncidentAction', () => {
  const breached = { observed: 9, breached: true, insufficientData: false };
  const healthy = { observed: 1, breached: false, insufficientData: false };
  const unknown = { observed: null, breached: false, insufficientData: true };

  it('opens an incident only when none is open', () => {
    expect(decideIncidentAction(null, breached)).toEqual({ action: 'open' });
    expect(decideIncidentAction(null, healthy)).toEqual({ action: 'none' });
  });
  it('never opens a duplicate while an incident is active', () => {
    expect(decideIncidentAction({ recoveryStreak: 0 }, breached)).toEqual({ action: 'refresh' });
  });
  it('resolves only after consecutive healthy evaluations', () => {
    expect(decideIncidentAction({ recoveryStreak: 0 }, healthy)).toEqual({
      action: 'recovering',
      recoveryStreak: 1,
    });
    expect(decideIncidentAction({ recoveryStreak: 1 }, healthy)).toEqual({ action: 'resolve' });
  });
  it('holds state when data is insufficient', () => {
    expect(decideIncidentAction({ recoveryStreak: 1 }, unknown)).toEqual({ action: 'none' });
    expect(decideIncidentAction(null, unknown)).toEqual({ action: 'none' });
  });
});
