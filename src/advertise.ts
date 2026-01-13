import { type Packet, PacketType, decode } from 'dns-message';

import type { RemoteInfo } from './socket';
import { AbortError, TaskKind } from './scheduler';
import { MAX_SETUPS, defaultServices, Services } from './constants';

import {
  TxtValue,
  ConflictFlag,
  checkResponseConflicts,
  checkQuestionConflicts,
  responseMessage,
  probeMessage,
  announceMessage,
  goodbyeMessage,
} from './service';

export interface AdvertiseOptions {
  /** Instance/display name of the service */
  name: string;
  /** Service type without protocol (e.g. "http") */
  type: string;
  /** Protocol used by the service (typically "tcp" or "udp") */
  protocol: 'tcp' | 'udp' | (string & {});
  /** Hostname of device offering the service */
  hostname?: string;
  /** Port the service is listening on */
  port: number;
  /** List of subtypes for selective discovery */
  subtypes?: string[];
  /** Service metadata */
  txt?: Record<string, TxtValue>;
  /** TTL to apply to service records */
  ttl?: number;
}

export interface AdvertiseParams {
  name: string;
  type: string;
  protocol: string;
  hostname: string;
  port: number;
  subtypes: string[];
  txt: Record<string, TxtValue>;
  ttl: number;
}

const enum AdvertiserState {
  PROBING = 0,
  ADVERTISE = 2,
  CLOSED = 3,
}

export interface AdvertiserHandle {
  readonly promise: Promise<void>;
  close(): Promise<void>;
}

