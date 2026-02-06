import {
  Packet,
  RecordType,
  RecordClass,
  SrvAnswer,
  AAnswer,
  AAAAAnswer,
  PacketType,
  TxtAnswer,
  PtrAnswer,
  PacketFlag,
  Answer,
  Question,
  encode,
  compareAnswers,
} from 'dns-message';

import { hostname, fingerprint, NetworkBinding } from './nics';
import { IPType, DNSSD_NAME, LABEL_LENGTH } from './constants';
import type { AdvertiseParams } from './advertise';

export type TxtValue = string | number | boolean | null | undefined;

export interface ServiceInput extends AdvertiseParams {
  nameSeed: number;
  hostnameSeed: number;
}

export interface ServiceRecord {
  domain: string;
  fqdnOut: string;
  fqdnIn: string;
  host: string;
  port: number;
  subtypes: Record<string, true | undefined>;
  txt: string[];
  ttl: number;
}

let hadOSHostnameConflict = false;

export const createServiceInput = (options: AdvertiseParams): ServiceInput => ({
  ...options,
  nameSeed: 0,
  hostnameSeed:
    hadOSHostnameConflict && options.hostname === hostname() ? 1 : 0,
});

const sanitizeSubtype = (subtype: string): string =>
  subtype
    .trim()
    .replace(/[^a-zA-Z0-9-_.]/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

const sanitizeLabel = (label: string): string =>
  label
    .trim()
    .replace(/\.local\.?$/i, '')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, LABEL_LENGTH);

const sanitizeName = (name: string): string =>
  name.trim().replace(/\.+/, '_').slice(0, LABEL_LENGTH);

const createServiceHost = (input: string, seed: number) => {
  let host = sanitizeLabel(input);
  if (seed) {
    hadOSHostnameConflict ||= input === hostname();
    const match = /[-_](\d+)$/.exec(host);
    if (match) {
      const prefix = host.slice(0, -match[0].length);
      const postfix = parseInt(match[1], 10);
      const suffix = `-${(postfix || seed) + 1}`;
      host = prefix.slice(0, LABEL_LENGTH - suffix.length) + suffix;
    } else {
      const suffix = `-${seed + 1}`;
      host = host.slice(0, LABEL_LENGTH - suffix.length) + suffix;
    }
  }
  return host;
};

const createServiceName = (input: string, port: number, seed: number) => {
  const name = sanitizeName(input);
  if (seed) {
    const suffix = ` (${fingerprint(port, seed - 1)})`;
    return name.slice(0, LABEL_LENGTH - suffix.length) + suffix;
  } else {
    return name;
  }
};

export const createServiceRecord = (input: ServiceInput): ServiceRecord => {
  const host = createServiceHost(input.hostname, input.hostnameSeed);
  const name = createServiceName(input.name, input.port, input.nameSeed);
  const domain = `_${sanitizeLabel(input.type)}._${sanitizeLabel(input.protocol)}.local`;
  const fqdnOut = `${name}.${domain}`;
  const txt: string[] = [];
  for (const key in input.txt) {
    const value = input.txt[key];
    if (typeof value === 'string' || typeof value === 'number') {
      txt.push(`${key}=${value}`);
    } else if (typeof value === 'boolean' && value) {
      txt.push(key);
    }
  }
  return {
    domain,
    fqdnOut,
    fqdnIn: fqdnOut.toLowerCase(),
    host: `${host}.local`,
    port: input.port >>> 0,
    subtypes: (input.subtypes || []).reduce((set, subtype) => {
      set[`${sanitizeSubtype(subtype)}._sub.${domain}`] = true;
      return set;
    }, Object.create(null)),
    txt,
    ttl: input.ttl,
  };
};

const srvAnswer = (srv: ServiceRecord, ttl: number): SrvAnswer => ({
  type: RecordType.SRV,
  class: RecordClass.IN,
  name: srv.fqdnOut,
  ttl,
  flush: true,
  data: {
    priority: 0,
    weight: 0,
    port: srv.port,
    target: srv.host,
  },
});

const txtAnswer = (srv: ServiceRecord, ttl: number): TxtAnswer => ({
  type: RecordType.TXT,
  class: RecordClass.IN,
  name: srv.fqdnOut,
  ttl,
  flush: true,
  data: srv.txt,
});

const ptrAnswer = (name: string, data: string, ttl: number): PtrAnswer => ({
  type: RecordType.PTR,
  class: RecordClass.IN,
  name,
  ttl,
  flush: false,
  data,
});

