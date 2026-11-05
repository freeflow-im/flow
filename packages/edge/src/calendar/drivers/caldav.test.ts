import { describe, expect, it } from 'vitest';
import { ApiError } from '../../errors';
import { CalDav, parseScheduleResponse } from './caldav';

/** A fake CalDAV server: answers by method and path from a table, records every request. */
function fakeServer(routes: Record<string, (req: { method: string; url: URL; body: string; headers: Headers }) => Response | Promise<Response>>) {
  const seen: { method: string; path: string; headers: Headers; body: string }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = new Headers(init?.headers);
    seen.push({ method, path: url.pathname, headers, body });
    const route = routes[`${method} ${url.host}${url.pathname}`] ?? routes[`${method} ${url.pathname}`];
    if (!route) return new Response('not found', { status: 404 });
    return route({ method, url, body, headers });
  }) as typeof fetch;
  return { fetchFn, seen };
}
const xml = (body: string, status = 207) => new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ic="http://apple.com/ns/ical/">${body}</d:multistatus>`, { status, headers: { 'content-type': 'application/xml; charset=utf-8' } });
const ok = (props: string) => `<d:propstat><d:prop>${props}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
const response = (href: string, props: string) => `<d:response><d:href>${href}</d:href>${ok(props)}</d:response>`;
const EVENT = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\nSUMMARY:Hi\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const client = (fetchFn: typeof fetch, url = 'https://dav.example.com/') => new CalDav({ url, credential: { kind: 'basic', username: 'ann', password: 'pw' }, allowInsecure: false, fetch: fetchFn });
const codeOf = async (p: Promise<unknown>) => p.then(() => 'none', (e) => (e instanceof ApiError ? e.code : String(e)));

