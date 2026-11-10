/**
 * Egress allowlist and DNS re-validation (spec §4.4, §9; threat model T2; ADR 0012).
 *
 * Every connection resolves the console host afresh, requires **every** resolved address
 * to be inside the allowlist, and then connects to the validated address itself. A DNS
 * answer that changes between validation and connection (rebinding) therefore cannot
 * redirect the request. Some destinations are refused even if an operator allowlists them.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export const EGRESS_ALLOW_ENV = 'UNIFI_MCP_EGRESS_ALLOW_CIDRS';

/** Private LAN ranges, carrier-grade NAT (common for VPNs) and IPv6 unique-local. */
export const DEFAULT_EGRESS_ALLOW: readonly string[] = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  'fc00::/7',
];

/** Never reachable: unspecified, multicast, broadcast, reserved and cloud metadata. */
const ALWAYS_DENY: readonly string[] = [
  '0.0.0.0/8',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '169.254.169.254/32',
  '::/128',
  'ff00::/8',
  'fd00:ec2::254/128',
];

export type EgressErrorCode = 'egress_denied' | 'dns_failed';

export class EgressError extends Error {
  override readonly name = 'EgressError';
  readonly code: EgressErrorCode;

  constructor(code: EgressErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Lookup = (host: string) => Promise<readonly ResolvedAddress[]>;

const defaultLookup: Lookup = async (host) =>
  (await dnsLookup(host, { all: true, order: 'verbatim' })).map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4,
  }));

interface ParsedCidr {
  network: string;
  prefix: number;
  family: 'ipv4' | 'ipv6';
}

export function parseCidr(cidr: string): ParsedCidr | undefined {
  const [network = '', prefixText = '', extra] = cidr.trim().split('/');
  const version = isIP(network);
  if (version === 0 || extra !== undefined || !/^\d{1,3}$/.test(prefixText)) return undefined;
  const prefix = Number(prefixText);
  if (prefix > (version === 4 ? 32 : 128)) return undefined;
  return { network, prefix, family: version === 4 ? 'ipv4' : 'ipv6' };
}

/** `::ffff:10.0.0.1` is checked as `10.0.0.1`. */
function normalise(address: string): { address: string; family: 'ipv4' | 'ipv6' } | undefined {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const candidate = mapped?.[1] ?? address;
  const version = isIP(candidate);
  if (version === 0) return undefined;
  return { address: candidate, family: version === 4 ? 'ipv4' : 'ipv6' };
}

function blockListOf(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed === undefined) throw new Error(`Invalid CIDR "${cidr}".`);
    list.addSubnet(parsed.network, parsed.prefix, parsed.family);
  }
  return list;
}

export interface EgressPolicy {
  allow: readonly string[];
}

/**
 * Parses `UNIFI_MCP_EGRESS_ALLOW_CIDRS` (comma-separated CIDRs). When set, it replaces the
 * defaults. A malformed entry is a startup error.
 */
export function parseEgressPolicy(env: NodeJS.ProcessEnv): EgressPolicy {
  const raw = env[EGRESS_ALLOW_ENV]?.trim() ?? '';
  if (raw === '') return { allow: DEFAULT_EGRESS_ALLOW };
  const allow = raw.split(',').map((entry) => entry.trim());
  const invalid = allow.filter((entry) => parseCidr(entry) === undefined);
  if (invalid.length > 0 || allow.length === 0) {
    throw new Error(
      `${EGRESS_ALLOW_ENV} must be comma-separated CIDRs such as 192.168.1.0/24 ` +
        `(${String(invalid.length)} invalid entr${invalid.length === 1 ? 'y' : 'ies'}).`,
    );
  }
  return { allow };
}

export class EgressGuard {
  readonly #allow: BlockList;
  readonly #deny: BlockList;
  readonly #lookup: Lookup;

  constructor(policy: EgressPolicy, lookup: Lookup = defaultLookup) {
    this.#allow = blockListOf(policy.allow);
    this.#deny = blockListOf(ALWAYS_DENY);
    this.#lookup = lookup;
  }

  isAllowed(address: string): boolean {
    const normalised = normalise(address);
    if (normalised === undefined) return false;
    return (
      !this.#deny.check(normalised.address, normalised.family) &&
      this.#allow.check(normalised.address, normalised.family)
    );
  }

  /** Resolves `host` and returns an address to connect to, or throws EgressError. */
  async resolve(host: string): Promise<ResolvedAddress> {
    let addresses: readonly ResolvedAddress[];
    if (isIP(host) !== 0) {
      addresses = [{ address: host, family: isIP(host) === 6 ? 6 : 4 }];
    } else {
      try {
        addresses = await this.#lookup(host);
      } catch (error) {
        throw new EgressError('dns_failed', 'The console host name could not be resolved.', {
          cause: error,
        });
      }
    }
    const first = addresses[0];
    if (first === undefined) {
      throw new EgressError('dns_failed', 'The console host name has no addresses.');
    }
    // All answers must be acceptable: a mixed answer is a rebinding signal, not a choice.
    if (!addresses.every(({ address }) => this.isAllowed(address))) {
      throw new EgressError(
        'egress_denied',
        'The console address is outside the egress allowlist (UNIFI_MCP_EGRESS_ALLOW_CIDRS).',
      );
    }
    return first;
  }
}