const ptrAnswers = (srv: ServiceRecord, ttl: number): PtrAnswer[] => [
  ptrAnswer(srv.domain, srv.fqdnOut, ttl),
  ptrAnswer(DNSSD_NAME, srv.domain, ttl),
  ...Object.keys(srv.subtypes).map(subtype =>
    ptrAnswer(subtype, srv.fqdnOut, ttl)
  ),
];

const aAnswers = (
  srv: ServiceRecord,
  bindings: NetworkBinding[],
  ttl: number
): AAnswer[] =>
  bindings
    .filter(binding => binding.family === IPType.v4)
    .map(binding => ({
      type: RecordType.A,
      class: RecordClass.IN,
      name: srv.host,
      ttl,
      flush: true,
      data: binding.address,
    }));

const aaaaAnswers = (
  srv: ServiceRecord,
  bindings: NetworkBinding[],
  ttl: number
): AAAAAnswer[] =>
  bindings
    .filter(binding => binding.family === IPType.v6)
    .map(binding => ({
      type: RecordType.AAAA,
      class: RecordClass.IN,
      name: srv.host,
      ttl,
      flush: true,
      data: binding.address,
    }));

const answers = (
  srv: ServiceRecord,
  bindings: NetworkBinding[],
  ttl: number
) => [
  ...ptrAnswers(srv, ttl),
  srvAnswer(srv, ttl),
  txtAnswer(srv, ttl),
  ...aAnswers(srv, bindings, ttl),
  ...aaaaAnswers(srv, bindings, ttl),
];

const authorities = (
  srv: ServiceRecord,
  bindings: NetworkBinding[],
  ttl: number
) => [
  ...aAnswers(srv, bindings, ttl), // 1
  txtAnswer(srv, ttl), // 16
  ...aaaaAnswers(srv, bindings, ttl), // 28
  srvAnswer(srv, ttl), // 33
];

export const announceMessage = (
  srv: ServiceRecord,
  bindings: NetworkBinding[]
) =>
  encode({
    type: PacketType.RESPONSE,
    flags: PacketFlag.AUTHORITATIVE_ANSWER,
    answers: answers(srv, bindings, srv.ttl),
  });

export const goodbyeMessage = (
  srv: ServiceRecord,
  bindings: NetworkBinding[]
) =>
  encode({
    type: PacketType.RESPONSE,
    flags: PacketFlag.AUTHORITATIVE_ANSWER,
    answers: answers(srv, bindings, 0),
  });

export const probeMessage = (srv: ServiceRecord, bindings: NetworkBinding[]) =>
  encode({
    type: PacketType.QUERY,
    questions: [
      {
        name: srv.fqdnOut,
        type: RecordType.ANY,
        class: RecordClass.IN,
        qu: true,
      },
      {
        name: srv.host,
        type: RecordType.ANY,
        class: RecordClass.IN,
        qu: true,
      },
    ],
    authorities: authorities(srv, bindings, srv.ttl),
  });

export const enum ConflictFlag {
  NONE = 0,
  NAME = 1 << 0,

  HOSTNAME_A = 1 << 1,
  HOSTNAME_AAAA = 1 << 2,

  // can't reference itself due to Babel transform-typescript bug
  HOSTNAME = (1 << 1) | (1 << 2),

  LOST_TIEBREAKER = 1 << 3,
}

const checkAnswerConflicts = (
  answers: Answer[],
  srv: ServiceRecord,
  bindings: NetworkBinding[]
): ConflictFlag => {
  let flag = ConflictFlag.NONE;

  const v4Addresses = new Set<string>();
  const v6Addresses = new Set<string>();
  for (const answer of answers) {
    const answerName = answer.name?.toLowerCase();
    if (
      answer.type === RecordType.SRV &&
      answerName === srv.fqdnIn &&
      (answer.data.port !== srv.port ||
        answer.data.target.toLowerCase() !== srv.host)
    ) {
      flag |= ConflictFlag.NAME;
    } else if (answer.type === RecordType.A && answerName === srv.host) {
      v4Addresses.add(answer.data.toLowerCase());
    } else if (answer.type === RecordType.AAAA && answerName === srv.host) {
      v6Addresses.add(answer.data.toLowerCase());
    }
  }

  // Conflicts for A and AAAA records must be checked by looking at all available records instead
  if (v4Addresses.size || v6Addresses.size) {
    let v4AddressCount = 0;
    let v6AddressCount = 0;
    for (const binding of bindings) {
      if (binding.family === IPType.v4) {
        v4AddressCount++;
        if (v4Addresses.size && !v4Addresses.has(binding.address)) {
          flag |= ConflictFlag.HOSTNAME_A;
          break;
        }
      } else if (binding.family === IPType.v6) {
        v6AddressCount++;
        if (v6Addresses.size && !v6Addresses.has(binding.address)) {
          flag |= ConflictFlag.HOSTNAME_AAAA;
          break;
        }
      }
    }
    if (v4Addresses.size && v4AddressCount !== v4Addresses.size)
      flag |= ConflictFlag.HOSTNAME_A;
    if (v6Addresses.size && v6AddressCount !== v6Addresses.size)
      flag |= ConflictFlag.HOSTNAME_AAAA;
  }

  return flag;
};

