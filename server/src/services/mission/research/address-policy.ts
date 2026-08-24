/**
 * DNS resolution and IP address classification for SSRF prevention.
 *
 * (architecture.md: Network/SSRF policy, VAL-RES-050, VAL-RES-051,
 *  VAL-CROSS-035)
 *
 * This module resolves A and AAAA DNS records for a target hostname and
 * rejects the target if ANY answer is a blocked address. This implements
 * the "all answers must be safe" rule — a single blocked answer makes the
 * entire set unsafe.
 *
 * Blocked address families:
 * - Loopback (127.0.0.0/8, ::1)
 * - Private / RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
 * - Link-local (169.254.0.0/16, fe80::/10) — includes cloud metadata
 * - Cloud metadata (169.254.169.254, fd00:ec2::254)
 * - Carrier-grade NAT / RFC 6598 (100.64.0.0/10)
 * - Multicast (224.0.0.0/4, ff00::/8)
 * - Unspecified (0.0.0.0, ::)
 * - Reserved / documentation (240.0.0.0/4, 255.255.255.255,
 *   192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24, 2001:db8::/32)
 * - IPv4-mapped private IPv6 (::ffff:x.x.x.x where IPv4 is blocked)
 *
 * DNS rebinding is prevented by pinning the validated resolved address
 * when Eidolon connects directly (handled by the caller using the
 * returned addresses).
 */

import { promises as dns } from 'node:dns';
import * as net from 'node:net';

// ---------------------------------------------------------------------------
// Injectable DNS resolver
// ---------------------------------------------------------------------------

/**
 * Injectable DNS resolver interface for deterministic tests.
 * Production uses Node's `dns.promises`. Tests inject a mock that
 * returns controlled answers.
 */
export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** Production DNS resolver using Node's `dns.promises`. */
export const defaultDnsResolver: DnsResolver = {
  resolve4: (hostname: string) => dns.resolve4(hostname),
  resolve6: (hostname: string) => dns.resolve6(hostname),
};

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

export type BlockedAddressCategory =
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'metadata'
  | 'cgnat'
  | 'multicast'
  | 'unspecified'
  | 'reserved'
  | 'documentation'
  | 'invalid';

/**
 * Classify an IP address string. Returns the blocked category, or null
 * if the address is public/safe.
 */
export function classifyAddress(address: string): BlockedAddressCategory | null {
  // Parse the address. Node's net.isIP returns 0 for invalid.
  const ipVersion = net.isIP(address);
  if (ipVersion === 0) {
    return 'invalid';
  }

  if (ipVersion === 4) {
    return classifyIPv4(address);
  }

  return classifyIPv6(address);
}

/**
 * Returns true if the address is in a blocked range.
 */
export function isBlockedAddress(address: string): boolean {
  return classifyAddress(address) !== null;
}

// ---------------------------------------------------------------------------
// IPv4 classification
// ---------------------------------------------------------------------------

/** Cloud metadata endpoint (AWS/GCP/Azure) — checked under link-local. */

/** Blocked IPv4 range definitions (module-level to avoid function complexity). */
const IPV4_BLOCKED_RANGES: ReadonlyArray<{
  match: (a: number, b: number, c: number, d: number) => boolean;
  category: BlockedAddressCategory;
}> = [
  { match: (a, b, c, d) => a === 0 && b === 0 && c === 0 && d === 0, category: 'unspecified' },
  { match: (a) => a === 127, category: 'loopback' },
  { match: (a) => a === 10, category: 'private' },
  { match: (a, b) => a === 172 && b >= 16 && b <= 31, category: 'private' },
  { match: (a, b) => a === 192 && b === 168, category: 'private' },
  { match: (a, b) => a === 169 && b === 254, category: 'link_local' },
  { match: (a, b) => a === 100 && b >= 64 && b <= 127, category: 'cgnat' },
  { match: (a) => a >= 224 && a <= 239, category: 'multicast' },
  { match: (a) => a >= 240, category: 'reserved' },
  { match: (a, b, c) => a === 192 && b === 0 && c === 2, category: 'documentation' },
  { match: (a, b, c) => a === 198 && b === 51 && c === 100, category: 'documentation' },
  { match: (a, b, c) => a === 203 && b === 0 && c === 113, category: 'documentation' },
];

