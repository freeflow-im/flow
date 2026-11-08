// The mail provider's records while none is configured (MAIL_PROVIDER unset, mailprovider/index.ts): placeholder records, clearly not real,
// so the admin page has something to show and nothing is ever written to a live zone from them.
import type { ProviderRecords } from '../dns';

export const noneProvider: ProviderRecords = {
  mx: [{ host: 'mx.example.invalid', priority: 10 }],
  spfInclude: 'spf.example.invalid',
  dmarcPolicy: 'v=DMARC1; p=none',
  placeholder: true,
};
