// The mail provider before there is one (phase 5.2 replaces it with OpenSRS's): placeholder records, clearly not real,
// so the admin page has something to show and nothing is ever written to a live zone from them.
import type { ProviderRecords } from '../dns';

export const noneProvider: ProviderRecords = {
  mx: [{ host: 'mx.example.invalid', priority: 10 }],
  spfInclude: 'spf.example.invalid',
  dmarcPolicy: 'v=DMARC1; p=none',
  placeholder: true,
};
