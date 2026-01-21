import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

import { createSocket, type SocketParams } from '../socket';
import { IPType, MDNSAddress, MDNS_PORT } from '../constants';

vi.mock('node:dgram', () => ({
  default: {
    createSocket: vi.fn(),
  },
}));

const createMockDgramSocket = () => {
  const emitter = new EventEmitter();
  const socket = {
    ...emitter,
    on: vi.fn((event, handler) => {
      emitter.on(event, handler);
      return socket;
    }),
    once: vi.fn((event, handler) => {
      emitter.once(event, handler);
      return socket;
    }),
    prependOnceListener: vi.fn((event, handler) => {
      emitter.prependOnceListener(event, handler);
      return socket;
    }),
    removeListener: vi.fn((event, handler) => {
      emitter.removeListener(event, handler);
      return socket;
    }),
    bind: vi.fn((_port, callback) => {
      setImmediate(callback);
    }),
    close: vi.fn(),
    send: vi.fn((_msg, _offset, _length, _port, _address, callback) => {
      setImmediate(() => callback?.(null));
    }),
    addMembership: vi.fn(),
    dropMembership: vi.fn(),
    setMulticastTTL: vi.fn(),
    setMulticastLoopback: vi.fn(),
    setMulticastInterface: vi.fn(),
    unref: vi.fn(),
    address: vi.fn().mockReturnValue({ address: '0.0.0.0', port: MDNS_PORT }),
    emit: emitter.emit.bind(emitter),
  };
  return socket;
};

