import dgram from 'node:dgram';
import { BlockList } from 'node:net';

import { IPType, MDNSAddress, MDNS_PORT } from './constants';
import {
  type NetworkBinding,
  interfaceBindings,
  hasScopeid,
  parseIPv4,
  getIPv4PrefixFromNetmask,
  getIPv6PrefixFromNetmask,
} from './nics';

interface QueuedMessage {
  onSent(error: Error | null): void;
  message: Uint8Array;
  address: string;
  port: number;
}

interface SocketSettings {
  readonly family: IPType;
  readonly bindings: NetworkBinding[];
  readonly memberships: Set<string>;
  readonly multicastAddress: string;
  readonly multicastInterface: string;
}

export interface RemoteInfo {
  readonly socket: Socket;
  readonly family: IPType;
  readonly address: string;
  readonly port: number;
  reply(message: Uint8Array): Promise<void>;
}

export interface SocketParams {
  onMessage(msg: Buffer, rinfo: RemoteInfo): Promise<void> | void;
}

export interface Socket {
  readonly closed: boolean;
  readonly bindings: NetworkBinding[];
  send(message: Uint8Array): Promise<void>;
  refresh(): boolean;
  close(): void;
}

interface SocketState {
  settings: SocketSettings;
  socket: dgram.Socket;
}

const createSocketSettings = (
  iname: string,
  family: IPType
): SocketSettings | null => {
  const multicastAddress =
    family === IPType.v4 ? MDNSAddress.v4 : MDNSAddress.v6;
  const bindings = interfaceBindings(iname, family);
  if (!bindings?.length) {
    return null;
  }
  const memberships = new Set<string>();
  let multicastInterface: string;
  if (family === IPType.v4) {
    multicastInterface = bindings[0].address;
    for (const binding of bindings) memberships.add(binding.address);
  } else {
    const interfaceId =
      process.platform === 'win32'
        ? bindings.find(hasScopeid)?.scopeid.toString()
        : iname;
    if (!interfaceId) {
      return null;
    }
    memberships.add((multicastInterface = `::%${interfaceId}`));
  }
  let blocklist: BlockList | undefined;
  if (process.platform === 'linux') {
    blocklist = new BlockList();
    if (family === IPType.v4) {
      for (const binding of bindings) {
        const prefix = getIPv4PrefixFromNetmask(binding.netmask);
        blocklist.addSubnet(binding.address, prefix, 'ipv4');
      }
    }
  }
  return {
    family,
    bindings,
    memberships,
    multicastAddress,
    multicastInterface,
  };
};

const addMembership = (
  socket: dgram.Socket,
  settings: SocketSettings,
  membership: string
): boolean => {
  try {
    socket.addMembership(settings.multicastAddress, membership);
    return true;
  } catch (error) {
    return false;
  }
};

const dropMembership = (
  socket: dgram.Socket,
  settings: SocketSettings,
  membership: string
): boolean => {
  try {
    socket.dropMembership(settings.multicastAddress, membership);
    return true;
  } catch {
    return false;
  }
};