describe('the CalDAV driver, against a fake server', () => {
  const principal = () => xml(response('/', '<d:current-user-principal><d:href>/principals/ann/</d:href></d:current-user-principal>'));
  const discovery = {
    'PROPFIND /.well-known/caldav': () => new Response(null, { status: 301, headers: { location: '/dav/' } }),
    'PROPFIND /dav/': principal,
    'PROPFIND /principals/ann/': ({ body }: { body: string }) => body.includes('calendar-home-set')
      ? xml(response('/principals/ann/', '<c:calendar-home-set><d:href>https://p01.dav.example.com/ann/calendars/</d:href></c:calendar-home-set>'))
      : body.includes('calendar-user-address-set')
        ? xml(response('/principals/ann/', '<c:calendar-user-address-set><d:href>mailto:Ann@Example.com</d:href><d:href>/principals/ann/</d:href></c:calendar-user-address-set>'))
        : xml(response('/principals/ann/', '<c:schedule-outbox-URL><d:href>/ann/outbox/</d:href></c:schedule-outbox-URL>')),
  };

  it('discovers the principal, the home on another host, the addresses and the outbox, sending the login each time', async () => {
    const { fetchFn, seen } = fakeServer(discovery);
    const d = await client(fetchFn).discover();
    expect(d).toEqual({ principal: 'https://dav.example.com/principals/ann/', home: 'https://p01.dav.example.com/ann/calendars/', addresses: ['ann@example.com'], outbox: 'https://dav.example.com/ann/outbox/' });
    expect(seen.every((r) => r.headers.get('authorization') === `Basic ${Buffer.from('ann:pw').toString('base64')}`)).toBe(true);
  });

  it('takes a refused login as auth_failed, an unreachable server as connect_failed, and refuses a private host', async () => {
    const refused = fakeServer({ 'PROPFIND /.well-known/caldav': () => new Response(null, { status: 401 }), 'PROPFIND /': () => new Response(null, { status: 401 }) });
    expect(await codeOf(client(refused.fetchFn).discover())).toBe('auth_failed');
    const down = (async () => { throw new TypeError('connection refused'); }) as typeof fetch;
    expect(await codeOf(client(down).discover())).toBe('connect_failed');
    const { fetchFn } = fakeServer({ 'PROPFIND /.well-known/caldav': () => new Response(null, { status: 301, headers: { location: 'http://127.0.0.1:8080/' } }) });
    // The redirect to a local address is never followed; discovery then finds nothing at the address typed.
    expect(await codeOf(client(fetchFn).discover())).toMatch(/bad_request|connect_failed/);
    expect(await codeOf(client(fetchFn, 'https://10.0.0.5/').discover())).toBe('bad_request');
  });

  it('lists the calendars of the home: VEVENT ones, colour, zone, read-only, and whether sync-collection is there', async () => {
    const home = 'https://dav.example.com/ann/';
    const { fetchFn } = fakeServer({
      'PROPFIND /ann/': () => xml(
        response('/ann/', '<d:resourcetype><d:collection/></d:resourcetype>')
        + response('/ann/work/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Work</d:displayname><ic:calendar-color>#FF2968FF</ic:calendar-color><cs:getctag>c1</cs:getctag><d:sync-token>t1</d:sync-token><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><c:calendar-timezone>BEGIN:VCALENDAR&#13;\nBEGIN:VTIMEZONE&#13;\nTZID:Europe/Paris&#13;\nEND:VTIMEZONE&#13;\nEND:VCALENDAR</c:calendar-timezone><d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>')
        + response('/ann/holidays/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Holidays</d:displayname><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set><d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>')
        + response('/ann/tasks/', '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>Reminders</d:displayname><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set>')),
      'PROPFIND /ann/work/': () => xml(response('/ann/work/', '<d:supported-report-set><d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report><d:supported-report><d:report><c:calendar-multiget/></d:report></d:supported-report></d:supported-report-set>')),
      'PROPFIND /ann/holidays/': () => xml(response('/ann/holidays/', '<d:supported-report-set></d:supported-report-set>')),
    });
    const cals = await client(fetchFn).calendars(home);
    expect(cals).toEqual([
      { href: 'https://dav.example.com/ann/work/', name: 'Work', color: '#ff2968', timezone: 'Europe/Paris', role: 'owner', supportsSync: true, ctag: 'c1' },
      { href: 'https://dav.example.com/ann/holidays/', name: 'Holidays', color: null, timezone: null, role: 'reader', supportsSync: false, ctag: null },
    ]);
  });

  it('reads a sync-collection delta (changed with etags, deleted by 404), and a token the server forgot as null', async () => {
    const cal = 'https://dav.example.com/ann/work/';
    let forgot = false;
    const { fetchFn, seen } = fakeServer({
      'REPORT /ann/work/': ({ body }) => {
        if (forgot) return new Response('<d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>', { status: 403, headers: { 'content-type': 'application/xml' } });
        if (body.includes('sync-collection')) return xml(response('/ann/work/e1.ics', '<d:getetag>"2"</d:getetag>') + '<d:response><d:href>/ann/work/gone.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response><d:sync-token>t2</d:sync-token>');
        return xml(response('/ann/work/e1.ics', `<d:getetag>"2"</d:getetag><c:calendar-data>${EVENT}</c:calendar-data>`));
      },
    });
    const d = client(fetchFn);
    expect(await d.changes(cal, 't1')).toEqual({ changed: [{ href: 'https://dav.example.com/ann/work/e1.ics', etag: '"2"' }], deleted: ['https://dav.example.com/ann/work/gone.ics'], token: 't2' });
    expect(seen.at(-1)!.body).toContain('t1');
    const got = await d.get(cal, ['https://dav.example.com/ann/work/e1.ics']);
    expect(got).toEqual([{ href: 'https://dav.example.com/ann/work/e1.ics', etag: '"2"', data: expect.stringContaining('UID:e1') }]);
    expect(seen.at(-1)!.body).toContain('calendar-multiget');
    forgot = true;
    expect(await d.changes(cal, 'old')).toBeNull();
  });

  it('lists the etags of the VEVENTs (the ctag fallback), without the collection itself', async () => {
    const { fetchFn, seen } = fakeServer({ 'REPORT /ann/work/': () => xml(response('/ann/work/', '<d:getetag>"c"</d:getetag>') + response('/ann/work/a.ics', '<d:getetag>"1"</d:getetag>') + response('/ann/work/b%20c.ics', '<d:getetag>"2"</d:getetag>')) });
    expect(await client(fetchFn).etags('https://dav.example.com/ann/work/')).toEqual([{ href: 'https://dav.example.com/ann/work/a.ics', etag: '"1"' }, { href: 'https://dav.example.com/ann/work/b%20c.ics', etag: '"2"' }]);
    expect(seen[0].body).toMatch(/comp-filter name="VEVENT"/);
  });

  it('creates with If-None-Match, replaces with If-Match, and takes a 412 as conflict', async () => {
    let etag = '"1"';
    const { fetchFn, seen } = fakeServer({
      'PUT /ann/work/e1.ics': ({ headers }) => {
        if (headers.get('if-match') && headers.get('if-match') !== etag) return new Response(null, { status: 412 });
        etag = `"${Number(etag.slice(1, -1)) + 1}"`;
        return new Response(null, { status: headers.get('if-none-match') ? 201 : 204, headers: { etag } });
      },
      'DELETE /ann/work/e1.ics': ({ headers }) => new Response(null, { status: headers.get('if-match') === etag ? 204 : 412 }),
      'DELETE /ann/work/gone.ics': () => new Response(null, { status: 404 }),
    });
    const d = client(fetchFn);
    const href = 'https://dav.example.com/ann/work/e1.ics';
    expect(await d.put(href, EVENT, null)).toEqual({ etag: '"2"' });
    expect(seen[0].headers.get('if-none-match')).toBe('*');
    expect(seen[0].headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(await d.put(href, EVENT, '"2"')).toEqual({ etag: '"3"' });
    expect(await codeOf(d.put(href, EVENT, '"2"'))).toBe('conflict');
    expect(await codeOf(d.delete(href, '"2"'))).toBe('conflict');
    expect(await codeOf(d.delete(href, '"3"'))).toBe('none');
    expect(await codeOf(d.delete('https://dav.example.com/ann/work/gone.ics', '"1"'))).toBe('none');
  });

  it('reads other people\'s busy times from a schedule-response', () => {
    const reply = `<?xml version="1.0"?><C:schedule-response xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><C:response><C:recipient><D:href>mailto:bo@example.com</D:href></C:recipient><C:request-status>2.0;Success</C:request-status><C:calendar-data>BEGIN:VCALENDAR&#13;
BEGIN:VFREEBUSY&#13;
FREEBUSY;FBTYPE=BUSY:20261105T150000Z/20261105T160000Z,20261105T170000Z/PT30M&#13;
FREEBUSY;FBTYPE=FREE:20261105T180000Z/20261105T190000Z&#13;
END:VFREEBUSY&#13;
END:VCALENDAR</C:calendar-data></C:response><C:response><C:recipient><D:href>mailto:cy@example.com</D:href></C:recipient><C:request-status>3.7;Invalid calendar user</C:request-status></C:response></C:schedule-response>`;
    expect(parseScheduleResponse(reply)).toEqual(new Map([['bo@example.com', [['2026-11-05T15:00:00.000Z', '2026-11-05T16:00:00.000Z'], ['2026-11-05T17:00:00.000Z', '2026-11-05T17:30:00.000Z']]]]));
  });

  it('takes the address as the principal when the server names none for it (Google answers 207 with an empty prop)', async () => {
    const { fetchFn } = fakeServer({
      'PROPFIND apidata.example.com/caldav/v2/ann%40gmail.com/user': ({ body }) => body.includes('calendar-home-set')
        ? xml(response('/caldav/v2/ann%40gmail.com/user', '<c:calendar-home-set><d:href>/caldav/v2/ann%40gmail.com/</d:href></c:calendar-home-set>'))
        : body.includes('calendar-user-address-set')
          ? xml(response('/caldav/v2/ann%40gmail.com/user', '<c:calendar-user-address-set><d:href>mailto:ann@gmail.com</d:href></c:calendar-user-address-set>'))
          : xml(`<d:response><d:href>/caldav/v2/ann%40gmail.com/user</d:href><d:propstat><d:prop><d:current-user-principal/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`),
    });
    const d = new CalDav({ url: 'https://apidata.example.com/caldav/v2/ann%40gmail.com/user', allowInsecure: false, fetch: fetchFn, credential: { kind: 'bearer', token: async () => 'tok', refresh: async () => 'tok' } });
    expect(await d.discover()).toEqual({ principal: 'https://apidata.example.com/caldav/v2/ann%40gmail.com/user', home: 'https://apidata.example.com/caldav/v2/ann%40gmail.com/', addresses: ['ann@gmail.com'], outbox: null });
  });

  it('signs in with an access token (Google), refreshing it once on a 401, and finds the principal without .well-known', async () => {
    let valid = 'tok-2', refreshes = 0;
    const { fetchFn, seen } = fakeServer({
      'PROPFIND apidata.example.com/caldav/v2/ann%40gmail.com/user': ({ headers, body }) => {
        if (headers.get('authorization') !== `Bearer ${valid}`) return new Response(null, { status: 401 });
        return body.includes('calendar-home-set')
          ? xml(response('/caldav/v2/ann%40gmail.com/user', '<c:calendar-home-set><d:href>/caldav/v2/ann%40gmail.com/</d:href></c:calendar-home-set>'))
          : body.includes('calendar-user-address-set')
            ? xml(response('/caldav/v2/ann%40gmail.com/user', '<c:calendar-user-address-set><d:href>mailto:ann@gmail.com</d:href></c:calendar-user-address-set>'))
            : xml(response('/caldav/v2/ann%40gmail.com/user', '<d:current-user-principal><d:href>/caldav/v2/ann%40gmail.com/user</d:href></d:current-user-principal>'));
      },
    });
    let current = 'tok-1';
    const d = new CalDav({
      url: 'https://apidata.example.com/caldav/v2/ann%40gmail.com/user', allowInsecure: false, fetch: fetchFn,
      credential: { kind: 'bearer', token: async () => current, refresh: async () => { refreshes++; current = 'tok-2'; return current; } },
    });
    expect(await d.discover()).toEqual({ principal: 'https://apidata.example.com/caldav/v2/ann%40gmail.com/user', home: 'https://apidata.example.com/caldav/v2/ann%40gmail.com/', addresses: ['ann@gmail.com'], outbox: null });
    expect(refreshes).toBe(1);
    expect(seen.some((r) => r.path.includes('.well-known'))).toBe(false);
    // A token Google keeps refusing after the refresh: auth_failed, and only one refresh per request.
    valid = 'never';
    refreshes = 0;
    expect(await codeOf(d.discover())).toBe('auth_failed');
    expect(refreshes).toBe(1);
    // A refused refresh is the account's auth_failed too.
    const refused = new CalDav({ url: 'https://apidata.example.com/caldav/v2/ann%40gmail.com/user', allowInsecure: false, fetch: fetchFn,
      credential: { kind: 'bearer', token: async () => 'old', refresh: async () => { throw new ApiError(422, 'auth_failed', 'reconnect'); } } });
    expect(await codeOf(refused.discover())).toBe('auth_failed');
  });

  it('leaves out an event the multiget says is not there, and fails only when the whole request does', async () => {
    const cal = 'https://dav.example.com/andrea/events/';
    let down = false;
    const { fetchFn, seen } = fakeServer({
      'REPORT /andrea/events/': ({ body }) => {
        if (down) return new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } });
        if (body.includes('calendar-query')) return xml(response('/andrea/events/a%40google.com.ics', '<d:getetag>"1"</d:getetag>') + response('/andrea/events/b.ics', '<d:getetag>"2"</d:getetag>'));
        // As Google: the second event, listed above, is 404 when asked for.
        return xml(response('/andrea/events/a%40google.com.ics', `<d:getetag>"1"</d:getetag><c:calendar-data>${EVENT}</c:calendar-data>`) + '<d:response><d:href>/andrea/events/b.ics</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>');
      },
    });
    const d = client(fetchFn);
    const etags = await d.etags(cal);
    expect(etags.map((e) => e.href)).toEqual(['https://dav.example.com/andrea/events/a%40google.com.ics', 'https://dav.example.com/andrea/events/b.ics']);
    const got = await d.get(cal, etags.map((e) => e.href));
    expect(got.map((o) => o.href)).toEqual(['https://dav.example.com/andrea/events/a%40google.com.ics']);
    // The href goes as the server gave it: %40 stays %40.
    expect(seen.at(-1)!.body).toContain('<d:href>/andrea/events/a%40google.com.ics</d:href>');
    down = true;
    expect(await codeOf(d.etags(cal))).toBe('connect_failed');
    expect(await codeOf(d.get(cal, ['https://dav.example.com/andrea/events/b.ics']))).toBe('connect_failed');
  });

  it('tells the person\'s own calendars (owner) from those shared with them (writer) and read-only ones (reader)', async () => {
    const write = '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>';
    const cal = (path: string, name: string, owner: string, privileges: string) => response(path, `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><d:displayname>${name}</d:displayname><d:owner><d:href>${owner}</d:href></d:owner><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>${privileges}`);
    const { fetchFn } = fakeServer({
      'PROPFIND /caldav/v2/scott/': () => xml(cal('/caldav/v2/scott/events/', 'Scott', '/caldav/v2/scott/user', write) + cal('/caldav/v2/andrea/events/', 'Andrea', '/caldav/v2/andrea/user', write)
        + cal('/caldav/v2/holidays/events/', 'Holidays', '/caldav/v2/holidays/user', '<d:current-user-privilege-set><d:privilege><d:read/></d:privilege></d:current-user-privilege-set>')),
    });
    const cals = await client(fetchFn).calendars('https://dav.example.com/caldav/v2/scott/', 'https://dav.example.com/caldav/v2/scott/user');
    expect(cals.map((c) => [c.name, c.role])).toEqual([['Scott', 'owner'], ['Andrea', 'writer'], ['Holidays', 'reader']]);
  });
});

