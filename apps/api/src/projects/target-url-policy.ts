import { BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import ipaddr from 'ipaddr.js';

export interface ValidatedTarget {
  baseUrl: string;
  approvedDomains: string[];
}

type ResolvedAddress = { address: string; family: number };
type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export async function normalizeAndValidateTarget(
  baseUrl: string,
  approvedDomains: string[],
  resolveHost: HostResolver = async (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw policyViolation('baseUrl must be a valid absolute URL');
  }

  if (url.protocol !== 'https:') {
    throw policyViolation('baseUrl must use HTTPS');
  }
  if (url.username || url.password) {
    throw policyViolation('baseUrl cannot include credentials');
  }
  if (url.port && url.port !== '443') {
    throw policyViolation('baseUrl must use the default HTTPS port');
  }
  if (url.search || url.hash) {
    throw policyViolation('baseUrl cannot include a query string or fragment');
  }

  const hostname = normalizeDomain(url.hostname);
  if (isIP(hostname)) {
    throw policyViolation('IP address targets are not allowed');
  }

  const normalizedDomains = [...new Set(approvedDomains.map(normalizeDomain))];
  if (!normalizedDomains.some((domain) => isInDomain(hostname, domain))) {
    throw policyViolation(
      'baseUrl hostname must match an approved domain or its subdomain',
    );
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    throw new BadRequestException({
      code: 'target_dns_resolution_failed',
      message: 'Target hostname could not be resolved',
    });
  }
  if (addresses.length === 0) {
    throw new BadRequestException({
      code: 'target_dns_resolution_failed',
      message: 'Target hostname did not resolve to an address',
    });
  }

  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw policyViolation(
        'Target hostname resolves to a private, reserved, or otherwise non-public address',
      );
    }
  }

  url.hostname = hostname;
  return {
    baseUrl: url.toString(),
    approvedDomains: normalizedDomains,
  };
}

function normalizeDomain(value: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw policyViolation('approvedDomains must contain valid domain names');
  }

  const domain = value.toLowerCase().replace(/\.$/, '');
  const asciiDomain = domainToASCII(domain);
  if (
    !asciiDomain ||
    isIP(domain) ||
    asciiDomain.length > 253 ||
    !asciiDomain.includes('.') ||
    asciiDomain.split('.').some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    ) ||
    asciiDomain === 'localhost' ||
    asciiDomain.endsWith('.localhost') ||
    asciiDomain.endsWith('.local') ||
    asciiDomain.endsWith('.internal')
  ) {
    throw policyViolation('approvedDomains must contain public DNS domain names');
  }
  return asciiDomain;
}

function isInDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}

function policyViolation(message: string): BadRequestException {
  return new BadRequestException({
    code: 'target_policy_violation',
    message,
  });
}
