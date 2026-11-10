import { describe, expect, it } from 'vitest';
import { errorFingerprint, normalizeErrorText, topFrameFunction } from './fingerprint';

const base = { service: 'payments-svc', errorType: 'TimeoutError', spanName: 'POST /charge' };

describe('normalizeErrorText', () => {
  it('replaces volatile values with placeholders', () => {
    expect(
      normalizeErrorText(
        'Order 12345 for user 3f2504e0-4f89-41d3-9a0c-0305e82c3301 failed after 2000ms',
      ),
    ).toBe('Order <n> for user <uuid> failed after <n>ms');
    expect(normalizeErrorText('Cannot read "email" of undefined at 0xdeadbeef')).toBe(
      'Cannot read <str> of undefined at <hex>',
    );
  });
});

describe('errorFingerprint', () => {
  it('is stable across volatile identifiers in the message', () => {
    const a = errorFingerprint({ ...base, message: 'Timeout after 2000ms for order 101' });
    const b = errorFingerprint({ ...base, message: 'Timeout after 2150ms for order 9042' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('distinguishes different services, types and messages', () => {
    const ref = errorFingerprint({ ...base, message: 'Timeout' });
    expect(errorFingerprint({ ...base, service: 'inventory-svc', message: 'Timeout' })).not.toBe(
      ref,
    );
    expect(errorFingerprint({ ...base, errorType: 'RangeError', message: 'Timeout' })).not.toBe(
      ref,
    );
    expect(errorFingerprint({ ...base, message: 'Connection refused' })).not.toBe(ref);
  });

  it('ignores stack line numbers but not the throwing function', () => {
    const stackA = 'Error: x\n    at chargeCard (/app/pay.js:10:5)\n    at run (/app/main.js:1:1)';
    const stackB = 'Error: x\n    at chargeCard (/app/pay.js:99:12)\n    at run (/app/main.js:7:3)';
    const stackC = 'Error: x\n    at refund (/app/pay.js:10:5)';
    const fp = (stack: string) => errorFingerprint({ ...base, message: 'x', stack });
    expect(fp(stackA)).toBe(fp(stackB));
    expect(fp(stackA)).not.toBe(fp(stackC));
  });
});

describe('topFrameFunction', () => {
  it('extracts the first function name and handles async frames', () => {
    expect(topFrameFunction('Error\n    at async handler (/x.js:1:1)')).toBe('handler');
    expect(topFrameFunction('no frames here')).toBe('');
  });
});
