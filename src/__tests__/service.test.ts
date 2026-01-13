import { describe, it, expect } from 'vitest';
import {
  decode,
  PacketType,
  RecordType,
  RecordClass,
  PacketFlag,
  type Packet,
} from 'dns-message';

import {
  createServiceInput,
  createServiceRecord,
  probeMessage,
  announceMessage,
  goodbyeMessage,
  responseMessage,
  checkResponseConflicts,
  ConflictFlag,
} from '../service';
import type { NetworkBinding } from '../nics';
import { IPType, DNSSD_NAME } from '../constants';

const createTestBindings = (): NetworkBinding[] => [
  {
    iname: 'en0',
    family: IPType.v4,
    address: '192.168.1.100',
    netmask: '255.255.255.0',
    mac: '00:11:22:33:44:55',
    internal: false,
    cidr: '192.168.1.100/24',
  },
  {
    iname: 'en0',
    family: IPType.v6,
    address: 'fe80::1',
    netmask: 'ffff:ffff:ffff:ffff::',
    mac: '00:11:22:33:44:55',
    internal: false,
    cidr: 'fe80::1/64',
    scopeid: 1,
  },
];

describe('service', () => {
  describe('createServiceInput', () => {
    it('creates input with seed values initialized to 0', () => {
      const input = createServiceInput({
        name: 'My Service',
        type: 'http',
        protocol: 'tcp',
        hostname: 'myhost',
        port: 8080,
        subtypes: ['printer'],
        txt: { key: 'value' },
        ttl: 120,
      });

      expect(input.nameSeed).toBe(0);
      expect(input.hostnameSeed).toBe(0);
      expect(input.name).toBe('My Service');
      expect(input.type).toBe('http');
      expect(input.protocol).toBe('tcp');
      expect(input.hostname).toBe('myhost');
      expect(input.port).toBe(8080);
      expect(input.subtypes).toEqual(['printer']);
      expect(input.txt).toEqual({ key: 'value' });
      expect(input.ttl).toBe(120);
    });
  });

  describe('createServiceRecord', () => {
    it('creates a properly formatted service record', () => {
      const input = createServiceInput({
        name: 'Test Service',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });

      const record = createServiceRecord(input);

      expect(record.domain).toBe('_http._tcp.local');
      expect(record.fqdnOut).toBe('Test Service._http._tcp.local');
      expect(record.fqdnIn).toBe('test service._http._tcp.local');
      expect(record.host).toBe('testhost.local');
      expect(record.port).toBe(8080);
      expect(record.ttl).toBe(250);
    });

    it('sanitizes hostname by removing .local suffix', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'myhost.local',
        port: 80,
        subtypes: [],
        txt: {},
        ttl: 250,
      });

      const record = createServiceRecord(input);
      expect(record.host).toBe('myhost.local');
    });

    it('sanitizes special characters in hostname', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'my host!@#$%',
        port: 80,
        subtypes: [],
        txt: {},
        ttl: 250,
      });

      const record = createServiceRecord(input);
      expect(record.host).toBe('my-host.local');
    });

    it('handles name conflicts by appending fingerprint', () => {
      const input = createServiceInput({
        name: 'Test Service',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });

      input.nameSeed = 1;
      const record = createServiceRecord(input);

      expect(record.fqdnOut).toMatch(
        /^Test Service \([A-F0-9]{4}\)\._http\._tcp\.local$/
      );
    });

    it('handles hostname conflicts by appending suffix', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 80,
        subtypes: [],
        txt: {},
        ttl: 250,
      });

      input.hostnameSeed = 1;
      const record = createServiceRecord(input);

      expect(record.host).toBe('testhost-2.local');
    });

    it('increments existing numeric suffix in hostname', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost-5',
        port: 80,
        subtypes: [],
        txt: {},
        ttl: 250,
      });

      input.hostnameSeed = 1;
      const record = createServiceRecord(input);

      expect(record.host).toBe('testhost-6.local');
    });

    it('converts txt record values correctly', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'host',
        port: 80,
        subtypes: [],
        txt: {
          stringKey: 'stringValue',
          numberKey: 42,
          boolTrue: true,
          boolFalse: false,
          nullKey: null,
          undefinedKey: undefined,
        },
        ttl: 250,
      });

      const record = createServiceRecord(input);

      expect(record.txt).toContain('stringKey=stringValue');
      expect(record.txt).toContain('numberKey=42');
      expect(record.txt).toContain('boolTrue');
      expect(record.txt).not.toContain('boolFalse');
      expect(record.txt).not.toContain('nullKey');
      expect(record.txt).not.toContain('undefinedKey');
    });

    it('creates subtype records', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'host',
        port: 80,
        subtypes: ['printer', 'scanner'],
        txt: {},
        ttl: 250,
      });

      const record = createServiceRecord(input);

      expect(record.subtypes).toHaveProperty('printer._sub._http._tcp.local');
      expect(record.subtypes).toHaveProperty('scanner._sub._http._tcp.local');
    });

    it('sanitizes subtypes', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'host',
        port: 80,
        subtypes: ['  My Printer!  '],
        txt: {},
        ttl: 250,
      });

      const record = createServiceRecord(input);

      expect(record.subtypes).toHaveProperty(
        'my-printer._sub._http._tcp.local'
      );
    });

    it('truncates long names to 63 characters', () => {
      const longName = 'A'.repeat(100);
      const input = createServiceInput({
        name: longName,
        type: 'http',
        protocol: 'tcp',
        hostname: 'host',
        port: 80,
        subtypes: [],
        txt: {},
        ttl: 250,
      });

      const record = createServiceRecord(input);

      expect(record.fqdnOut.split('.')[0].length).toBeLessThanOrEqual(63);
    });
  });

  describe('probeMessage', () => {
    it('creates a query packet with ANY questions', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const message = probeMessage(record, bindings);
      const packet = decode(message);

      expect(packet.type).toBe(PacketType.QUERY);
      expect(packet.questions).toHaveLength(2);
      expect(packet.questions![0].type).toBe(RecordType.ANY);
      expect(packet.questions![0].qu).toBe(true);
      expect(packet.questions![1].type).toBe(RecordType.ANY);
      expect(packet.questions![1].qu).toBe(true);
    });

    it('includes SRV and address records in authorities', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const message = probeMessage(record, bindings);
      const packet = decode(message);

      const authorityTypes = packet.authorities!.map(a => a.type);
      expect(authorityTypes).toContain(RecordType.SRV);
      expect(authorityTypes).toContain(RecordType.A);
      expect(authorityTypes).toContain(RecordType.AAAA);
    });
  });

  describe('announceMessage', () => {
    it('creates a response packet with authoritative flag', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const message = announceMessage(record, bindings);
      const packet = decode(message);

      expect(packet.type).toBe(PacketType.RESPONSE);
      expect(packet.flags! & PacketFlag.AUTHORITATIVE_ANSWER).toBeTruthy();
    });

    it('includes PTR, SRV, TXT, A, and AAAA records', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const message = announceMessage(record, bindings);
      const packet = decode(message);

      const answerTypes = packet.answers!.map(a => a.type);
      expect(answerTypes).toContain(RecordType.PTR);
      expect(answerTypes).toContain(RecordType.SRV);
      expect(answerTypes).toContain(RecordType.TXT);
      expect(answerTypes).toContain(RecordType.A);
      expect(answerTypes).toContain(RecordType.AAAA);
    });

    it('includes DNS-SD meta-query PTR record', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const message = announceMessage(record, bindings);
      const packet = decode(message);

      const dnssdPtr = packet.answers!.find(
        a => a.type === RecordType.PTR && a.name === DNSSD_NAME
      );
      expect(dnssdPtr).toBeDefined();
      expect(dnssdPtr!.data).toBe('_http._tcp.local');
    });

    it('uses configured TTL for records', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 120,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const message = announceMessage(record, bindings);
      const packet = decode(message);

      for (const answer of packet.answers!) {
        if ('ttl' in answer) {
          expect(answer.ttl).toBe(120);
        }
      }
    });
  });

  describe('goodbyeMessage', () => {
    it('creates records with TTL of 0', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const message = goodbyeMessage(record, bindings);
      const packet = decode(message);

      for (const answer of packet.answers!) {
        if ('ttl' in answer) {
          expect(answer.ttl).toBe(0);
        }
      }
    });
  });

  describe('checkResponseConflicts', () => {
    it('only checks response packets', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        answers: [
          {
            type: RecordType.SRV,
            name: record.fqdnIn,
            class: RecordClass.IN,
            ttl: 120,
            flush: false,
            data: {
              priority: 0,
              weight: 0,
              port: 9090,
              target: 'testhost.local',
            },
          },
        ],
      } as Packet;

      expect(checkResponseConflicts(packet, record, bindings)).toBe(
        ConflictFlag.NONE
      );
    });

    it('checks additionals section for conflicts', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.RESPONSE,
        additionals: [
          {
            type: RecordType.A,
            name: 'testhost.local',
            class: RecordClass.IN,
            ttl: 120,
            flush: false,
            data: '10.0.0.1',
          },
        ],
      } as Packet;

      expect(
        checkResponseConflicts(packet, record, bindings) &
          ConflictFlag.HOSTNAME_A
      ).toBeTruthy();
    });
  });

  describe('responseMessage', () => {
    it('returns null for non-query packets', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.RESPONSE,
        questions: [],
      };

      expect(responseMessage(packet, record, bindings, false)).toBeNull();
    });

    it('returns null when no questions match', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: 'unrelated._http._tcp.local',
            type: RecordType.SRV,
            class: RecordClass.IN,
            qu: false,
          },
        ],
      };

      expect(responseMessage(packet, record, bindings, false)).toBeNull();
    });

    it('responds to SRV query for our service', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: record.fqdnIn,
            type: RecordType.SRV,
            class: RecordClass.IN,
            qu: false,
          },
        ],
      };

      const response = responseMessage(packet, record, bindings, false);
      expect(response).not.toBeNull();

      const decoded = decode(response!);
      expect(decoded.answers!.some(a => a.type === RecordType.SRV)).toBe(true);
    });

    it('responds to PTR query for service domain', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: '_http._tcp.local',
            type: RecordType.PTR,
            class: RecordClass.IN,
            qu: false,
          },
        ],
      };

      const response = responseMessage(packet, record, bindings, false);
      expect(response).not.toBeNull();

      const decoded = decode(response!);
      const ptrAnswer = decoded.answers!.find(a => a.type === RecordType.PTR);
      expect(ptrAnswer).toBeDefined();
      expect(ptrAnswer!.data).toBe(record.fqdnOut);
    });

    it('responds to A query for our hostname', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: 'testhost.local',
            type: RecordType.A,
            class: RecordClass.IN,
            qu: false,
          },
        ],
      };

      const response = responseMessage(packet, record, bindings, false);
      expect(response).not.toBeNull();

      const decoded = decode(response!);
      const aAnswer = decoded.answers!.find(a => a.type === RecordType.A);
      expect(aAnswer).toBeDefined();
      expect(aAnswer!.data).toBe('192.168.1.100');
    });

    it('responds to ANY query with all relevant records', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: record.fqdnIn,
            type: RecordType.ANY,
            class: RecordClass.IN,
            qu: false,
          },
        ],
      };

      const response = responseMessage(packet, record, bindings, false);
      expect(response).not.toBeNull();

      const decoded = decode(response!);
      const answerTypes = decoded.answers!.map(a => a.type);
      expect(answerTypes).toContain(RecordType.SRV);
      expect(answerTypes).toContain(RecordType.TXT);
    });

    it('filters unicast vs multicast questions based on QU flag', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: record.fqdnIn,
            type: RecordType.SRV,
            class: RecordClass.IN,
            qu: true,
          },
        ],
      };

      const multicastResponse = responseMessage(
        packet,
        record,
        bindings,
        false
      );
      expect(multicastResponse).toBeNull();

      const unicastResponse = responseMessage(packet, record, bindings, true);
      expect(unicastResponse).not.toBeNull();
    });

    it('includes additionals for PTR responses (SRV, TXT, A, AAAA)', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: '_http._tcp.local',
            type: RecordType.PTR,
            class: RecordClass.IN,
            qu: false,
          },
        ],
      };

      const response = responseMessage(packet, record, bindings, false);
      const decoded = decode(response!);

      const additionalTypes = decoded.additionals!.map(a => a.type);
      expect(additionalTypes).toContain(RecordType.SRV);
      expect(additionalTypes).toContain(RecordType.TXT);
      expect(additionalTypes).toContain(RecordType.A);
      expect(additionalTypes).toContain(RecordType.AAAA);
    });

    it('responds to subtype PTR queries', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: ['printer'],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: 'printer._sub._http._tcp.local',
            type: RecordType.PTR,
            class: RecordClass.IN,
            qu: false,
          },
        ],
      };

      const response = responseMessage(packet, record, bindings, false);
      expect(response).not.toBeNull();

      const decoded = decode(response!);
      const ptrAnswer = decoded.answers!.find(a => a.type === RecordType.PTR);
      expect(ptrAnswer).toBeDefined();
      expect(ptrAnswer!.name).toBe('printer._sub._http._tcp.local');
    });

    it('skips records already present in known answers', () => {
      const input = createServiceInput({
        name: 'Test',
        type: 'http',
        protocol: 'tcp',
        hostname: 'testhost',
        port: 8080,
        subtypes: [],
        txt: {},
        ttl: 250,
      });
      const record = createServiceRecord(input);
      const bindings = createTestBindings();

      const packet = {
        type: PacketType.QUERY,
        questions: [
          {
            name: record.fqdnIn,
            type: RecordType.SRV,
            class: RecordClass.IN,
            qu: false,
          },
        ],
        answers: [
          {
            type: RecordType.SRV,
            name: record.fqdnIn,
            class: RecordClass.IN,
            ttl: 120,
            flush: false,
            data: {
              priority: 0,
              weight: 0,
              port: 8080,
              target: 'testhost.local',
            },
          },
        ],
      } as Packet;

      const response = responseMessage(packet, record, bindings, false);
      expect(response).toBeNull();
    });
  });
});
