import { createScheduler, Scheduler } from './scheduler';
import {
  createServiceRecord,
  createServiceInput,
  ServiceInput,
  ServiceRecord,
} from './service';
import { createSocket, Socket, SocketParams } from './socket';
import { hostname, networkInterfaceNames } from './nics';
import type { AdvertiseParams } from './advertise';

export enum IPType {
  v4 = 'IPv4',
  v6 = 'IPv6',
}

export enum MDNSAddress {
  v4 = '224.0.0.251',
  v6 = 'ff02::fb',
}

export const LABEL_LENGTH = 63;
export const MDNS_PORT = 5353;
export const DNSSD_NAME = '_services._dns-sd._udp.local';
export const SCHEDULER_WINDOW = 100;
export const SCHEDULER_MIN = 20;

export const REOPEN_FAILURE_LIMIT = 15;
export const PROBE_CONFLICT_LIMIT = 15;
export const PROBE_FAILURE_LIMIT = 15;

export interface Services {
  onError(error: unknown): void;
  createSocket(iname: string, params: SocketParams): Socket;
  createScheduler(): Scheduler;
  createServiceInput(params: AdvertiseParams): ServiceInput;
  createServiceRecord(input: ServiceInput): ServiceRecord;
  networkInterfaceNames(): string[];
  hostname(): string;
}

export const defaultServices: Services = {
  onError(_error: unknown) {},
  createSocket,
  createScheduler,
  createServiceInput,
  createServiceRecord,
  networkInterfaceNames,
  hostname,
};