describe('socket', () => {
  let mockDgramSocketV4: ReturnType<typeof createMockDgramSocket>;
  let mockDgramSocketV6: ReturnType<typeof createMockDgramSocket>;

  beforeEach(() => {
    mockDgramSocketV4 = createMockDgramSocket();
    mockDgramSocketV6 = createMockDgramSocket();

    let callCount = 0;
    vi.mocked(dgram.createSocket).mockImplementation(() => {
      callCount++;
      return callCount % 2 === 1
        ? (mockDgramSocketV4 as any)
        : (mockDgramSocketV6 as any);
    });

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
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createSocket', () => {
    it('creates dual-stack sockets for IPv4 and IPv6', () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      createSocket('en0', params);

      expect(dgram.createSocket).toHaveBeenCalledTimes(2);
      expect(dgram.createSocket).toHaveBeenCalledWith({
        type: 'udp4',
        reuseAddr: true,
      });
      expect(dgram.createSocket).toHaveBeenCalledWith({
        type: 'udp6',
        reuseAddr: true,
        ipv6Only: true,
      });
    });

    it('binds to mDNS port 5353', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalledWith(
          MDNS_PORT,
          expect.any(Function)
        );
        expect(mockDgramSocketV6.bind).toHaveBeenCalledWith(
          MDNS_PORT,
          expect.any(Function)
        );
      });
    });

    it('configures multicast settings after binding', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.setMulticastTTL).toHaveBeenCalledWith(255);
        expect(mockDgramSocketV4.setMulticastLoopback).toHaveBeenCalledWith(
          true
        );
        expect(mockDgramSocketV4.setMulticastInterface).toHaveBeenCalled();
        expect(mockDgramSocketV4.addMembership).toHaveBeenCalled();
      });
    });

    it('joins IPv4 multicast group 224.0.0.251', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.addMembership).toHaveBeenCalledWith(
          MDNSAddress.v4,
          expect.any(String)
        );
      });
    });

    it('joins IPv6 multicast group ff02::fb', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV6.addMembership).toHaveBeenCalledWith(
          MDNSAddress.v6,
          expect.stringMatching(/::%/)
        );
      });
    });

    it('unrefs sockets to not block process exit', () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      createSocket('en0', params);

      expect(mockDgramSocketV4.unref).toHaveBeenCalled();
      expect(mockDgramSocketV6.unref).toHaveBeenCalled();
    });
  });

  describe('socket.closed', () => {
    it('returns false when sockets are open', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      expect(socket.closed).toBe(false);
    });

    it('returns true after close() is called', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      socket.close();

      expect(socket.closed).toBe(true);
    });
  });

  describe('socket.bindings', () => {
    it('returns bindings from both IPv4 and IPv6 interfaces', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      const bindings = socket.bindings;

      expect(bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            address: '192.168.1.100',
            family: IPType.v4,
          }),
          expect.objectContaining({ address: 'fe80::1', family: IPType.v6 }),
        ])
      );
    });

    it('returns empty array after close', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      socket.close();

      expect(socket.bindings).toEqual([]);
    });
  });

  describe('socket.send', () => {
    it('sends message to multicast address on both sockets', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
        expect(mockDgramSocketV6.bind).toHaveBeenCalled();
      });

      const message = new Uint8Array([1, 2, 3, 4]);
      await socket.send(message);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.send).toHaveBeenCalledWith(
          message,
          0,
          message.byteLength,
          MDNS_PORT,
          MDNSAddress.v4,
          expect.any(Function)
        );
        expect(mockDgramSocketV6.send).toHaveBeenCalledWith(
          message,
          0,
          message.byteLength,
          MDNS_PORT,
          MDNSAddress.v6,
          expect.any(Function)
        );
      });
    });

    it('queues messages and sends them in order', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      const sentMessages: Uint8Array[] = [];
      mockDgramSocketV4.send.mockImplementation(
        (msg, _offset, _length, _port, _address, callback) => {
          sentMessages.push(msg);
          setImmediate(() => callback?.(null));
        }
      );

      const msg1 = new Uint8Array([1]);
      const msg2 = new Uint8Array([2]);
      const msg3 = new Uint8Array([3]);

      await Promise.all([
        socket.send(msg1),
        socket.send(msg2),
        socket.send(msg3),
      ]);

      expect(sentMessages).toHaveLength(3);
    });
  });

  describe('socket.refresh', () => {
    it('updates multicast memberships when bindings change', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      vi.spyOn(os, 'networkInterfaces').mockReturnValue({
        en0: [
          {
            address: '192.168.1.200',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:11:22:33:44:55',
            internal: false,
            cidr: '192.168.1.200/24',
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

      const changed = socket.refresh();

      expect(changed).toBe(true);
      expect(mockDgramSocketV4.dropMembership).toHaveBeenCalled();
      expect(mockDgramSocketV4.addMembership).toHaveBeenCalledWith(
        MDNSAddress.v4,
        '192.168.1.200'
      );
    });

    it('returns false when bindings have not changed', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      mockDgramSocketV4.dropMembership.mockClear();
      mockDgramSocketV4.addMembership.mockClear();

      const changed = socket.refresh();

      expect(changed).toBe(false);
    });

    it('reinitializes closed sockets', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      socket.close();
      expect(socket.closed).toBe(true);

      mockDgramSocketV4 = createMockDgramSocket();
      mockDgramSocketV6 = createMockDgramSocket();
      let callCount = 0;
      vi.mocked(dgram.createSocket).mockImplementation(() => {
        callCount++;
        return callCount % 2 === 1
          ? (mockDgramSocketV4 as any)
          : (mockDgramSocketV6 as any);
      });

      const refreshed = socket.refresh();

      expect(refreshed).toBe(true);
      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });
    });
  });

  describe('socket.close', () => {
    it('closes both underlying sockets', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      socket.close();

      expect(mockDgramSocketV4.close).toHaveBeenCalled();
      expect(mockDgramSocketV6.close).toHaveBeenCalled();
    });

    it('can be called multiple times safely', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      socket.close();
      socket.close();
      socket.close();

      expect(socket.closed).toBe(true);
    });
  });

  describe('onMessage callback', () => {
    it('invokes callback with message and remote info', async () => {
      const onMessage = vi.fn();
      const params: SocketParams = {
        stack: null,
        onMessage,
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      const message = Buffer.from([1, 2, 3, 4]);
      const rinfo = {
        address: '192.168.1.50',
        family: 'IPv4',
        port: 5353,
        size: 4,
      };

      mockDgramSocketV4.emit('message', message, rinfo);

      await vi.waitFor(() => {
        expect(onMessage).toHaveBeenCalledWith(
          message,
          expect.objectContaining({
            address: '192.168.1.50',
            port: 5353,
            family: IPType.v4,
          })
        );
      });
    });

    it('provides reply function in remote info', async () => {
      const onMessage = vi.fn().mockImplementation(async (_msg, rinfo) => {
        await rinfo.reply(new Uint8Array([5, 6, 7, 8]));
      });
      const params: SocketParams = {
        stack: null,
        onMessage,
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      const message = Buffer.from([1, 2, 3, 4]);
      const rinfo = {
        address: '192.168.1.50',
        family: 'IPv4',
        port: 5353,
        size: 4,
      };

      mockDgramSocketV4.emit('message', message, rinfo);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.send).toHaveBeenCalledWith(
          expect.any(Uint8Array),
          0,
          4,
          5353,
          '192.168.1.50',
          expect.any(Function)
        );
      });
    });

    it('handles IPv6 messages correctly', async () => {
      const onMessage = vi.fn();
      const params: SocketParams = {
        stack: null,
        onMessage,
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV6.bind).toHaveBeenCalled();
      });

      const message = Buffer.from([1, 2, 3, 4]);
      const rinfo = {
        address: 'fe80::2',
        family: 'IPv6',
        port: 5353,
        size: 4,
      };

      mockDgramSocketV6.emit('message', message, rinfo);

      await vi.waitFor(() => {
        expect(onMessage).toHaveBeenCalledWith(
          message,
          expect.objectContaining({
            address: 'fe80::2',
            family: IPType.v6,
          })
        );
      });
    });

    it('does not propagate errors from onMessage', async () => {
      const onMessage = vi.fn().mockRejectedValue(new Error('handler error'));
      onMessage.mockImplementation(async (_msg: Buffer, _rinfo: unknown) => {
        throw new Error('handler error');
      });
      const params: SocketParams = {
        stack: null,
        onMessage,
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      const message = Buffer.from([1, 2, 3, 4]);
      const rinfo = {
        address: '192.168.1.50',
        family: 'IPv4',
        port: 5353,
        size: 4,
      };

      mockDgramSocketV4.emit('message', message, rinfo);

      await vi.waitFor(() => {
        expect(onMessage).toHaveBeenCalled();
      });
    });
  });

  describe('error handling', () => {
    it('closes socket when multicast setup fails', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      mockDgramSocketV4.setMulticastInterface.mockImplementation(() => {
        throw new Error('multicast setup failed');
      });

      createSocket('en0', params);

      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));

      expect(mockDgramSocketV4.close).toHaveBeenCalled();
    });

    it('closes socket on socket error after setup', async () => {
      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      createSocket('en0', params);

      await new Promise(resolve => setImmediate(resolve));

      mockDgramSocketV4.emit('error', new Error('socket error'));

      await new Promise(resolve => setImmediate(resolve));

      expect(mockDgramSocketV4.close).toHaveBeenCalled();
    });
  });

  describe('graceful degradation', () => {
    it('handles interface with only IPv4', async () => {
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

      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      createSocket('en0', params);

      await vi.waitFor(() => {
        expect(mockDgramSocketV4.bind).toHaveBeenCalled();
      });

      expect(mockDgramSocketV6.addMembership).not.toHaveBeenCalled();
    });

    it('handles non-existent interface gracefully', async () => {
      vi.spyOn(os, 'networkInterfaces').mockReturnValue({});

      const params: SocketParams = {
        stack: null,
        onMessage: vi.fn(),
      };

      const socket = createSocket('nonexistent', params);

      expect(socket.closed).toBe(true);
      expect(socket.bindings).toEqual([]);
    });
  });
});