function classifyIPv4(addr: string): BlockedAddressCategory | null {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => p < 0 || p > 255 || !Number.isInteger(p))) {
    return 'invalid';
  }

  const [a, b, c, d] = parts;

  for (const range of IPV4_BLOCKED_RANGES) {
    if (range.match(a, b, c, d)) {
      return range.category;
    }
  }

  return null; // public
}

// ---------------------------------------------------------------------------
// IPv6 classification
// ---------------------------------------------------------------------------

/** AWS IPv6 metadata endpoint. */
const AWS_METADATA_IPV6 = 'fd00:ec2::254';

function classifyIPv6(addr: string): BlockedAddressCategory | null {
  // Normalize the address to expanded form for comparison.
  let normalized: string;
  try {
    // Use Node's internal address normalization via net
    normalized = normalizeIPv6(addr);
  } catch {
    return 'invalid';
  }

  const parts = normalized.split(':');

  // Unspecified ::
  if (normalized === '0000:0000:0000:0000:0000:0000:0000:0000') {
    return 'unspecified';
  }

  // Loopback ::1
  if (normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return 'loopback';
  }

  // IPv4-mapped IPv6: ::ffff:x.x.x.x — check the embedded IPv4 address
  // The last two 16-bit groups encode the IPv4 address.
  if (
    parts[5] === 'ffff' &&
    parts[0] === '0000' &&
    parts[1] === '0000' &&
    parts[2] === '0000' &&
    parts[3] === '0000' &&
    parts[4] === '0000'
  ) {
    // Extract IPv4 from last 4 bytes (parts[6] and parts[7])
    const ipv4High = parseInt(parts[6], 16);
    const ipv4Low = parseInt(parts[7], 16);
    const ipv4 = `${(ipv4High >> 8) & 0xff}.${ipv4High & 0xff}.${(ipv4Low >> 8) & 0xff}.${ipv4Low & 0xff}`;
    const v4Class = classifyIPv4(ipv4);
    if (v4Class !== null) {
      // Return the embedded IPv4's category (e.g., loopback, private, etc.)
      return v4Class;
    }
    return null;
  }

  // Link-local fe80::/10 (fe80–febf)
  const firstGroup = parseInt(parts[0], 16);
  if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) {
    return 'link_local';
  }

  // Unique local addresses fc00::/7 (includes fd00::/8)
  const prefix = parts[0].substring(0, 2);
  if (prefix === 'fc' || prefix === 'fd') {
    // AWS IPv6 metadata fd00:ec2::254 is in this range, but ULA is also
    // blocked for SSRF purposes.
    if (normalized === normalizeIPv6(AWS_METADATA_IPV6)) {
      return 'metadata';
    }
    return 'private';
  }

  // Multicast ff00::/8
  if (parts[0].startsWith('ff')) {
    return 'multicast';
  }

  // Documentation 2001:db8::/32
  if (parts[0] === '2001' && parts[1] === '0db8') {
    return 'documentation';
  }

  return null; // public
}

/**
 * Normalize an IPv6 address to 8 groups of 4 hex digits (lowercase).
 * Throws on invalid address.
 */
