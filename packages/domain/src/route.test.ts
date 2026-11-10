import { describe, expect, it } from 'vitest';
import { MAX_ROUTE_LENGTH, normalizeRoute, routeFromAttributes } from './route';

describe('normalizeRoute', () => {
  it.each([
    ['/api/products', '/api/products'],
    ['/api/products/42', '/api/products/:id'],
    ['/api/orders/3f2504e0-4f89-41d3-9a0c-0305e82c3301', '/api/orders/:id'],
    ['/api/files/deadbeefcafe1234', '/api/files/:id'],
    ['/api/session/aB3dE5gH7jK9mN1pQ3sT5vX', '/api/session/:token'],
    ['/api/products?id=1&token=secret', '/api/products'],
    ['/api/products#frag', '/api/products'],
    ['api/products//list/', '/api/products/list'],
    ['/', '/'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeRoute(input)).toBe(expected);
  });

  it('passes instrumentation route templates through unchanged', () => {
    expect(normalizeRoute('/api/orders/:orderId/items/:itemId')).toBe(
      '/api/orders/:orderId/items/:itemId',
    );
  });

  it('bounds cardinality by segment count and length', () => {
    expect(normalizeRoute('/a/b/c/d/e/f/g/h/i/j')).toBe('/a/b/c/d/e/f/g/h/*');
    expect(normalizeRoute('/' + 'x'.repeat(500)).length).toBeLessThanOrEqual(MAX_ROUTE_LENGTH);
  });

  it('keeps words that merely look hex-ish', () => {
    expect(normalizeRoute('/api/feedback/decade')).toBe('/api/feedback/decade');
  });
});

describe('routeFromAttributes', () => {
  it('prefers http.route', () => {
    expect(
      routeFromAttributes({ 'http.route': '/api/orders/:id', 'url.path': '/api/orders/9' }),
    ).toBe('/api/orders/:id');
  });
  it('falls back to url.path, then http.target, then a full URL', () => {
    expect(routeFromAttributes({ 'url.path': '/api/orders/9' })).toBe('/api/orders/:id');
    expect(routeFromAttributes({ 'http.target': '/api/orders/9?x=1' })).toBe('/api/orders/:id');
    expect(routeFromAttributes({ 'url.full': 'https://svc.example.com/api/orders/9?k=v' })).toBe(
      '/api/orders/:id',
    );
  });
  it('returns an empty route when nothing is known', () => {
    expect(routeFromAttributes({})).toBe('');
  });
});
