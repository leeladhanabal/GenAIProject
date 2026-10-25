import { BadRequestException } from '@nestjs/common';
import { normalizeAndValidateTarget } from './target-url-policy';

describe('normalizeAndValidateTarget', () => {
  const publicResolver = async () => [
    { address: '93.184.216.34', family: 4 },
  ];

  it('normalizes an approved HTTPS target', async () => {
    await expect(
      normalizeAndValidateTarget(
        'https://STAGING.example.com',
        ['example.com', 'example.com'],
        publicResolver,
      ),
    ).resolves.toEqual({
      baseUrl: 'https://staging.example.com/',
      approvedDomains: ['example.com'],
    });
  });

  it('rejects a hostname outside the approved domain boundary', async () => {
    await expect(
      normalizeAndValidateTarget(
        'https://example.com.attacker.test',
        ['example.com'],
        publicResolver,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([
    'http://api.example.com',
    'https://user:password@api.example.com',
    'https://api.example.com:8443',
    'https://api.example.com/path?token=value',
  ])('rejects unsafe URL shape %s', async (baseUrl) => {
    await expect(
      normalizeAndValidateTarget(baseUrl, ['example.com'], publicResolver),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([
    ['private IPv4', '10.1.2.3'],
    ['cloud metadata IPv4', '169.254.169.254'],
    ['loopback IPv4', '127.0.0.1'],
    ['loopback IPv6', '::1'],
    ['unique-local IPv6', 'fc00::1'],
    ['documentation IPv6', '2001:db8::1'],
  ])('rejects a hostname resolving to %s', async (_label, address) => {
    await expect(
      normalizeAndValidateTarget('https://api.example.com', ['example.com'], async () => [
        { address, family: address.includes(':') ? 6 : 4 },
      ]),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects DNS resolution failure explicitly', async () => {
    await expect(
      normalizeAndValidateTarget('https://api.example.com', ['example.com'], async () => {
        throw new Error('DNS lookup failed');
      }),
    ).rejects.toThrow('Target hostname could not be resolved');
  });
});
