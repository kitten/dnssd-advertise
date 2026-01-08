import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';

import {
  networkInterfaces,
  networkInterfaceNames,
  interfaceBindings,
  hasScopeid,
  hostname,
  fingerprint,
  type NetworkBinding,
} from '../nics';
import { IPType } from '../constants';

describe('nics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('networkInterfaces', () => {
    it('returns the same cached result on repeated calls within same tick', () => {
      const result1 = networkInterfaces();
      const result2 = networkInterfaces();
      expect(result1).toBe(result2);
    });

    it('calls os.networkInterfaces', () => {
      const spy = vi.spyOn(os, 'networkInterfaces');
      networkInterfaces();
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('networkInterfaceNames', () => {
    it('returns interface names with external bindings', () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: '192.168.1.100/24',
          },
        ],
        lo0: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
      });

      const names = networkInterfaceNames();
      expect(names).toContain('en0');
      expect(names).not.toContain('lo0');
    });

    it('returns all interfaces if no external bindings exist', () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        lo0: [
          {
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: true,
            cidr: '127.0.0.1/8',
          },
        ],
      });

      const names = networkInterfaceNames();
      expect(names).toContain('lo0');
    });

    it('filters out interfaces with only undefined bindings', () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        en0: undefined as any,
        en1: [
          {
            address: '192.168.1.101',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:11:22:33:44:66',
            internal: false,
            cidr: '192.168.1.101/24',
          },
        ],
      });

      const names = networkInterfaceNames();
      expect(names).toContain('en1');
      expect(names).not.toContain('en0');
    });
  });

  describe('interfaceBindings', () => {
    it('returns IPv4 bindings for an interface', () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: '192.168.1.100/24',
          },
          {
            address: 'fe80::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 1,
          },
        ],
      });

      const bindings = interfaceBindings('en0', IPType.v4);
      expect(bindings).toHaveLength(1);
      expect(bindings![0].address).toBe('192.168.1.100');
      expect(bindings![0].family).toBe(IPType.v4);
      expect(bindings![0].iname).toBe('en0');
    });

    it('returns IPv6 bindings for an interface', () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: '192.168.1.100/24',
          },
          {
            address: 'fe80::1',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: 'fe80::1/64',
            scopeid: 1,
          },
        ],
      });

      const bindings = interfaceBindings('en0', IPType.v6);
      expect(bindings).toHaveLength(1);
      expect(bindings![0].address).toBe('fe80::1');
      expect(bindings![0].family).toBe(IPType.v6);
      expect(bindings![0].scopeid).toBe(1);
    });

    it('returns undefined for non-existent interface', () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: '192.168.1.100/24',
          },
        ],
      });

      const bindings = interfaceBindings('en1', IPType.v4);
      expect(bindings).toBeUndefined();
    });

    it('returns undefined when no bindings of requested family exist', () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        en0: [
          {
            address: '192.168.1.100',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: '192.168.1.100/24',
          },
        ],
      });

      const bindings = interfaceBindings('en0', IPType.v6);
      expect(bindings).toBeUndefined();
    });
  });

  describe('hasScopeid', () => {
    it('returns true for bindings with positive scopeid', () => {
      const binding: NetworkBinding = {
        iname: 'en0',
        family: IPType.v6,
        address: 'fe80::1',
        netmask: 'ffff:ffff:ffff:ffff::',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: 'fe80::1/64',
        scopeid: 1,
      };

      expect(hasScopeid(binding)).toBe(true);
    });

    it('returns false for bindings with scopeid of 0', () => {
      const binding: NetworkBinding = {
        iname: 'en0',
        family: IPType.v6,
        address: 'fe80::1',
        netmask: 'ffff:ffff:ffff:ffff::',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: 'fe80::1/64',
        scopeid: 0,
      };

      expect(hasScopeid(binding)).toBe(false);
    });

    it('returns false for bindings without scopeid', () => {
      const binding: NetworkBinding = {
        iname: 'en0',
        family: IPType.v4,
        address: '192.168.1.100',
        netmask: '255.255.255.0',
        mac: '00:11:22:33:44:55',
        internal: false,
        cidr: '192.168.1.100/24',
      };

      expect(hasScopeid(binding)).toBe(false);
    });
  });

  describe('hostname', () => {
    it('returns the system hostname', () => {
      const mockHostname = 'test-machine';
      vi.spyOn(os, 'hostname').mockReturnValue(mockHostname);

      expect(hostname()).toBe(mockHostname);
    });
  });

  describe('fingerprint', () => {
    it('generates a 4-character hex fingerprint', () => {
      const result = fingerprint(8080, 0);
      expect(result).toMatch(/^[A-F0-9]{4}$/);
    });

    it('generates different fingerprints for different ports', () => {
      const fp1 = fingerprint(8080, 0);
      const fp2 = fingerprint(9090, 0);
      expect(fp1).not.toBe(fp2);
    });

    it('generates different fingerprints for different seeds', () => {
      const fp1 = fingerprint(8080, 0);
      const fp2 = fingerprint(8080, 1);
      expect(fp1).not.toBe(fp2);
    });

    it('generates consistent fingerprints for same inputs', () => {
      const fp1 = fingerprint(8080, 5);
      const fp2 = fingerprint(8080, 5);
      expect(fp1).toBe(fp2);
    });

    it('incorporates hostname in fingerprint', () => {
      vi.spyOn(os, 'hostname').mockReturnValue('host-a');
      const fp1 = fingerprint(8080, 0);

      vi.spyOn(os, 'hostname').mockReturnValue('host-b');
      const fp2 = fingerprint(8080, 0);

      expect(fp1).not.toBe(fp2);
    });

    it('seed of 0 does not modify the hash', () => {
      const fp1 = fingerprint(3000, 0);
      const fp2 = fingerprint(3000, 0);
      expect(fp1).toBe(fp2);
    });
  });
});
