import { describe, it, expect } from 'vitest';
import { normalizeSubject, escapeLike, formatAddress } from '../src/utils.js';

describe('normalizeSubject', () => {
  it('returns plain subjects unchanged (trimmed)', () => {
    expect(normalizeSubject('Meeting notes')).toBe('Meeting notes');
    expect(normalizeSubject('  spaced  ')).toBe('spaced');
  });

  it('strips a single Re:/RE: prefix', () => {
    expect(normalizeSubject('Re: Hello')).toBe('Hello');
    expect(normalizeSubject('RE: Hello')).toBe('Hello');
  });

  it('strips forward prefixes (Fw/FW/Fwd)', () => {
    expect(normalizeSubject('Fw: Doc')).toBe('Doc');
    expect(normalizeSubject('FW: Doc')).toBe('Doc');
    expect(normalizeSubject('Fwd: Doc')).toBe('Doc');
  });

  it('strips Japanese 転送 / 返信 prefixes', () => {
    expect(normalizeSubject('返信: 会議')).toBe('会議');
    expect(normalizeSubject('転送: 資料')).toBe('資料');
  });

  it('strips repeated/stacked prefixes', () => {
    expect(normalizeSubject('Re: Re: Fwd: Topic')).toBe('Topic');
    expect(normalizeSubject('RE: 返信: Subject')).toBe('Subject');
  });

  it('strips Re[N]: numbered counters', () => {
    expect(normalizeSubject('Re[2]: Status')).toBe('Status');
    expect(normalizeSubject('Re[10]: Re: Status')).toBe('Status');
  });

  it('does not strip prefixes that appear mid-subject', () => {
    expect(normalizeSubject('Notes Re: nothing')).toBe('Notes Re: nothing');
  });

  it('leaves unrecognized casing (e.g. lowercase "re:") intact', () => {
    // The normalizer only matches the explicit casings Re/RE/Fw/FW/Fwd.
    expect(normalizeSubject('re: hello')).toBe('re: hello');
  });
});

describe('escapeLike', () => {
  it('leaves plain text unchanged', () => {
    expect(escapeLike('hello world')).toBe('hello world');
  });

  it('escapes percent signs', () => {
    expect(escapeLike('50%')).toBe('50\\%');
  });

  it('escapes underscores', () => {
    expect(escapeLike('a_b')).toBe('a\\_b');
  });

  it('escapes backslashes (the escape char itself)', () => {
    expect(escapeLike('a\\b')).toBe('a\\\\b');
  });

  it('escapes a mix of wildcards', () => {
    expect(escapeLike('%_\\')).toBe('\\%\\_\\\\');
  });

  it('makes a literal pattern that only matches itself under ESCAPE semantics', () => {
    // Build the pattern as the tools do: %<escaped>%
    const pattern = `%${escapeLike('100%_done')}%`;
    expect(pattern).toBe('%100\\%\\_done%');
  });
});

describe('formatAddress', () => {
  it('returns "" when address is null/empty', () => {
    expect(formatAddress('Alice', null)).toBe('');
    expect(formatAddress(null, null)).toBe('');
    expect(formatAddress('Bob', '')).toBe('');
  });

  it('returns just the address when there is no display name', () => {
    expect(formatAddress(null, 'a@example.com')).toBe('a@example.com');
    expect(formatAddress('', 'a@example.com')).toBe('a@example.com');
  });

  it('formats "DisplayName <address>" when both are present', () => {
    expect(formatAddress('Alice', 'alice@example.com')).toBe('Alice <alice@example.com>');
  });
});
