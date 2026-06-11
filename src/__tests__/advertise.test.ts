import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { bindingKeysMock } = vi.hoisted(() => ({
  bindingKeysMock: vi.fn<(bindings: unknown[]) => Set<string>>(),
}));

vi.mock('../nics', async () => {
  const actual = await vi.importActual<typeof import('../nics')>('../nics');
  return {
    ...actual,
    interfaceBindingKeys: bindingKeysMock,
  };
});

import {
  advertiseInternal,
  createInterfaceAdvertiser,
  type AdvertiseParams,
} from '../advertise';
import { createScheduler, cancelAll, AbortError } from '../scheduler';
import { createServiceInput, createServiceRecord } from '../service';
import { IPType } from '../constants';
import type { Services } from '../constants';
import type { Socket, SocketParams } from '../socket';
import type { NetworkBinding } from '../nics';
import {
  decode,
  PacketType,
  RecordType,
  encode,
  RecordClass,
  PacketFlag,
} from 'dns-message';

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

const createTestParams = (
  overrides?: Partial<AdvertiseParams>
): AdvertiseParams => ({
  name: 'Test Service',
  type: 'http',
  protocol: 'tcp',
  hostname: 'testhost',
  port: 8080,
  subtypes: [],
  txt: {},
  ttl: 250,
  stack: null,
  ...overrides,
});

const createMockSocket = (
  bindings: NetworkBinding[] = createTestBindings()
): Socket & {
  params: SocketParams | null;
  sentMessages: Uint8Array[];
  simulateMessage: (
    msg: Buffer,
    address: string,
    port: number
  ) => Promise<void>;
} => {
  let closed = false;
  let currentBindings = bindings;
  const sentMessages: Uint8Array[] = [];

  const socket: Socket & {
    params: SocketParams | null;
    sentMessages: Uint8Array[];
    simulateMessage: (
      msg: Buffer,
      address: string,
      port: number
    ) => Promise<void>;
  } = {
    get closed() {
      return closed;
    },
    get bindings() {
      return closed ? [] : currentBindings;
    },
    params: null,
    sentMessages,
    async send(message: Uint8Array) {
      if (!closed) {
        sentMessages.push(message);
      }
    },
    refresh() {
      if (closed) {
        closed = false;
        return true;
      }
      return false;
    },
    close() {
      closed = true;
    },
    async simulateMessage(msg: Buffer, address: string, port: number) {
      if (socket.params && !closed) {
        await socket.params.onMessage(msg, {
          socket: socket as unknown as Socket,
          family: address.includes(':') ? IPType.v6 : IPType.v4,
          address,
          port,
          async reply(message: Uint8Array) {
            sentMessages.push(message);
          },
        });
      }
    },
  };

  return socket;
};

const createMockServices = (
  socketOverride?: ReturnType<typeof createMockSocket>
): Services & {
  mockSocket: ReturnType<typeof createMockSocket>;
  errors: unknown[];
} => {
  const mockSocket = socketOverride || createMockSocket();
  const errors: unknown[] = [];

  return {
    mockSocket,
    errors,
    onError(error: unknown) {
      errors.push(error);
    },
    createSocket(_iname: string, params: SocketParams) {
      mockSocket.params = params;
      return mockSocket;
    },
    createScheduler,
    createServiceInput,
    createServiceRecord,
    networkInterfaceNames() {
      return ['en0'];
    },
    hostname() {
      return 'testhost';
    },
  };
};

