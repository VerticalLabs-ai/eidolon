import { describe, expect, it } from 'vitest';
import {
  isBlockedAddress,
  classifyAddress,
  resolveAndValidate,
  type DnsResolver,
} from '../services/mission/research/address-policy.js';

/**
 * VAL-RES-050: Local and private hosts denied (IP-level)
 * VAL-RES-051: Mixed DNS answers denied
 */

// ---------------------------------------------------------------------------
// IP address classification
// ---------------------------------------------------------------------------

describe('VAL-RES-050: Blocked IP address classification', () => {
  describe('loopback', () => {
    it('rejects 127.0.0.1', () => {
      expect(isBlockedAddress('127.0.0.1')).toBe(true);
      expect(classifyAddress('127.0.0.1')).toBe('loopback');
    });

    it('rejects 127.255.255.255', () => {
      expect(isBlockedAddress('127.255.255.255')).toBe(true);
    });

    it('rejects ::1 (IPv6 loopback)', () => {
      expect(isBlockedAddress('::1')).toBe(true);
      expect(classifyAddress('::1')).toBe('loopback');
    });
  });

  describe('private (RFC 1918)', () => {
    it('rejects 10.0.0.1', () => {
      expect(isBlockedAddress('10.0.0.1')).toBe(true);
      expect(classifyAddress('10.0.0.1')).toBe('private');
    });

    it('rejects 10.255.255.255', () => {
      expect(isBlockedAddress('10.255.255.255')).toBe(true);
    });

    it('rejects 172.16.0.1', () => {
      expect(isBlockedAddress('172.16.0.1')).toBe(true);
      expect(classifyAddress('172.16.0.1')).toBe('private');
    });

    it('rejects 172.31.255.255', () => {
      expect(isBlockedAddress('172.31.255.255')).toBe(true);
    });

    it('does NOT reject 172.15.0.1 (outside private range)', () => {
      expect(isBlockedAddress('172.15.0.1')).toBe(false);
    });

    it('does NOT reject 172.32.0.1 (outside private range)', () => {
      expect(isBlockedAddress('172.32.0.1')).toBe(false);
    });

    it('rejects 192.168.0.1', () => {
      expect(isBlockedAddress('192.168.0.1')).toBe(true);
      expect(classifyAddress('192.168.0.1')).toBe('private');
    });

    it('rejects 192.168.255.255', () => {
      expect(isBlockedAddress('192.168.255.255')).toBe(true);
    });
  });

  describe('link-local', () => {
    it('rejects 169.254.0.1', () => {
      expect(isBlockedAddress('169.254.0.1')).toBe(true);
      expect(classifyAddress('169.254.0.1')).toBe('link_local');
    });

    it('rejects 169.254.169.254 (cloud metadata)', () => {
      expect(isBlockedAddress('169.254.169.254')).toBe(true);
      expect(classifyAddress('169.254.169.254')).toBe('link_local');
    });

    it('rejects fe80::1 (IPv6 link-local)', () => {
      expect(isBlockedAddress('fe80::1')).toBe(true);
      expect(classifyAddress('fe80::1')).toBe('link_local');
    });
  });

  describe('cloud metadata', () => {
    it('rejects 169.254.169.254 as metadata', () => {
      // Already covered under link-local, but verify metadata-specific check
      expect(isBlockedAddress('169.254.169.254')).toBe(true);
    });

    it('rejects fd00:ec2::254 (AWS IPv6 metadata)', () => {
      expect(isBlockedAddress('fd00:ec2::254')).toBe(true);
    });

    it('rejects GCP metadata 169.254.169.254', () => {
      expect(isBlockedAddress('169.254.169.254')).toBe(true);
    });
  });

  describe('carrier-grade NAT (RFC 6598)', () => {
    it('rejects 100.64.0.1', () => {
      expect(isBlockedAddress('100.64.0.1')).toBe(true);
      expect(classifyAddress('100.64.0.1')).toBe('cgnat');
    });

    it('rejects 100.127.255.255', () => {
      expect(isBlockedAddress('100.127.255.255')).toBe(true);
    });

    it('does NOT reject 100.63.255.255 (outside CGNAT)', () => {
      expect(isBlockedAddress('100.63.255.255')).toBe(false);
    });

    it('does NOT reject 100.128.0.1 (outside CGNAT)', () => {
      expect(isBlockedAddress('100.128.0.1')).toBe(false);
    });
  });

  describe('multicast', () => {
    it('rejects 224.0.0.1', () => {
      expect(isBlockedAddress('224.0.0.1')).toBe(true);
      expect(classifyAddress('224.0.0.1')).toBe('multicast');
    });

    it('rejects 239.255.255.255', () => {
      expect(isBlockedAddress('239.255.255.255')).toBe(true);
    });

    it('rejects ff00::1 (IPv6 multicast)', () => {
      expect(isBlockedAddress('ff00::1')).toBe(true);
      expect(classifyAddress('ff00::1')).toBe('multicast');
    });
  });

  describe('unspecified', () => {
    it('rejects 0.0.0.0', () => {
      expect(isBlockedAddress('0.0.0.0')).toBe(true);
      expect(classifyAddress('0.0.0.0')).toBe('unspecified');
    });

    it('rejects :: (IPv6 unspecified)', () => {
      expect(isBlockedAddress('::')).toBe(true);
      expect(classifyAddress('::')).toBe('unspecified');
    });
  });

  describe('reserved / documentation', () => {
    it('rejects 240.0.0.1 (reserved)', () => {
      expect(isBlockedAddress('240.0.0.1')).toBe(true);
      expect(classifyAddress('240.0.0.1')).toBe('reserved');
    });

    it('rejects 255.255.255.255 (broadcast)', () => {
      expect(isBlockedAddress('255.255.255.255')).toBe(true);
    });

    it('rejects 192.0.2.1 (TEST-NET-1 documentation)', () => {
      expect(isBlockedAddress('192.0.2.1')).toBe(true);
      expect(classifyAddress('192.0.2.1')).toBe('documentation');
    });

    it('rejects 198.51.100.1 (TEST-NET-2 documentation)', () => {
      expect(isBlockedAddress('198.51.100.1')).toBe(true);
    });

    it('rejects 203.0.113.1 (TEST-NET-3 documentation)', () => {
      expect(isBlockedAddress('203.0.113.1')).toBe(true);
    });

    it('rejects 2001:db8::1 (IPv6 documentation)', () => {
      expect(isBlockedAddress('2001:db8::1')).toBe(true);
      expect(classifyAddress('2001:db8::1')).toBe('documentation');
    });
  });

  describe('IPv4-mapped private IPv6', () => {
    it('rejects ::ffff:127.0.0.1 (IPv4-mapped loopback)', () => {
      expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    });

    it('rejects ::ffff:10.0.0.1 (IPv4-mapped private)', () => {
      expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    });

    it('rejects ::ffff:169.254.169.254 (IPv4-mapped metadata)', () => {
      expect(isBlockedAddress('::ffff:169.254.169.254')).toBe(true);
    });
  });

  describe('IPv4-compatible IPv6 (::x.x.x.x without ffff prefix)', () => {
    it('rejects ::127.0.0.1 (IPv4-compatible loopback)', () => {
      expect(isBlockedAddress('::127.0.0.1')).toBe(true);
      expect(classifyAddress('::127.0.0.1')).toBe('loopback');
    });

    it('rejects ::10.0.0.1 (IPv4-compatible private)', () => {
      expect(isBlockedAddress('::10.0.0.1')).toBe(true);
      expect(classifyAddress('::10.0.0.1')).toBe('private');
    });

    it('rejects ::169.254.169.254 (IPv4-compatible metadata)', () => {
      expect(isBlockedAddress('::169.254.169.254')).toBe(true);
      expect(classifyAddress('::169.254.169.254')).toBe('link_local');
    });

    it('rejects ::192.168.1.1 (IPv4-compatible private)', () => {
      expect(isBlockedAddress('::192.168.1.1')).toBe(true);
      expect(classifyAddress('::192.168.1.1')).toBe('private');
    });

    it('rejects ::100.64.0.1 (IPv4-compatible CGNAT)', () => {
      expect(isBlockedAddress('::100.64.0.1')).toBe(true);
      expect(classifyAddress('::100.64.0.1')).toBe('cgnat');
    });

    it('rejects ::0.0.0.0 (IPv4-compatible unspecified)', () => {
      // ::0.0.0.0 is the same as :: which is already caught as unspecified
      expect(isBlockedAddress('::0.0.0.0')).toBe(true);
    });

    it('does NOT reject ::8.8.8.8 (IPv4-compatible public)', () => {
      expect(isBlockedAddress('::8.8.8.8')).toBe(false);
    });
  });

  describe('valid public addresses are NOT blocked', () => {
    it('accepts 8.8.8.8 (Google DNS)', () => {
      expect(isBlockedAddress('8.8.8.8')).toBe(false);
    });

    it('accepts 1.1.1.1 (Cloudflare DNS)', () => {
      expect(isBlockedAddress('1.1.1.1')).toBe(false);
    });

    it('accepts 93.184.216.34 (example.com)', () => {
      expect(isBlockedAddress('93.184.216.34')).toBe(false);
    });

    it('accepts 2606:2800:220:1:248:1893:25c8:1946 (IPv6 public)', () => {
      expect(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    });
  });

  describe('invalid addresses', () => {
    it('rejects malformed IP string', () => {
      expect(isBlockedAddress('not-an-ip')).toBe(true);
    });

    it('rejects empty string', () => {
      expect(isBlockedAddress('')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-051: Mixed DNS answers denied
// ---------------------------------------------------------------------------

describe('VAL-RES-051: Mixed DNS answers denied', () => {
  it('accepts when all A answers are public', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => ['93.184.216.34'],
      resolve6: async () => [],
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(true);
    expect(result.addresses).toEqual(['93.184.216.34']);
  });

  it('accepts when all AAAA answers are public', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => [],
      resolve6: async () => ['2606:2800:220:1:248:1893:25c8:1946'],
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(true);
  });

  it('rejects when one A answer is private (mixed)', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => ['93.184.216.34', '10.0.0.1'],
      resolve6: async () => [],
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('DNS_BLOCKED_ADDRESS');
  });

  it('rejects when one AAAA answer is loopback (mixed)', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => ['93.184.216.34'],
      resolve6: async () => ['2606:2800:220:1:248:1893:25c8:1946', '::1'],
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('DNS_BLOCKED_ADDRESS');
  });

  it('rejects when all answers are blocked', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => ['127.0.0.1'],
      resolve6: async () => ['::1'],
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('DNS_BLOCKED_ADDRESS');
  });

  it('rejects metadata IP in DNS answers', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => ['169.254.169.254'],
      resolve6: async () => [],
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('DNS_BLOCKED_ADDRESS');
  });

  it('rejects when no DNS answers at all', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => [],
      resolve6: async () => [],
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('DNS_NO_ANSWERS');
  });

  it('handles DNS resolution failure gracefully', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => {
        throw new Error('ENOTFOUND');
      },
      resolve6: async () => {
        throw new Error('ENOTFOUND');
      },
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('DNS_RESOLUTION_FAILED');
  });

  it('accepts when A fails but AAAA has public answers', async () => {
    const resolver: DnsResolver = {
      resolve4: async () => {
        throw new Error('ENOTFOUND');
      },
      resolve6: async () => ['2606:2800:220:1:248:1893:25c8:1946'],
    };
    const result = await resolveAndValidate('example.com', resolver);
    expect(result.valid).toBe(true);
  });
});