const createInterfaceSocket = (
  iname: string,
  family: IPType,
  params: SocketParams
): Socket => {
  const messageQueue: QueuedMessage[] = [];

  let timer: Promise<void> | null = null;
  let state: SocketState | null = initSocket();

  function initSocket() {
    const settings = createSocketSettings(iname, family);
    if (!settings) {
      return null;
    }

    // Node.js does not give us access to SO_BINDTODEVICE for Linux
    // However, Linux does not filter multicast UDP packets by membership
    // This means that our socket can receive messages for other interfaces
    // Blocking packets by address breaks mDNS over NAT, but we don't have a better alternative
    let filter: BlockList | undefined;
    if (process.platform === 'linux') {
      filter = new BlockList();
      for (const binding of settings.bindings) {
        if (binding.family === IPType.v4) {
          filter.addSubnet(
            binding.address,
            getIPv4PrefixFromNetmask(binding.netmask),
            'ipv4'
          );
        } else {
          filter.addSubnet(
            binding.address,
            getIPv6PrefixFromNetmask(binding.netmask),
            'ipv6'
          );
        }
      }
    }

    const dgramSocket = dgram.createSocket(
      family === IPType.v4
        ? { type: 'udp4', reuseAddr: true }
        : { type: 'udp6', reuseAddr: true, ipv6Only: true }
    );
    dgramSocket.unref();
    dgramSocket.on('message', async (message, rinfo) => {
      let zoneIdx = -1;
      if (family === IPType.v6 && (zoneIdx = rinfo.address.indexOf('%')) > -1) {
        // ignore messages intended for different interface
        const zone = rinfo.address.slice(zoneIdx + 1);
        if (zone !== iname) return;
      } else if (zoneIdx === -1 && !filter?.check(rinfo.address)) {
        // ignore messages intended for different subnet
        return;
      }

      try {
        await params.onMessage(message, {
          socket,
          family: rinfo.family === 'IPv6' ? IPType.v6 : IPType.v4,
          address: rinfo.address,
          port: rinfo.port,
          reply(message) {
            return send(message, rinfo.address, rinfo.port);
          },
        });
      } catch {
        // ignore errors here onMessage calls
      }
    });

    scheduleTimer(
      new Promise<void>((resolve, reject) => {
        dgramSocket.prependOnceListener('error', reject);
        dgramSocket.prependOnceListener('close', closeSocket);
        dgramSocket.bind(MDNS_PORT, () => {
          try {
            setupSocket(dgramSocket, settings);
            resolve();
          } catch (error) {
            closeSocket();
            reject(error);
          } finally {
            dgramSocket.removeListener('error', reject);
            dgramSocket.on('error', closeSocket);
          }
        });
      })
    );

    return { settings, socket: dgramSocket };
  }

  function setupSocket(
    dgramSocket: dgram.Socket,
    newSettings: SocketSettings
  ): boolean {
    const prevSettings =
      newSettings !== state?.settings ? state?.settings : null;
    let hasChanged =
      !!prevSettings &&
      prevSettings.multicastInterface !== newSettings.multicastInterface;
    try {
      dgramSocket.setMulticastTTL(255);
      dgramSocket.setMulticastLoopback(true);
      dgramSocket.setMulticastInterface(newSettings.multicastInterface);
    } catch {
      closeSocket();
      return false;
    }
    if (prevSettings) {
      for (const prevMembership of prevSettings.memberships) {
        if (!newSettings.memberships.has(prevMembership)) {
          dropMembership(dgramSocket, prevSettings, prevMembership);
          hasChanged = true;
        }
      }
    }
    for (const membership of newSettings.memberships) {
      if (!prevSettings?.memberships.has(membership)) {
        const added = addMembership(dgramSocket, newSettings, membership);
        if (!added) {
          newSettings.memberships.delete(membership);
        } else if (prevSettings) {
          hasChanged = true;
        }
      }
    }
    if (!newSettings.memberships.size) {
      closeSocket();
      return false;
    } else if (state) {
      state.settings = newSettings;
    }
    return hasChanged;
  }

  function closeSocket() {
    if (state) {
      const { socket } = state;
      state = null;
      try {
        socket.close();
      } catch {}
    }
  }

  function sendImmediate(input: QueuedMessage) {
    try {
      if (state) {
        state.socket.send(
          input.message,
          0,
          input.message.byteLength,
          input.port,
          input.address,
          input.onSent
        );
      } else {
        // Silently drops message if the socket is closed
        input.onSent(null);
      }
    } catch (error: any) {
      input.onSent(error);
    }
  }

  function flushQueue(timerId: Promise<unknown> | null) {
    if (timerId === null || timer === timerId) {
      timer = null;
    }
    let message: QueuedMessage | undefined;
    while (!timer && (message = messageQueue.shift()) != null) {
      sendImmediate(message);
    }
  }

  function waitTick() {
    return new Promise(resolve => setTimeout(resolve, 0).unref());
  }

  function scheduleTimer(promise = waitTick()) {
    if (!timer) {
      const timerId = (timer = promise.then(
        () => flushQueue(timerId),
        () => flushQueue(null)
      ));
    }
  }

  async function send(message: Uint8Array, address: string, port: number) {
    return new Promise<void>((resolve, reject) => {
      scheduleTimer();
      messageQueue.push({
        message,
        address,
        port,
        onSent(error) {
          if (error != null) {
            reject(error);
          } else {
            resolve();
          }
        },
      });
    });
  }

  const socket: Socket = {
    get closed() {
      return !state;
    },
    get bindings() {
      return state?.settings.bindings ?? [];
    },
    async send(message: Uint8Array) {
      if (state) {
        await send(message, state.settings.multicastAddress, MDNS_PORT);
      }
    },
    refresh() {
      if (state) {
        const newSettings = createSocketSettings(iname, family);
        if (newSettings) {
          return setupSocket(state.socket, newSettings);
        } else {
          closeSocket();
          return false;
        }
      } else {
        state = initSocket();
        return !!state;
      }
    },
    close() {
      closeSocket();
      flushQueue(null);
    },
  };

  return socket;
};

export const createSocket = (iname: string, params: SocketParams): Socket => {
  const ipv4 = createInterfaceSocket(iname, IPType.v4, params);
  const ipv6 = createInterfaceSocket(iname, IPType.v6, params);
  return {
    get closed() {
      return ipv4.closed && ipv6.closed;
    },
    get bindings() {
      return [...ipv4.bindings, ...ipv6.bindings];
    },
    async send(message: Uint8Array) {
      await Promise.all([ipv4.send(message), ipv6.send(message)]);
    },
    refresh() {
      const hasIPv4Changed = ipv4.refresh();
      const hasIPv6Changed = ipv6.refresh();
      return hasIPv4Changed || hasIPv6Changed;
    },
    close() {
      ipv4.close();
      ipv6.close();
    },
  };
};
