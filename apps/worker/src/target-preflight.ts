import { lookup } from 'node:dns/promises';
import { normalizeAndValidateTarget } from '../../api/src/projects/target-url-policy';

type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export async function pinExecutionTarget(baseUrl: string, approvedDomains: string[],
  resolve: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true }),
): Promise<string> {
  let resolved: Array<{ address: string; family: number }> = [];
  await normalizeAndValidateTarget(baseUrl, approvedDomains, async (hostname) => {
    resolved = await resolve(hostname);
    return resolved;
  });
  // This local Docker profile disables IPv6 and has an IPv4 egress firewall.
  // Fail closed for IPv6-only targets rather than weakening either policy.
  const address = resolved.find((item) => item.family === 4);
  if (!address) throw new Error('target_ipv4_required');
  return address.address;
}