const isSupportedQuestion = (question: Question): boolean =>
  question.type === RecordType.ANY ||
  question.type === RecordType.A ||
  question.type === RecordType.AAAA ||
  question.type === RecordType.SRV ||
  question.type === RecordType.TXT ||
  question.type === RecordType.PTR;

export const checkResponseConflicts = (
  packet: Packet,
  srv: ServiceRecord,
  bindings: NetworkBinding[]
): ConflictFlag => {
  let flag = ConflictFlag.NONE;
  if (packet.type === PacketType.RESPONSE) {
    if (packet.answers?.length)
      flag |= checkAnswerConflicts(packet.answers, srv, bindings);
    if (packet.additionals?.length)
      flag |= checkAnswerConflicts(packet.additionals, srv, bindings);
  }
  return flag;
};

const compareAuthorities = (a: Answer[], b: Answer[]): number => {
  a.sort(compareAnswers);
  b.sort(compareAnswers);
  const length = a.length < b.length ? a.length : b.length;
  for (let idx = 0; idx < length; idx++) {
    const comparison = compareAnswers(a[idx], b[idx]);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return a.length !== b.length ? (a.length < b.length ? -1 : 1) : 0;
};

export const checkQuestionConflicts = (
  packet: Packet,
  srv: ServiceRecord,
  bindings: NetworkBinding[]
): ConflictFlag => {
  if (
    packet.type !== PacketType.QUERY ||
    !packet.questions?.length ||
    !packet.authorities?.length
  ) {
    return ConflictFlag.NONE;
  }
  const hasMatchingQuestion = packet.questions.some(question => {
    const questionName = question.name.toLowerCase();
    return (
      isSupportedQuestion(question) &&
      (questionName === srv.host || questionName === srv.fqdnIn)
    );
  });
  if (!hasMatchingQuestion) {
    return ConflictFlag.NONE;
  }
  const ourAuthorities = authorities(srv, bindings, srv.ttl);
  const theirAuthorities = packet.authorities.filter(answer => {
    return (
      answer.name?.toLowerCase() === srv.host ||
      answer.name?.toLowerCase() === srv.fqdnIn
    );
  });
  const comparison = compareAuthorities(ourAuthorities, theirAuthorities);
  if (comparison < 0) {
    return checkAnswerConflicts(packet.authorities, srv, bindings);
  } else {
    return ConflictFlag.NONE;
  }
};

export const responseMessage = (
  packet: Packet,
  srv: ServiceRecord,
  bindings: NetworkBinding[],
  unicast: boolean
) => {
  if (packet.type !== PacketType.QUERY || !packet.questions?.length) {
    return null;
  }

  const ptr: Record<string, true | undefined> = Object.create(null);

  let hasSRV = false;
  let hasTXT = false;
  let hasA = false;
  let hasAAAA = false;

  if (packet.answers) {
    for (const answer of packet.answers) {
      const answerName = answer.name?.toLowerCase();
      switch (answer.type) {
        case RecordType.SRV:
          hasSRV ||= answerName === srv.fqdnIn;
          break;
        case RecordType.TXT:
          hasTXT ||= answerName === srv.fqdnIn;
          break;
        case RecordType.A:
          hasA ||= answerName === srv.host;
          break;
        case RecordType.AAAA:
          hasAAAA ||= answerName === srv.host;
          break;
        case RecordType.PTR: {
          switch (answerName) {
            case srv.domain:
              if (answer.data.toLowerCase() === srv.fqdnIn)
                ptr[srv.domain] = true;
              break;
            case DNSSD_NAME:
              if (answer.data.toLowerCase() === srv.domain)
                ptr[DNSSD_NAME] = true;
              break;
            default:
              if (
                answerName &&
                srv.subtypes[answerName] &&
                answer.data.toLowerCase() === srv.fqdnIn
              ) {
                ptr[answerName] = true;
              }
          }
          break;
        }
      }
    }
  }

  const answers: Answer[] = [];
  const additionals: Answer[] = [];
  for (const question of packet.questions) {
    if (!!question.qu !== unicast) {
      continue;
    }
    const questionName = question.name.toLowerCase();
    switch (question.type) {
      case RecordType.SRV:
        if (!hasSRV && questionName === srv.fqdnIn) {
          answers.push(srvAnswer(srv, srv.ttl));
          hasSRV = true;
        }
        break;
      case RecordType.TXT:
        if (!hasTXT && questionName === srv.fqdnIn) {
          answers.push(txtAnswer(srv, srv.ttl));
          hasTXT = true;
        }
        break;
      case RecordType.A:
        if (!hasA && questionName === srv.host) {
          answers.push(...aAnswers(srv, bindings, srv.ttl));
          hasA = true;
        }
        break;
      case RecordType.AAAA:
        if (!hasAAAA && questionName === srv.host) {
          answers.push(...aaaaAnswers(srv, bindings, srv.ttl));
          hasAAAA = true;
        }
        break;
      case RecordType.PTR: {
        switch (questionName) {
          case srv.domain:
            if (!ptr[srv.domain]) {
              answers.push(ptrAnswer(srv.domain, srv.fqdnOut, srv.ttl));
              ptr[srv.domain] = true;
            }
            break;
          case DNSSD_NAME:
            if (!ptr[DNSSD_NAME]) {
              answers.push(ptrAnswer(DNSSD_NAME, srv.domain, srv.ttl));
              ptr[DNSSD_NAME] = true;
            }
            break;
          default:
            if (srv.subtypes[questionName]) {
              answers.push(ptrAnswer(questionName, srv.fqdnOut, srv.ttl));
              ptr[questionName] = true;
            }
        }
        break;
      }
      case RecordType.ANY: {
        switch (questionName) {
          case srv.fqdnIn:
            if (!hasSRV) {
              answers.push(srvAnswer(srv, srv.ttl));
              hasSRV = true;
            }
            if (!hasTXT) {
              answers.push(txtAnswer(srv, srv.ttl));
              hasTXT = true;
            }
            break;
          case srv.host:
            if (!hasA) {
              answers.push(...aAnswers(srv, bindings, srv.ttl));
              hasA = true;
            }
            if (!hasAAAA) {
              answers.push(...aaaaAnswers(srv, bindings, srv.ttl));
              hasAAAA = true;
            }
            break;
          case srv.domain:
            if (!ptr[srv.domain]) {
              answers.push(ptrAnswer(srv.domain, srv.fqdnOut, srv.ttl));
              ptr[srv.domain] = true;
            }
            break;
          case DNSSD_NAME:
            if (!ptr[DNSSD_NAME]) {
              answers.push(ptrAnswer(DNSSD_NAME, srv.domain, srv.ttl));
              ptr[DNSSD_NAME] = true;
            }
            break;
          default:
            if (srv.subtypes[questionName]) {
              answers.push(ptrAnswer(questionName, srv.fqdnOut, srv.ttl));
              ptr[questionName] = true;
            }
        }
      }
    }
  }

  if (ptr[srv.domain] && !hasSRV) {
    additionals.push(srvAnswer(srv, srv.ttl));
    hasSRV = true;
  }
  if (ptr[srv.domain] && !hasTXT) {
    additionals.push(txtAnswer(srv, srv.ttl));
    hasTXT = true;
  }
  if (hasSRV && !hasA) {
    additionals.push(...aAnswers(srv, bindings, srv.ttl));
    hasA = true;
  }
  if (hasSRV && !hasAAAA) {
    additionals.push(...aaaaAnswers(srv, bindings, srv.ttl));
    hasAAAA = true;
  }

  if (answers.length > 0) {
    return encode({
      type: PacketType.RESPONSE,
      flags: PacketFlag.AUTHORITATIVE_ANSWER,
      answers,
      additionals,
    });
  } else {
    return null;
  }
};
