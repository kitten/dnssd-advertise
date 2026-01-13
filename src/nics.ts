import os from 'node:os';

import { IPType } from './constants';

export type { NetworkInterfaceInfo } from 'node:os';

export interface NetworkBinding {
  readonly iname: string;
  readonly family: IPType;
  readonly address: string;
  readonly netmask: string;
  readonly mac: string;
  readonly internal: boolean;
  readonly cidr: string | null;
  readonly scopeid?: number;
}

export const networkInterfaces = (() => {
  let _interfaces: ReturnType<typeof os.networkInterfaces> | null = null;
  let _promise: Promise<unknown> | null = null;
  return () => {
    if (!_interfaces) _interfaces = os.networkInterfaces();
    if (!_promise)
      _promise = Promise.resolve().then(() => (_interfaces = _promise = null));
    return _interfaces;
  };
})();

export const networkInterfaceNames = (): string[] => {
  const inames: string[] = [];
  const interfaces = networkInterfaces();
  for (const iname in interfaces) {
    const bindings = interfaces[iname];
    if (bindings?.some(binding => !binding.internal)) {
      inames.push(iname);
    }
  }
  return inames.length ? inames : Object.keys(interfaces);
};

export const interfaceBindings = (
  iname: string,
  family: IPType
): NetworkBinding[] | undefined => {
  const bindings = networkInterfaces()
    [iname]?.filter(binding => binding.family === family)
    .map(binding => ({ ...binding, family, iname }));
  return bindings?.length ? bindings : undefined;
};

export const hasScopeid = (
  bind: NetworkBinding
): bind is NetworkBinding & { scopeid: number } => {
  return bind.scopeid != null && bind.scopeid > 0;
};

let _hostname: string | undefined;
export const hostname = () => _hostname || (_hostname = os.hostname());

export const fingerprint = (port: number, seed: number) => {
  const value = `${hostname()}:${port}`;
  let hash = 5381;
  if (seed !== 0) hash = (hash << 5) + hash + (seed & 0xff);
  for (let i = 0, l = value.length; i < l; i++)
    hash = (hash << 5) + hash + value.charCodeAt(i);
  return (hash & 0xffff).toString(16).toUpperCase().padStart(4, '0');
};