function normalizeIPv6(addr: string): string {
  // Use Node's OS module to format, or do it manually.
  // Actually, we can use a simple approach: the `net` module doesn't expose
  // a normalizer directly. Let's use a manual approach.

  // Handle :: expansion
  let expanded: string;
  if (addr.includes('::')) {
    const [head, tail] = addr.split('::');
    const headParts = head ? head.split(':') : [];
    const tailParts = tail ? tail.split(':') : [];
    // Handle IPv4-mapped tail (e.g., ::ffff:127.0.0.1)
    let processedTail = tailParts;
    if (tailParts.length > 0 && net.isIPv4(tailParts[tailParts.length - 1])) {
      const ipv4 = tailParts.pop()!;
      const v4Parts = ipv4.split('.').map(Number);
      const high = (v4Parts[0] << 8) | v4Parts[1];
      const low = (v4Parts[2] << 8) | v4Parts[3];
      processedTail = [
        ...tailParts,
        high.toString(16).padStart(4, '0'),
        low.toString(16).padStart(4, '0'),
      ];
    }
    const missing = 8 - headParts.length - processedTail.length;
    const fill = Array(missing).fill('0');
    expanded = [...headParts, ...fill, ...processedTail].join(':');
  } else {
    const parts = addr.split(':');
    // Handle IPv4 at end
    if (parts.length > 0 && net.isIPv4(parts[parts.length - 1])) {
      const ipv4 = parts.pop()!;
      const v4Parts = ipv4.split('.').map(Number);
      const high = (v4Parts[0] << 8) | v4Parts[1];
      const low = (v4Parts[2] << 8) | v4Parts[3];
      parts.push(high.toString(16).padStart(4, '0'));
      parts.push(low.toString(16).padStart(4, '0'));
    }
    expanded = parts.join(':');
  }

  const parts = expanded.split(':');
  if (parts.length !== 8) {
    throw new Error('Invalid IPv6 address');
  }

  return parts.map((p) => p.padStart(4, '0').toLowerCase()).join(':');
}

// ---------------------------------------------------------------------------
// DNS resolution and validation
// ---------------------------------------------------------------------------

export type DnsValidationErrorCode =
  'DNS_RESOLUTION_FAILED' | 'DNS_NO_ANSWERS' | 'DNS_BLOCKED_ADDRESS';

export interface DnsValidationResult {
  valid: boolean;
  errorCode?: DnsValidationErrorCode;
  message?: string;
  /** All validated public addresses (A + AAAA). */
  addresses: string[];
  /** The resolved hostname (lowercase). */
  hostname?: string;
}

/**
 * Resolve A and AAAA records for a hostname and validate every answer.
 *
 * A target is rejected if ANY answer is a blocked address (VAL-RES-051).
 * A target with no answers at all is rejected (DNS_NO_ANSWERS).
 * If A resolution fails but AAAA succeeds (or vice versa), the available
 * answers are still validated.
 *
 * DNS rebinding is prevented by the caller pinning the returned addresses
 * for direct connections.
 */
export async function resolveAndValidate(
  hostname: string,
  resolver: DnsResolver = defaultDnsResolver,
): Promise<DnsValidationResult> {
  const lowerHost = hostname.toLowerCase();

  let aRecords: string[] = [];
  let aaaaRecords: string[] = [];
  let aError = false;
  let aaaaError = false;

  try {
    aRecords = await resolver.resolve4(lowerHost);
  } catch {
    aError = true;
  }

  try {
    aaaaRecords = await resolver.resolve6(lowerHost);
  } catch {
    aaaaError = true;
  }

  // If both failed, resolution failed entirely.
  if (aError && aaaaError) {
    return {
      valid: false,
      errorCode: 'DNS_RESOLUTION_FAILED',
      message: 'DNS resolution failed for hostname',
      addresses: [],
      hostname: lowerHost,
    };
  }

  const allAnswers = [...aRecords, ...aaaaRecords];

  // No answers at all.
  if (allAnswers.length === 0) {
    return {
      valid: false,
      errorCode: 'DNS_NO_ANSWERS',
      message: 'No DNS answers returned for hostname',
      addresses: [],
      hostname: lowerHost,
    };
  }

  // Check every answer — any blocked answer makes the set unsafe.
  for (const addr of allAnswers) {
    if (isBlockedAddress(addr)) {
      return {
        valid: false,
        errorCode: 'DNS_BLOCKED_ADDRESS',
        message: 'DNS resolution returned a blocked address',
        addresses: [],
        hostname: lowerHost,
      };
    }
  }

  return {
    valid: true,
    addresses: allAnswers,
    hostname: lowerHost,
  };
}