export function createInterfaceAdvertiser(
  iname: string,
  params: AdvertiseParams,
  services: Services
): AdvertiserHandle {
  const input = services.createServiceInput(params);
  const scheduler = services.createScheduler();

  let loops = 0;
  let probes = 0;
  let srv = services.createServiceRecord(input);
  let state = AdvertiserState.PROBING;
  let conflict = ConflictFlag.NONE;

  const socket = services.createSocket(iname, {
    async onMessage(msg, rinfo) {
      if (state === AdvertiserState.CLOSED) {
        return;
      }
      const packet = decode(msg);
      if (state === AdvertiserState.PROBING) {
        probes++;
        if (packet.type === PacketType.QUERY) {
          const flag = checkQuestionConflicts(packet, srv, socket.bindings);
          conflict |=
            flag !== ConflictFlag.NONE
              ? flag | ConflictFlag.LOST_TIEBREAKER
              : ConflictFlag.NONE;
        } else if (packet.type === PacketType.RESPONSE) {
          conflict |= checkResponseConflicts(packet, srv, socket.bindings);
        }
      } else if (state === AdvertiserState.ADVERTISE) {
        conflict = checkResponseConflicts(packet, srv, socket.bindings);
        if (resolveConflicts()) {
          state = AdvertiserState.PROBING;
        } else {
          try {
            await sendReply(packet, rinfo);
          } catch (error) {
            if (!AbortError.isAbortError(error)) {
              services.onError(error);
            }
          }
        }
      }
    },
  });

  async function sendReply(packet: Packet, rinfo: RemoteInfo) {
    const unicastMsg = responseMessage(packet, srv, socket.bindings, false);
    const multicastMsg = responseMessage(packet, srv, socket.bindings, true);
    await Promise.all([
      unicastMsg &&
        scheduler.schedule(TaskKind.SEND, () => rinfo.reply(unicastMsg)),
      multicastMsg &&
        scheduler.schedule(TaskKind.SEND, () => socket.send(multicastMsg)),
    ]);
  }

  async function sendProbe() {
    const msg = probeMessage(srv, socket.bindings);
    await scheduler.schedule(TaskKind.SEND, () => socket.send(msg));
  }

  async function sendAnnouncement() {
    const msg = announceMessage(srv, socket.bindings);
    await scheduler.schedule(TaskKind.SEND, () => socket.send(msg));
  }

  async function sendGoodbye() {
    const msg = goodbyeMessage(srv, socket.bindings);
    await scheduler.schedule(TaskKind.SEND, () => socket.send(msg));
  }

  function resolveConflicts() {
    if (conflict !== ConflictFlag.NONE) {
      if (conflict & ConflictFlag.NAME) input.nameSeed++;
      if (conflict & ConflictFlag.HOSTNAME) input.hostnameSeed++;
      srv = services.createServiceRecord(input);
      conflict = ConflictFlag.NONE;
      return true;
    } else {
      return false;
    }
  }

  async function probe() {
    probes = 0;
    conflict = ConflictFlag.NONE;

    let maxAttempts = 3;
    await scheduler.schedule(TaskKind.PROBE, async task => {
      const hasLostTiebreaker = conflict & ConflictFlag.LOST_TIEBREAKER;
      if (socket.closed) {
        state = AdvertiserState.CLOSED;
        return;
      } else if (state !== AdvertiserState.PROBING) {
        return;
      } else if (resolveConflicts()) {
        maxAttempts += 4;
        return task.retry(hasLostTiebreaker ? 1000 : undefined);
      } else if (task.attempt < maxAttempts) {
        await sendProbe();
        return task.retry();
      } else {
        state = probes
          ? conflict === ConflictFlag.NONE
            ? AdvertiserState.ADVERTISE
            : AdvertiserState.CLOSED
          : (state = AdvertiserState.CLOSED);
      }
    });

    return next();
  }

  async function announce() {
    while (state === AdvertiserState.ADVERTISE && !socket.closed) {
      const didRefresh = await scheduler.schedule(
        TaskKind.ANNOUNCE,
        async task => {
          if (state !== AdvertiserState.ADVERTISE) {
            return false;
          } else if (task.attempt > 2 && socket.refresh()) {
            return true;
          }
          if (!socket.closed) {
            await sendAnnouncement();
            if (task.attempt < 3) {
              return task.retry();
            }
          }
          return false;
        }
      );

      if (!didRefresh) {
        await scheduler.schedule(TaskKind.REOPEN, async task => {
          if (state !== AdvertiserState.ADVERTISE) {
            return;
          } else if (!socket.refresh() && !socket.closed) {
            return task.retry();
          }
        });
      }
    }

    return next();
  }

  async function reopen() {
    scheduler.cancel();
    if (loops++ > MAX_SETUPS) {
      return;
    }
    await scheduler.schedule(TaskKind.REOPEN, async task => {
      if (state !== AdvertiserState.CLOSED) {
        return;
      }
      if (!socket.refresh() || socket.closed) {
        return task.retry();
      }
      state = AdvertiserState.PROBING;
    });
    return next();
  }

  function next() {
    switch (state) {
      case AdvertiserState.PROBING:
        return probe();
      case AdvertiserState.ADVERTISE:
        return announce();
      case AdvertiserState.CLOSED:
        return reopen();
    }
  }

  return {
    promise: (async () => {
      try {
        state = AdvertiserState.PROBING;
        await next();
        scheduler.cancel();
      } catch (error) {
        if (!AbortError.isAbortError(error)) {
          services.onError(error);
        }
      } finally {
        socket.close();
      }
    })(),
    async close() {
      try {
        scheduler.cancel();
        if (state !== AdvertiserState.CLOSED) {
          state = AdvertiserState.CLOSED;
          await sendGoodbye();
        }
        scheduler.cancel();
      } catch (error) {
        if (!AbortError.isAbortError(error)) {
          services.onError(error);
        }
      } finally {
        socket.close();
      }
    },
  };
}

export function advertiseInternal(
  params: AdvertiseParams,
  services: Services
): () => Promise<void> {
  const inames = new Set(services.networkInterfaceNames());
  const handles = new Map<string, AdvertiserHandle>();
  const scheduler = services.createScheduler();

  for (const iname of inames) {
    handles.set(iname, createInterfaceAdvertiser(iname, params, services));
  }

  scheduler.schedule(TaskKind.REOPEN, task => {
    try {
      const inames = new Set(services.networkInterfaceNames());
      for (const iname of inames) {
        if (!handles.has(iname)) {
          handles.set(
            iname,
            createInterfaceAdvertiser(iname, params, services)
          );
        }
      }
      for (const [iname, handle] of handles) {
        if (!inames.has(iname)) {
          handles.delete(iname);
          handle.close();
        }
      }
      return task.retry();
    } catch (error) {
      if (!AbortError.isAbortError(error)) {
        services.onError(error);
      }
    }
  });

  return async () => {
    scheduler.cancel();
    await Promise.all([...handles.values()].map(handle => handle.close()));
  };
}

export function advertise(options: AdvertiseOptions): () => Promise<void> {
  return advertiseInternal(
    {
      name: options.name,
      type: options.type,
      protocol: options.protocol,
      hostname: options.hostname || defaultServices.hostname(),
      port: options.port,
      subtypes: options.subtypes || [],
      txt: options.txt || {},
      ttl: options.ttl || 250,
    },
    defaultServices
  );
}
