import { describe, expect, it } from 'vitest';
import { formatAddress, parseAddress, parseAddressList, shortName, uniqueAddresses } from './addresses';

describe('address chips', () => {
  it('reads bare, named and quoted addresses', () => {
    expect(parseAddress('ann@example.com')).toEqual({ name: '', address: 'ann@example.com' });
    expect(parseAddress('Ann Lee <ann@example.com>')).toEqual({ name: 'Ann Lee', address: 'ann@example.com' });
    expect(parseAddress('"Lee, Ann" <ann@example.com>')).toEqual({ name: 'Lee, Ann', address: 'ann@example.com' });
    expect(parseAddress('mailto:bob@x.test')).toEqual({ name: '', address: 'bob@x.test' });
    expect(parseAddress('not an address')).toBeNull();
    expect(parseAddress('Bob <bob@nowhere>')).toBeNull();
  });

  it('splits a pasted list on commas, semicolons and new lines, but not inside quotes', () => {
    const { addresses, invalid } = parseAddressList('"Lee, Ann" <ann@example.com>, bob@x.test; Chen <chen@y.test>\nnope, dana@z.test');
    expect(addresses.map((a) => a.address)).toEqual(['ann@example.com', 'bob@x.test', 'chen@y.test', 'dana@z.test']);
    expect(addresses[0]!.name).toBe('Lee, Ann');
    expect(invalid).toEqual(['nope']);
  });

  it('writes an address back, quoting names that need it', () => {
    expect(formatAddress({ name: 'Lee, Ann', address: 'ann@example.com' })).toBe('"Lee, Ann" <ann@example.com>');
    expect(formatAddress({ name: 'Ann', address: 'ann@example.com' })).toBe('Ann <ann@example.com>');
    expect(formatAddress({ name: '', address: 'ann@example.com' })).toBe('ann@example.com');
    expect(parseAddress(formatAddress({ name: 'Lee, Ann', address: 'ann@example.com' }))).toEqual({ name: 'Lee, Ann', address: 'ann@example.com' });
  });

  it('keeps each address once, ignoring case', () => {
    expect(uniqueAddresses([{ name: '', address: 'A@x.test' }, { name: 'A', address: 'a@x.test' }, { name: '', address: 'me@x.test' }], ['ME@x.test'])).toEqual([{ name: '', address: 'A@x.test' }]);
  });
});

describe('shortName', () => {
  it('names a recipient by first name, or by the address when there is no name', () => {
    expect(shortName({ name: 'James Miller', address: 'james@x.com' })).toBe('James');
    expect(shortName({ name: 'Miller, James', address: 'james@x.com' })).toBe('James');
    expect(shortName({ name: '"Bree"', address: 'bree@x.com' })).toBe('Bree');
    expect(shortName({ name: '', address: 'jabrams@turnriver.com' })).toBe('jabrams@turnriver.com');
    expect(shortName({ name: 'jabrams@turnriver.com', address: 'jabrams@turnriver.com' })).toBe('jabrams@turnriver.com');
  });
});
