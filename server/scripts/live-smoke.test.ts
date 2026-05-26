import { describe, expect, it } from 'vitest';

import { parseArgs, resolveBaseUrl } from '../../scripts/live-smoke.mjs';

describe('live smoke CLI options', () => {
  it('requires an explicit smoke target instead of defaulting to production', () => {
    expect(parseArgs([], {}).baseUrl).toBeNull();
    expect(() => resolveBaseUrl(null)).toThrow(/explicit target/i);
  });

  it('accepts BASE_URL from the environment', () => {
    const options = parseArgs([], {
      BASE_URL: 'https://example.test/',
      SMOKE_REPORT_PATH: 'tmp/smoke.json'
    });

    expect(options).toEqual({
      baseUrl: 'https://example.test/',
      reportPath: 'tmp/smoke.json'
    });
    expect(resolveBaseUrl(options.baseUrl)).toBe('https://example.test');
  });

  it('lets --base-url override the environment target', () => {
    const options = parseArgs(['--base-url', 'http://127.0.0.1:5000'], {
      BASE_URL: 'https://example.test'
    });

    expect(resolveBaseUrl(options.baseUrl)).toBe('http://127.0.0.1:5000');
  });

  it('rejects missing or non-http smoke targets', () => {
    expect(() => parseArgs(['--base-url'], {})).toThrow(/requires a URL value/);
    expect(() => parseArgs(['--report'], {})).toThrow(/requires a file path value/);
    expect(() => resolveBaseUrl('file:///tmp/app')).toThrow(/http or https/);
  });
});