describe('advertise', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    bindingKeysMock.mockReturnValue(new Set());
  });

  afterEach(() => {
    cancelAll();
    vi.useRealTimers();
    bindingKeysMock.mockReset();
  });

  describe('createInterfaceAdvertiser', () => {
    it('creates an advertiser handle with promise and close method', () => {
      const params = createTestParams();
      const services = createMockServices();

      const handle = createInterfaceAdvertiser('en0', params, services);

      expect(handle).toHaveProperty('promise');
      expect(handle).toHaveProperty('close');
      expect(handle.promise).toBeInstanceOf(Promise);
      expect(typeof handle.close).toBe('function');
    });

    it('sends probe messages during probing phase', async () => {
      const params = createTestParams();
      const services = createMockServices();

      createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(600);

      expect(services.mockSocket.sentMessages.length).toBeGreaterThan(0);

      const probePacket = decode(services.mockSocket.sentMessages[0]);
      expect(probePacket.type).toBe(PacketType.QUERY);
      expect(probePacket.questions).toBeDefined();
      expect(probePacket.questions!.some(q => q.type === RecordType.ANY)).toBe(
        true
      );
    });

    it('probe messages include authority records', async () => {
      const params = createTestParams();
      const services = createMockServices();

      createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(600);

      expect(services.mockSocket.sentMessages.length).toBeGreaterThan(0);

      const probePacket = decode(services.mockSocket.sentMessages[0]);
      expect(probePacket.authorities).toBeDefined();
      expect(probePacket.authorities!.length).toBeGreaterThan(0);

      const authorityTypes = probePacket.authorities!.map(a => a.type);
      expect(authorityTypes).toContain(RecordType.SRV);
    });

    it('probe questions target service FQDN and hostname', async () => {
      const params = createTestParams();
      const services = createMockServices();

      createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(600);

      const probePacket = decode(services.mockSocket.sentMessages[0]);
      const questionNames = probePacket.questions!.map(q =>
        q.name.toLowerCase()
      );

      expect(questionNames.some(n => n.includes('test service'))).toBe(true);
      expect(questionNames.some(n => n.includes('testhost'))).toBe(true);
    });

    it('closes socket when close() is called', async () => {
      const params = createTestParams();
      const services = createMockServices();

      const handle = createInterfaceAdvertiser('en0', params, services);

      handle.close();
      await vi.runAllTimersAsync();

      expect(services.mockSocket.closed).toBe(true);
    });
  });

  describe('conflict detection during probing', () => {
    it('detects name conflict from SRV response with different port', async () => {
      const params = createTestParams();
      const services = createMockServices();
      const initialMessageCount = services.mockSocket.sentMessages.length;

      createInterfaceAdvertiser('en0', params, services);

      const conflictPacket = encode({
        type: PacketType.RESPONSE,
        flags: PacketFlag.AUTHORITATIVE_ANSWER,
        answers: [
          {
            type: RecordType.SRV,
            class: RecordClass.IN,
            name: 'test service._http._tcp.local',
            ttl: 120,
            flush: true,
            data: {
              priority: 0,
              weight: 0,
              port: 9999,
              target: 'otherhost.local',
            },
          },
        ],
      });

      await services.mockSocket.simulateMessage(
        Buffer.from(conflictPacket),
        '192.168.1.50',
        5353
      );

      await vi.advanceTimersByTimeAsync(1000);

      expect(services.mockSocket.sentMessages.length).toBeGreaterThan(
        initialMessageCount
      );
    });

    it('detects hostname conflict from A response with different address', async () => {
      const params = createTestParams();
      const services = createMockServices();
      const initialMessageCount = services.mockSocket.sentMessages.length;

      createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(100);

      const conflictPacket = encode({
        type: PacketType.RESPONSE,
        flags: PacketFlag.AUTHORITATIVE_ANSWER,
        answers: [
          {
            type: RecordType.A,
            class: RecordClass.IN,
            name: 'testhost.local',
            ttl: 120,
            flush: true,
            data: '10.0.0.99',
          },
        ],
      });

      await services.mockSocket.simulateMessage(
        Buffer.from(conflictPacket),
        '192.168.1.50',
        5353
      );

      await vi.advanceTimersByTimeAsync(1000);

      expect(services.mockSocket.sentMessages.length).toBeGreaterThan(
        initialMessageCount
      );
    });

    it('ignores responses that match our own addresses', async () => {
      const params = createTestParams();
      const services = createMockServices();

      createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(100);

      const ownPacket = encode({
        type: PacketType.RESPONSE,
        flags: PacketFlag.AUTHORITATIVE_ANSWER,
        answers: [
          {
            type: RecordType.A,
            class: RecordClass.IN,
            name: 'testhost.local',
            ttl: 120,
            flush: true,
            data: '192.168.1.100',
          },
        ],
      });

      await services.mockSocket.simulateMessage(
        Buffer.from(ownPacket),
        '192.168.1.100',
        5353
      );

      await vi.advanceTimersByTimeAsync(500);
    });

    it('extends probing when a conflict is detected during probe phase', async () => {
      const params = createTestParams();
      const services = createMockServices();

      createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(300);
      const initialMessageCount = services.mockSocket.sentMessages.length;

      const conflictPacket = encode({
        type: PacketType.RESPONSE,
        flags: PacketFlag.AUTHORITATIVE_ANSWER,
        answers: [
          {
            type: RecordType.SRV,
            class: RecordClass.IN,
            name: 'test service._http._tcp.local',
            ttl: 120,
            flush: true,
            data: {
              priority: 0,
              weight: 0,
              port: 9999,
              target: 'otherhost.local',
            },
          },
        ],
      });

      await services.mockSocket.simulateMessage(
        Buffer.from(conflictPacket),
        '192.168.1.50',
        5353
      );

      await vi.advanceTimersByTimeAsync(2000);

      expect(services.mockSocket.sentMessages.length).toBeGreaterThan(
        initialMessageCount + 2
      );
    });

    it('adds 1 second delay when losing a tiebreaker during probing', async () => {
      const params = createTestParams();
      const services = createMockServices();

      createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(300);
      const messageCountBeforeConflict =
        services.mockSocket.sentMessages.length;

      const tiebreakerPacket = encode({
        type: PacketType.QUERY,
        questions: [
          {
            name: 'testhost.local',
            type: RecordType.ANY,
            class: RecordClass.IN,
            qu: true,
          },
        ],
        authorities: [
          {
            type: RecordType.A,
            class: RecordClass.IN,
            name: 'testhost.local',
            ttl: 120,
            flush: true,
            data: '255.255.255.255',
          },
        ],
      });

      await services.mockSocket.simulateMessage(
        Buffer.from(tiebreakerPacket),
        '192.168.1.50',
        5353
      );

      await vi.advanceTimersByTimeAsync(1500);
      expect(services.mockSocket.sentMessages.length).toBeGreaterThan(
        messageCountBeforeConflict
      );
    });
  });

  describe('advertiseInternal', () => {
    it('creates advertisers for all network interfaces', () => {
      const params = createTestParams();
      const createSocketSpy = vi
        .fn()
        .mockImplementation((_iname, socketParams) => {
          const socket = createMockSocket();
          socket.params = socketParams;
          return socket;
        });

      const services: Services = {
        onError: vi.fn(),
        createSocket: createSocketSpy,
        createScheduler,
        createServiceInput,
        createServiceRecord,
        networkInterfaceNames() {
          return ['en0', 'en1', 'wlan0'];
        },
        hostname() {
          return 'testhost';
        },
      };

      advertiseInternal(params, services);

      expect(createSocketSpy).toHaveBeenCalledTimes(3);
      expect(createSocketSpy).toHaveBeenCalledWith('en0', expect.any(Object));
      expect(createSocketSpy).toHaveBeenCalledWith('en1', expect.any(Object));
      expect(createSocketSpy).toHaveBeenCalledWith('wlan0', expect.any(Object));
    });

    it('returns a close function', () => {
      const params = createTestParams();
      const services = createMockServices();

      const close = advertiseInternal(params, services);

      expect(typeof close).toBe('function');
    });

    it('detects new network interfaces over time', async () => {
      const params = createTestParams();
      let interfaces = ['en0'];
      const createSocketSpy = vi
        .fn()
        .mockImplementation((_iname, socketParams) => {
          const socket = createMockSocket();
          socket.params = socketParams;
          return socket;
        });

      const services: Services = {
        onError: vi.fn(),
        createSocket: createSocketSpy,
        createScheduler,
        createServiceInput,
        createServiceRecord,
        networkInterfaceNames() {
          return interfaces;
        },
        hostname() {
          return 'testhost';
        },
      };

      advertiseInternal(params, services);

      expect(createSocketSpy).toHaveBeenCalledTimes(1);

      interfaces = ['en0', 'en1'];

      await vi.advanceTimersByTimeAsync(7000);

      expect(createSocketSpy).toHaveBeenCalledTimes(2);
      expect(createSocketSpy).toHaveBeenLastCalledWith(
        'en1',
        expect.any(Object)
      );
    });

    it('closes advertisers for removed network interfaces', async () => {
      const params = createTestParams();
      let interfaces = ['en0', 'en1'];
      const mockSockets = new Map<
        string,
        ReturnType<typeof createMockSocket>
      >();

      const services: Services = {
        onError: vi.fn(),
        createSocket(iname, socketParams) {
          const socket = createMockSocket();
          socket.params = socketParams;
          mockSockets.set(iname, socket);
          return socket;
        },
        createScheduler,
        createServiceInput,
        createServiceRecord,
        networkInterfaceNames() {
          return interfaces;
        },
        hostname() {
          return 'testhost';
        },
      };

      advertiseInternal(params, services);

      expect(mockSockets.size).toBe(2);

      interfaces = ['en0'];

      await vi.advanceTimersByTimeAsync(7000);

      expect(mockSockets.get('en1')!.closed).toBe(true);
    });

    describe('FAILED interface retry', () => {
      // Create a mock socket that bails to FAILED quickly: refresh always
      // fails, socket starts closed.
      const createBailingSocket = () => {
        const socket = createMockSocket();
        vi.spyOn(socket, 'refresh').mockReturnValue(false);
        socket.close();
        return socket;
      };

      const buildServices = (interfaceList: () => string[]) => {
        const createSocketSpy = vi
          .fn()
          .mockImplementation((_iname, socketParams) => {
            const socket = createBailingSocket();
            socket.params = socketParams;
            return socket;
          });
        const services: Services = {
          onError: vi.fn(),
          createSocket: createSocketSpy,
          createScheduler,
          createServiceInput,
          createServiceRecord,
          networkInterfaceNames: interfaceList,
          hostname() {
            return 'testhost';
          },
        };
        return { services, createSocketSpy };
      };

      it('retries a FAILED handle when bindings change', async () => {
        bindingKeysMock.mockReturnValue(new Set(['10.0.0.1/255.255.255.0']));
        const { services, createSocketSpy } = buildServices(() => ['en0']);

        advertiseInternal(createTestParams(), services);
        expect(createSocketSpy).toHaveBeenCalledTimes(1);

        // First handle bails to FAILED (~90s via reopen counter)
        await vi.advanceTimersByTimeAsync(120000);
        // First polling observation records the bindings
        await vi.advanceTimersByTimeAsync(7000);
        expect(createSocketSpy).toHaveBeenCalledTimes(1);

        bindingKeysMock.mockReturnValue(new Set(['10.0.0.2/255.255.255.0']));

        // Next polling cycle observes the change and recreates
        await vi.advanceTimersByTimeAsync(7000);
        expect(createSocketSpy).toHaveBeenCalledTimes(2);
      });

      it('does not retry when bindings are unchanged', async () => {
        bindingKeysMock.mockReturnValue(new Set(['10.0.0.1/255.255.255.0']));
        const { services, createSocketSpy } = buildServices(() => ['en0']);

        advertiseInternal(createTestParams(), services);

        await vi.advanceTimersByTimeAsync(180000);

        expect(createSocketSpy).toHaveBeenCalledTimes(1);
      });

      it('clears binding state when iname disappears and reappears', async () => {
        bindingKeysMock.mockReturnValue(new Set(['10.0.0.1/255.255.255.0']));
        let interfaces = ['en0'];
        const { services, createSocketSpy } = buildServices(() => interfaces);

        advertiseInternal(createTestParams(), services);

        // Wait for bail + first bindings observation
        await vi.advanceTimersByTimeAsync(120000);
        await vi.advanceTimersByTimeAsync(7000);
        expect(createSocketSpy).toHaveBeenCalledTimes(1);

        interfaces = [];
        await vi.advanceTimersByTimeAsync(7000);

        // Reappears with identical bindings — without the cleanup, the cached
        // entry would block recreation
        interfaces = ['en0'];
        await vi.advanceTimersByTimeAsync(7000);
        expect(createSocketSpy).toHaveBeenCalledTimes(2);
      });

      it('records bindings at settle time, not at the first polling cycle', async () => {
        // Verifies the .then() hook: bindings change between bail and the next
        // poll. Without the hook, the change is aliased away by the first
        // polling observation and we never retry.
        bindingKeysMock.mockReturnValue(new Set(['fp-at-bail']));
        const { services, createSocketSpy } = buildServices(() => ['en0']);

        advertiseInternal(createTestParams(), services);

        // Advance just past bail so the .then() microtask runs
        await vi.advanceTimersByTimeAsync(92000);

        // Change bindings before the next polling cycle fires
        bindingKeysMock.mockReturnValue(new Set(['fp-after-bail']));

        await vi.advanceTimersByTimeAsync(10000);

        expect(createSocketSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('error handling', () => {
    it('does not report AbortError through onError', async () => {
      const params = createTestParams();
      const services = createMockServices();

      const handle = createInterfaceAdvertiser('en0', params, services);

      handle.close();
      await vi.runAllTimersAsync();

      const hasAbortError = services.errors.some(e =>
        AbortError.isAbortError(e)
      );
      expect(hasAbortError).toBe(false);
    });

    it('handles closed socket gracefully during send', async () => {
      const params = createTestParams();
      const mockSocket = createMockSocket();
      const services = createMockServices(mockSocket);

      createInterfaceAdvertiser('en0', params, services);

      mockSocket.close();

      await vi.advanceTimersByTimeAsync(1000);
    });
  });

  describe('infinite re-announce prevention', () => {
    it('does not loop forever or stack overflow when socket is closed during operation', async () => {
      const params = createTestParams();
      const mockSocket = createMockSocket();
      const services = createMockServices(mockSocket);

      const handle = createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(10000);
      mockSocket.close();

      // No race-against-timer: a regression that re-introduces a loop hangs the test
      await vi.advanceTimersByTimeAsync(200000);
      await handle.promise;

      expect(services.errors.length).toBeGreaterThan(0);
    });

    it('bails out with onError when interface cannot host mDNS', async () => {
      const params = createTestParams();
      const mockSocket = createMockSocket();
      vi.spyOn(mockSocket, 'refresh').mockReturnValue(false);
      const services = createMockServices(mockSocket);

      mockSocket.close();

      const handle = createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(150000);
      await handle.promise;

      expect(services.errors.length).toBeGreaterThan(0);
      const message =
        services.errors[0] instanceof Error
          ? services.errors[0].message
          : String(services.errors[0]);
      expect(message).toContain('en0');
    });

    it('bails out when probes never see any traffic across many cycles', async () => {
      const params = createTestParams();
      const mockSocket = createMockSocket();
      // refresh always succeeds, so only the loops counter can bail
      vi.spyOn(mockSocket, 'refresh').mockReturnValue(true);
      const services = createMockServices(mockSocket);

      const handle = createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(300000);
      await handle.promise;

      expect(services.errors.length).toBeGreaterThan(0);
      const message =
        services.errors[0] instanceof Error
          ? services.errors[0].message
          : String(services.errors[0]);
      expect(message).toContain('en0');
      expect(message).toContain('state cycles');
    });

    it('resets reopen failure count between calls', async () => {
      const params = createTestParams();
      const mockSocket = createMockSocket();
      const realRefresh = mockSocket.refresh.bind(mockSocket);
      let refreshCount = 0;
      vi.spyOn(mockSocket, 'refresh').mockImplementation(() => {
        refreshCount++;
        // 14 failures, then one success, then failures forever
        return refreshCount === 15 ? realRefresh() : false;
      });
      const services = createMockServices(mockSocket);
      mockSocket.close();

      const handle = createInterfaceAdvertiser('en0', params, services);

      // Without per-call reset, the next failure after the success would push
      // the counter to 15 and bail at ~97s
      await vi.advanceTimersByTimeAsync(120000);
      expect(services.errors).toEqual([]);

      // With per-call reset, bail happens after a fresh 15 failures (~181s)
      await vi.advanceTimersByTimeAsync(80000);
      await handle.promise;
      expect(services.errors.length).toBeGreaterThan(0);
    });

    it('close() is safe after the advertiser has bailed to FAILED', async () => {
      const params = createTestParams();
      const mockSocket = createMockSocket();
      vi.spyOn(mockSocket, 'refresh').mockReturnValue(false);
      const services = createMockServices(mockSocket);
      mockSocket.close();

      const handle = createInterfaceAdvertiser('en0', params, services);
      await vi.advanceTimersByTimeAsync(150000);
      await handle.promise;

      const errorsBefore = services.errors.length;
      await expect(handle.close()).resolves.toBeUndefined();
      expect(services.errors.length).toBe(errorsBefore);
    });

    it('preserves bindings on the handle after the advertiser bails', async () => {
      // Without the finalBindings snapshot, handle.bindings would be empty
      // post-bail (the IIFE finally has already closed the socket).
      const params = createTestParams();
      const mockSocket = createMockSocket();
      vi.spyOn(mockSocket, 'refresh').mockReturnValue(false);
      const services = createMockServices(mockSocket);

      const handle = createInterfaceAdvertiser('en0', params, services);

      await vi.advanceTimersByTimeAsync(150000);
      await handle.promise;

      expect(mockSocket.closed).toBe(true);
      expect(handle.bindings.length).toBeGreaterThan(0);
    });
  });

  describe('socket lifecycle', () => {
    it('attempts to reopen closed sockets', async () => {
      const params = createTestParams();
      const mockSocket = createMockSocket();
      const refreshSpy = vi.spyOn(mockSocket, 'refresh');
      const services = createMockServices(mockSocket);

      createInterfaceAdvertiser('en0', params, services);

      mockSocket.close();
      expect(mockSocket.closed).toBe(true);

      await vi.advanceTimersByTimeAsync(10000);

      expect(refreshSpy).toHaveBeenCalled();
    });
  });

  describe('stable advertising', () => {
    // Mock has no loopback — probes need explicit injection to reach ADVERTISE
    const benignProbePacket = () =>
      encode({
        type: PacketType.RESPONSE,
        answers: [],
      });

    it('reaches ADVERTISE and sends announcements when probes are received', async () => {
      const params = createTestParams();
      const services = createMockServices();
      const handle = createInterfaceAdvertiser('en0', params, services);

      await services.mockSocket.simulateMessage(
        Buffer.from(benignProbePacket()),
        '192.168.1.50',
        5353
      );

      await vi.advanceTimersByTimeAsync(2000);

      const decoded = services.mockSocket.sentMessages.map(decode);
      const hasAnnouncement = decoded.some(p => p.type === PacketType.RESPONSE);
      expect(hasAnnouncement).toBe(true);

      handle.close();
      await vi.runAllTimersAsync();
    });

    it('does not bail during sustained healthy advertising', async () => {
      const params = createTestParams();
      const services = createMockServices();
      const handle = createInterfaceAdvertiser('en0', params, services);

      await services.mockSocket.simulateMessage(
        Buffer.from(benignProbePacket()),
        '192.168.1.50',
        5353
      );

      await vi.advanceTimersByTimeAsync(300000);

      expect(services.errors).toEqual([]);

      handle.close();
      await vi.runAllTimersAsync();
    });

    it('sends a goodbye when close() is called during ADVERTISE', async () => {
      const params = createTestParams();
      const services = createMockServices();
      const handle = createInterfaceAdvertiser('en0', params, services);

      await services.mockSocket.simulateMessage(
        Buffer.from(benignProbePacket()),
        '192.168.1.50',
        5353
      );
      await vi.advanceTimersByTimeAsync(2000);

      const beforeClose = services.mockSocket.sentMessages.length;
      const closePromise = handle.close();
      await vi.advanceTimersByTimeAsync(500);
      await closePromise;

      expect(services.mockSocket.sentMessages.length).toBeGreaterThan(
        beforeClose
      );
    });

    it('re-probes and keeps running after conflict during ADVERTISE', async () => {
      const params = createTestParams();
      const services = createMockServices();
      const handle = createInterfaceAdvertiser('en0', params, services);

      await services.mockSocket.simulateMessage(
        Buffer.from(benignProbePacket()),
        '192.168.1.50',
        5353
      );
      await vi.advanceTimersByTimeAsync(2000);
      const messagesAfterAdvertise = services.mockSocket.sentMessages.length;

      const conflictPacket = encode({
        type: PacketType.RESPONSE,
        flags: PacketFlag.AUTHORITATIVE_ANSWER,
        answers: [
          {
            type: RecordType.SRV,
            class: RecordClass.IN,
            name: 'test service._http._tcp.local',
            ttl: 120,
            flush: true,
            data: {
              priority: 0,
              weight: 0,
              port: 9999,
              target: 'otherhost.local',
            },
          },
        ],
      });
      await services.mockSocket.simulateMessage(
        Buffer.from(conflictPacket),
        '192.168.1.50',
        5353
      );
      // announce must wind down before probe restarts
      await vi.advanceTimersByTimeAsync(20000);

      const newDecoded = services.mockSocket.sentMessages
        .slice(messagesAfterAdvertise)
        .map(decode);
      expect(newDecoded.some(p => p.type === PacketType.QUERY)).toBe(true);
      expect(services.errors).toEqual([]);

      const closePromise = handle.close();
      await vi.advanceTimersByTimeAsync(500);
      await closePromise;
    });

    it('bails when ADVERTISE is interrupted by a socket close', async () => {
      const params = createTestParams();
      const mockSocket = createMockSocket();
      // Prevent the announce-time refresh from auto-recovering the socket
      vi.spyOn(mockSocket, 'refresh').mockReturnValue(false);
      const services = createMockServices(mockSocket);
      const handle = createInterfaceAdvertiser('en0', params, services);

      await services.mockSocket.simulateMessage(
        Buffer.from(benignProbePacket()),
        '192.168.1.50',
        5353
      );
      await vi.advanceTimersByTimeAsync(2000);

      services.mockSocket.close();

      await vi.advanceTimersByTimeAsync(200000);
      await handle.promise;

      expect(services.errors.length).toBeGreaterThan(0);
    });
  });
});
