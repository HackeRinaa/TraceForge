import { describe, expect, it } from 'vitest';
import {
  MAX_ATTRIBUTES,
  MAX_ATTRIBUTE_VALUE_LENGTH,
  isSensitiveKey,
  maskQueryLiterals,
  sanitizeAttributes,
  stripUrlQuery,
} from './sanitize';

describe('isSensitiveKey', () => {
  it.each([
    'http.request.header.authorization',
    'http.request.header.cookie',
    'http.response.header.set-cookie',
    'db.password',
    'user.email',
    'x-api-key',
    'client.secret',
    'auth.token',
    'session.id',
  ])('flags %s', (key) => expect(isSensitiveKey(key)).toBe(true));

  it.each([
    'http.method',
    'http.route',
    'gen_ai.usage.input_tokens',
    'db.system',
    'messaging.destination.name',
  ])('keeps %s', (key) => expect(isSensitiveKey(key)).toBe(false));
});

describe('sanitizeAttributes', () => {
  it('drops sensitive keys and counts them as redacted', () => {
    const { attributes, redacted } = sanitizeAttributes({
      'http.method': 'GET',
      'http.request.header.authorization': 'Bearer abc',
      'url.query': 'token=abc',
    });
    expect(attributes).toEqual({ 'http.method': 'GET' });
    expect(redacted).toBe(2);
  });

  it('strips query strings from URL attributes', () => {
    const { attributes } = sanitizeAttributes({ 'url.full': 'https://x.test/a/b?token=zzz&id=4' });
    expect(attributes['url.full']).toBe('https://x.test/a/b');
  });

  it('masks literals in SQL statements', () => {
    const { attributes } = sanitizeAttributes({
      'db.statement': "SELECT * FROM users WHERE email = 'a@b.com' AND id = 42",
    });
    expect(attributes['db.statement']).toBe('SELECT * FROM users WHERE email = ? AND id = ?');
  });

  it('caps value length and attribute count', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_ATTRIBUTES + 10; i++) many[`k${i}`] = 'v';
    many.long = 'x'.repeat(MAX_ATTRIBUTE_VALUE_LENGTH + 500);
    const { attributes } = sanitizeAttributes(many);
    expect(Object.keys(attributes).length).toBeLessThanOrEqual(MAX_ATTRIBUTES);
    const full = sanitizeAttributes({ long: many.long ?? '' });
    expect(full.attributes.long).toHaveLength(MAX_ATTRIBUTE_VALUE_LENGTH);
  });
});

describe('helpers', () => {
  it('stripUrlQuery handles fragments and absent queries', () => {
    expect(stripUrlQuery('/a?b=1')).toBe('/a');
    expect(stripUrlQuery('/a#x')).toBe('/a');
    expect(stripUrlQuery('/a')).toBe('/a');
  });
  it('maskQueryLiterals handles escaped quotes and decimals', () => {
    expect(maskQueryLiterals("WHERE a = 'it''s' AND b > 3.14")).toBe('WHERE a = ? AND b > ?');
  });
});
