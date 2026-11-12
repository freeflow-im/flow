// End-to-end check of FreeFlow Calendar (/v1/calendar/*, src/calendar/object.ts) through the Worker and a person's Calendar
// object, against Radicale in Docker (`flow-radicale` on 127.0.0.1:5232; its image's own config has `[auth] type = none`, so
// any username and password log in, and a user's calendars live under /<username>/):
//   docker run -d --name flow-radicale -p 5232:5232 tomsquest/docker-radicale
// and a local `wrangler dev` started as test/e2e.mjs says (its .dev.vars), on port 18799 (B= for another), with the
// calendar's insecure dev mode on (http and local hosts):
//   npx wrangler dev --port 18799 --local --enable-containers=false --var PORTED_HOSTS:edge.freeflow.im,localhost \
//     --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18799 \
//     --var CALENDAR_ALLOW_INSECURE:1 > /tmp/edge-calendar.log 2>&1 &
//   node test/e2e-calendar.mjs /tmp/edge-calendar.log
// Restart wrangler after editing the server: its hot reload has served a stale bundle. It reads signup links from the
// Worker's log (local mail goes there), and checks the timing lines there too. Google Calendar is not covered here (no
// Google in Docker) beyond its routes' refusals; its flow is unit-tested and verified by hand (docs/specs/calendar.md §12). The calendars are made, and some events put,
// straight into Radicale (MKCALENDAR and PUT from here), as another calendar app would. The last part waits for the
// object's own alarm (every 60 s while the person is active) to pick up an event put straight into Radicale: about a minute.
import fs from 'node:fs';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18799';
const DAV=process.env.DAV??'http://127.0.0.1:5232';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,200):''));};
const api=async(tok,m,p,b,h={})=>{const r=await fetch(B+p,{method:m,headers:{...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':'application/json'}:{}),...h},body:b===undefined?undefined:JSON.stringify(b)});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const USER=`ann-${tag}`, EMAIL=`${USER}@test.local`;
const dav=(m,path,body,h={})=>fetch(DAV+path,{method:m,headers:{authorization:'Basic '+Buffer.from(USER+':x').toString('base64'),...h},body});
const ics=(...lines)=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//e2e//EN',...lines,'END:VCALENDAR',''].join('\r\n');
const enc=encodeURIComponent;

const A=await signup(`cal-${tag}@example.com`,'Ann'),Bo=await signup(`cal-other-${tag}@example.com`,'Bo');
t('sign up',A.token&&Bo.token);
// Calendars are an account's (platform.md §3.6): each person gets an organization, and someone in none is refused.
const org=async(u,n)=>(await api(u.token,'POST','/v1/workspaces',{name:`${n} ${tag}`,slug:`${n.toLowerCase()}-${tag}`})).j?.id;
const ORGA=await org(A,'Calann');
t('each with an organization',!!ORGA&&!!(await org(Bo,'Calbo')));
{const Cy=await signup(`cal-none-${tag}@example.com`,'Cy');const x=await api(Cy.token,'GET','/v1/calendar/accounts');t('someone in no organization is refused, no_account',x.s===403&&x.j.error?.code==='no_account',x.s+' '+JSON.stringify(x.j));}

let r=await api(null,'GET','/v1/calendar/accounts');t('no session refused',r.s===401,r.s);
r=await api(A.token,'GET','/v1/calendar/providers?email=someone@icloud.com');t('an iCloud preset',r.s===200&&r.j?.name==='iCloud'&&r.j.url==='https://caldav.icloud.com/'&&r.j.username==='someone@icloud.com'&&!!r.j.appPasswordUrl,JSON.stringify(r.j));
r=await api(A.token,'GET','/v1/calendar/providers?email=someone@gmail.com');t('Google: sign in with Google',r.j?.google===true&&/signing in with Google/.test(r.j.note),JSON.stringify(r.j));
// Google itself cannot be in the e2e (no Google in Docker): its consent and token exchange are unit-tested (google.test.ts).
// What can be checked here: the start needs a session, and a callback with a forged state goes back with ?error=expired.
r=await api(null,'GET','/v1/calendar/google/start');t('Google: the start needs a session',r.s===401,r.s);
r=await api(A.token,'GET','/v1/calendar/google/start');t('Google: the start answers a consent URL, or google_disabled with no client secret',(r.s===200&&r.j.url?.startsWith('https://accounts.google.com/'))||(r.s===503&&r.j.error?.code==='google_disabled'),r.s+' '+String(r.j.url??JSON.stringify(r.j)).slice(0,60));
let cb=await fetch(B+'/v1/calendar/google/callback?code=x&state=forged',{redirect:'manual'});t('Google: a forged state goes back with ?error=expired',cb.status===302&&/[?&]error=expired/.test(cb.headers.get('location')??''),cb.status+' '+cb.headers.get('location'));
r=await api(A.token,'GET','/v1/calendar/providers?email=me@example.com');t('no preset for an unknown domain',r.s===200&&r.j===null,JSON.stringify(r.j));
// Everyone has a native calendar (phase 4.1): its account has no server; nothing is connected yet.
const isNative=c=>/^n\./.test(c.id);
r=await api(A.token,'GET','/v1/calendar/accounts');t('no connected accounts yet, one native one',r.s===200&&r.j.accounts?.length===1&&r.j.accounts[0].kind==='native'&&!r.j.accounts[0].server,JSON.stringify(r.j));
const ANN_ADDR=r.j.accounts?.[0]?.email;
r=await api(A.token,'GET','/v1/calendar/calendars');const NATIVE=r.j.calendars?.[0];
t('a native default calendar, nothing else yet',r.j.calendars?.length===1&&isNative(NATIVE)&&NATIVE.isDefault&&NATIVE.name==='Calendar'&&NATIVE.role==='owner'&&!!NATIVE.syncedAt,JSON.stringify(r.j));

// ---- Radicale, as another app left it: two calendars, a weekly series in New York time with an EXDATE and a moved
// occurrence (Ann invited, not answered yet), and an all-day event.
const WORK=`/${USER}/work-${tag}/`, HOME=`/${USER}/home-${tag}/`;
const mk=(name,color)=>`<?xml version="1.0" encoding="utf-8"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:I="http://apple.com/ns/ical/"><D:set><D:prop><D:displayname>${name}</D:displayname><I:calendar-color>${color}</I:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
let res=await dav('MKCALENDAR',WORK,mk('Work','#FF9500FF'),{'content-type':'application/xml'});t('Radicale: make the Work calendar',res.status===201,res.status);
res=await dav('MKCALENDAR',HOME,mk('Home','#34C759FF'),{'content-type':'application/xml'});t('Radicale: make the Home calendar',res.status===201,res.status);
const NY=['BEGIN:VTIMEZONE','TZID:America/New_York','BEGIN:DAYLIGHT','TZOFFSETFROM:-0500','TZOFFSETTO:-0400','DTSTART:20070311T020000','RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU','END:DAYLIGHT','BEGIN:STANDARD','TZOFFSETFROM:-0400','TZOFFSETTO:-0500','DTSTART:20071104T020000','RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU','END:STANDARD','END:VTIMEZONE'];
const SERIES=`standup-${tag}`;
const series=ics(...NY,'BEGIN:VEVENT',`UID:${SERIES}`,'DTSTAMP:20261001T120000Z','DTSTART;TZID=America/New_York:20261019T100000','DTEND;TZID=America/New_York:20261019T103000','RRULE:FREQ=WEEKLY;BYDAY=MO,WE',
  'EXDATE;TZID=America/New_York:20261026T100000','SUMMARY:Standup','ORGANIZER;CN=Bo:mailto:bo@test.local',`ATTENDEE;CN=Ann;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${EMAIL}`,'ATTENDEE;CN=Bo;PARTSTAT=ACCEPTED:mailto:bo@test.local','END:VEVENT',
  'BEGIN:VEVENT',`UID:${SERIES}`,'DTSTAMP:20261001T120000Z','RECURRENCE-ID;TZID=America/New_York:20261028T100000','DTSTART;TZID=America/New_York:20261028T140000','DTEND;TZID=America/New_York:20261028T143000','SUMMARY:Standup (moved)','ORGANIZER;CN=Bo:mailto:bo@test.local',`ATTENDEE;CN=Ann;PARTSTAT=NEEDS-ACTION:mailto:${EMAIL}`,'END:VEVENT');
res=await dav('PUT',`${WORK}${SERIES}.ics`,series,{'content-type':'text/calendar'});t('Radicale: put the weekly series',res.status===201,res.status);
const HOLIDAY=`holiday-${tag}`;
res=await dav('PUT',`${HOME}${HOLIDAY}.ics`,ics('BEGIN:VEVENT',`UID:${HOLIDAY}`,'DTSTAMP:20261001T120000Z','DTSTART;VALUE=DATE:20261102','DTEND;VALUE=DATE:20261104','SUMMARY:Long weekend','END:VEVENT'),{'content-type':'text/calendar'});
t('Radicale: put an all-day event',res.status===201,res.status);

// ---- connect
r=await api(A.token,'POST','/v1/calendar/accounts',{email:EMAIL,password:'x',server:{url:'http://127.0.0.1:5999/'}});
t('a server that is not there is connect_failed, 422',r.s===422&&r.j.error?.code==='connect_failed',r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'POST','/v1/calendar/accounts',{email:'me@example.com',password:'x'});
t('an address with no preset needs a server URL',r.s===400&&/server\.url/.test(r.j.error?.message),r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'POST','/v1/calendar/accounts',{email:'not-an-address',password:'x',server:{url:DAV}});t('a bad body is bad_request',r.s===400&&r.j.error?.code==='bad_request',r.s);
r=await api(A.token,'POST','/v1/calendar/accounts',{email:EMAIL,displayName:'Ann',password:'s3cret-pw',server:{url:DAV+'/',username:USER}});
t('connect Radicale (discovery)',r.s===201&&r.j.account?.id&&r.j.account.status==='ok'&&r.j.account.kind==='caldav',r.s+' '+JSON.stringify(r.j).slice(0,200));
const ACC=r.j.account?.id;
t('the password is never returned',!JSON.stringify(r.j).includes('s3cret-pw'));
r=await api(A.token,'GET','/v1/calendar/calendars');
const cals=r.j.calendars??[];const work=cals.find(c=>c.name==='Work'),home=cals.find(c=>c.name==='Home');
t('list calendars, with their names and colours',r.s===200&&work&&home&&work.color==='#ff9500'&&home.color==='#34c759'&&work.accountId===ACC&&work.role==='owner',JSON.stringify(cals).slice(0,200));
t('one default calendar',cals.filter(c=>c.isDefault).length===1,JSON.stringify(cals.map(c=>[c.name,c.isDefault])));
t('synced on connecting',cals.every(c=>c.syncedAt),JSON.stringify(cals.map(c=>c.syncedAt)));
r=await api(A.token,'GET','/v1/calendar/accounts');t('list accounts',r.j.accounts?.length===2&&r.j.accounts.find(a=>a.kind==='caldav')?.server?.url===DAV+'/'&&!JSON.stringify(r.j).includes('s3cret-pw'),JSON.stringify(r.j).slice(0,200));
r=await api(Bo.token,'GET','/v1/calendar/calendars');t("someone else sees none of it (only their own native one)",r.j.calendars?.length===1&&isNative(r.j.calendars[0])&&r.j.calendars[0].id!==NATIVE.id);
r=await api(Bo.token,'GET',`/v1/calendar/events/${enc(work.id+':'+SERIES)}`);t("nor opens an event",r.s===404,r.s);

// ---- a calendar added elsewhere after connecting: Refresh calendars lists it (the alarm does every 15 minutes)
const LATER=`/${USER}/later-${tag}/`;
res=await dav('MKCALENDAR',LATER,mk('Later','#AF52DEFF'),{'content-type':'application/xml'});
r=await api(A.token,'POST',`/v1/calendar/accounts/${ACC}/refresh`);
t('refresh calendars: one made since connecting is listed, and synced',r.s===200&&r.j.added===1&&r.j.calendars?.some(c=>c.name==='Later'&&c.syncedAt&&c.role==='owner'),r.s+' '+JSON.stringify(r.j).slice(0,160));
await dav('DELETE',LATER);
r=await api(A.token,'POST',`/v1/calendar/accounts/${ACC}/refresh`);
t('refresh calendars: one deleted on the server is forgotten',r.j.removed===1&&!r.j.calendars?.some(c=>c.name==='Later'),JSON.stringify(r.j).slice(0,160));
r=await api(Bo.token,'POST',`/v1/calendar/accounts/${ACC}/refresh`);t("refresh calendars: nobody else's account",r.s===404,r.s);

// ---- a window
const W='from=2026-10-19T00:00:00Z&to=2026-11-07T00:00:00Z';
r=await api(A.token,'GET',`/v1/calendar/events?${W}`);
const ev=r.j.events??[];
const standup=ev.filter(e=>e.eventId===`${work.id}:${SERIES}`);
t('the series, expanded in its own zone across the change from daylight time',JSON.stringify(standup.map(e=>e.start))===JSON.stringify(['2026-10-19T14:00:00.000Z','2026-10-21T14:00:00.000Z','2026-10-28T18:00:00.000Z','2026-11-02T15:00:00.000Z','2026-11-04T15:00:00.000Z']),JSON.stringify(standup.map(e=>e.start)));
t('less its EXDATE, with the moved occurrence as its exception',!standup.some(e=>e.start.startsWith('2026-10-26'))&&standup.find(e=>e.recurrenceId==='20261028T140000Z')?.summary==='Standup (moved)',JSON.stringify(standup.map(e=>[e.recurrenceId,e.summary])));
const occ=standup.find(e=>e.recurrenceId==='20261102T150000Z');
t('an occurrence: its id, the series, attendees, my response',occ&&occ.id===`${work.id}:${SERIES}:20261102T150000Z`&&occ.recurring&&occ.timezone==='America/New_York'&&occ.myResponse==='needs-action'&&occ.attendees?.find(a=>a.self)?.email===EMAIL&&occ.organizer?.email==='bo@test.local'&&occ.etag,JSON.stringify(occ).slice(0,200));
const day=ev.find(e=>e.eventId===`${home.id}:${HOLIDAY}`);
t('the all-day event, as dates',day&&day.allDay&&day.start==='2026-11-02'&&day.end==='2026-11-04'&&day.calendarId===home.id,JSON.stringify(day));
t('oldest first',ev.every((e,i)=>!i||ev[i-1].start<=e.start));
r=await api(A.token,'GET',`/v1/calendar/events?${W}&calendars=${home.id}`);t('only the calendars asked for',r.j.events?.length===1&&r.j.events[0].calendarId===home.id,JSON.stringify(r.j.events?.map(e=>e.summary)));
r=await api(A.token,'GET',`/v1/calendar/events?${W}&q=moved`);t('a search in the window',r.j.events?.length===1&&r.j.events[0].summary==='Standup (moved)',JSON.stringify(r.j.events?.map(e=>e.summary)));
r=await api(A.token,'GET',`/v1/calendar/events?q=${enc('long weekend')}`);t('a search with no range covers a year each way',r.j.events?.length===1&&r.j.events[0].summary==='Long weekend',JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET','/v1/calendar/events?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z');t('a window over 3 months is bad_request',r.s===400,r.s);
r=await api(A.token,'GET','/v1/calendar/events');t('a window needs from and to',r.s===400,r.s);
r=await api(A.token,'GET',`/v1/calendar/events/${enc(occ.id)}`);
t('one occurrence, with its series and the raw iCalendar',r.s===200&&r.j.event?.id===occ.id&&r.j.master?.id===`${work.id}:${SERIES}`&&r.j.raw?.includes('RRULE:FREQ=WEEKLY'),r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET',`/v1/calendar/events/${enc(`${work.id}:${SERIES}:20261102T160000Z`)}`);t('a time the series does not occur is not_found',r.s===404,r.s);

// ---- RSVP
r=await api(A.token,'POST',`/v1/calendar/events/${enc(`${work.id}:${SERIES}`)}/respond`,{response:'accepted'});
t('accept the invitation (the series)',r.s===200&&r.j.event?.myResponse==='accepted',r.s+' '+JSON.stringify(r.j).slice(0,160));
let raw=await (await dav('GET',`${WORK}${SERIES}.ics`)).text();
t('Radicale has PARTSTAT=ACCEPTED for Ann, on the series and its exception',(raw.replace(/\r\n /g,'').match(new RegExp(`PARTSTAT=ACCEPTED[^\\r\\n]*mailto:${EMAIL}`,'g'))??[]).length===2,raw.slice(0,100));

// ---- create, move, conflict
r=await api(A.token,'POST','/v1/calendar/events',{calendarId:work.id,summary:`Lunch ${tag}`,location:'Cafe',start:'2026-11-05T12:00',end:'2026-11-05T13:00',timezone:'America/New_York',attendees:[{email:'bo@test.local',name:'Bo'}],reminders:[{minutes:10}]});
t('create an event',r.s===201&&r.j.event?.summary===`Lunch ${tag}`&&r.j.event.start==='2026-11-05T17:00:00.000Z'&&r.j.event.timezone==='America/New_York'&&r.j.event.reminders?.[0]===10,r.s+' '+JSON.stringify(r.j).slice(0,200));
const LUNCH=r.j.event;
const lunchUid=decodeURIComponent(LUNCH?.eventId?.split(':')[1]??'');
res=await dav('GET',`${WORK}${enc(lunchUid)}.ics`);raw=await res.text();
t('it is on the server, in its zone, with Bo invited',res.status===200&&raw.includes('DTSTART;TZID=America/New_York:20261105T120000')&&/ATTENDEE[^\r\n]*\r?\n?[^\r\n]*bo@test\.local/.test(raw)&&raw.includes('ORGANIZER'),res.status+' '+raw.slice(0,120));
r=await api(A.token,'GET','/v1/calendar/events?from=2026-11-05T00:00:00Z&to=2026-11-06T00:00:00Z');t('and in the window',r.j.events?.some(e=>e.id===LUNCH.id));
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(LUNCH.id)}`,{start:'2026-11-05T18:00:00Z',end:'2026-11-05T19:30:00Z',etag:LUNCH.etag});
t('move it (PATCH)',r.s===200&&r.j.event?.start==='2026-11-05T18:00:00.000Z'&&r.j.event.end==='2026-11-05T19:30:00.000Z'&&r.j.event.etag!==LUNCH.etag,r.s+' '+JSON.stringify(r.j).slice(0,200));
const MOVED=r.j.event;
raw=await (await dav('GET',`${WORK}${enc(lunchUid)}.ics`)).text();t('the server has the new time, still in its zone',raw.includes('DTSTART;TZID=America/New_York:20261105T130000')&&raw.includes('DTEND;TZID=America/New_York:20261105T143000'),raw.match(/DTSTART[^\r\n]*/)?.[0]);
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(LUNCH.id)}`,{summary:'stale',etag:LUNCH.etag});t('a change made with an old etag is a conflict, 409',r.s===409&&r.j.error?.code==='conflict',r.s+' '+JSON.stringify(r.j));
// Another app changes it on the server; our cache has not seen that yet, so the PUT's If-Match fails (412).
res=await dav('PUT',`${WORK}${enc(lunchUid)}.ics`,raw.replace(/SUMMARY:[^\r\n]*/,'SUMMARY:Lunch elsewhere'),{'content-type':'text/calendar'});t('another app changes it on the server',res.status===204||res.status===201,res.status);
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(LUNCH.id)}`,{location:'Diner'});
t('our change then meets the server\'s 412: conflict',r.s===409&&r.j.error?.code==='conflict',r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'GET',`/v1/calendar/events/${enc(LUNCH.id)}`);t('and the cache was synced: the server\'s copy shows',r.j.event?.summary==='Lunch elsewhere'&&r.j.event.location==='Cafe'&&r.j.event.etag!==MOVED.etag,JSON.stringify(r.j.event).slice(0,160));
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(LUNCH.id)}`,{location:'Diner',etag:r.j.event.etag});t('looking again, the change goes through',r.s===200&&r.j.event?.location==='Diner',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(LUNCH.id)}`,{calendarId:home.id});
t('move it to another calendar',r.s===200&&r.j.event?.calendarId===home.id&&r.j.event.location==='Diner',r.s+' '+JSON.stringify(r.j).slice(0,160));
t('it left the first calendar on the server, and is in the other',(await dav('GET',`${WORK}${enc(lunchUid)}.ics`)).status===404&&(await dav('GET',`${HOME}${enc(lunchUid)}.ics`)).status===200);
const LUNCH2=r.j.event;

// ---- a series: this, following, delete
r=await api(A.token,'POST','/v1/calendar/events',{calendarId:work.id,summary:'Review',start:'2026-11-09T15:00:00Z',end:'2026-11-09T16:00:00Z',timezone:'America/New_York',recurrence:['RRULE:FREQ=DAILY;COUNT=10']});
t('create a repeating event',r.s===201&&r.j.event?.recurring&&r.j.event.recurrence?.[0]==='RRULE:FREQ=DAILY;COUNT=10',r.s+' '+JSON.stringify(r.j).slice(0,200));
const REVIEW=r.j.event, reviewUid=decodeURIComponent(REVIEW.eventId.split(':')[1]);
const RW='from=2026-11-09T00:00:00Z&to=2026-11-23T00:00:00Z';
const reviews=async()=>((await api(A.token,'GET',`/v1/calendar/events?${RW}&calendars=${work.id}`)).j.events??[]).filter(e=>e.summary.startsWith('Review'));
let list=await reviews();t('ten occurrences',list.length===10,list.length);
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(`${REVIEW.eventId}:20261111T150000Z`)}`,{start:'2026-11-11T17:00:00Z',end:'2026-11-11T18:00:00Z',scope:'this'});
t('move one occurrence (this)',r.s===200&&r.j.event?.start==='2026-11-11T17:00:00.000Z'&&r.j.event.recurrenceId==='20261111T150000Z',r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(`${REVIEW.eventId}:20261114T150000Z`)}`,{start:'2026-11-14T14:00:00Z',end:'2026-11-14T15:00:00Z',summary:'Review (new time)',scope:'following'});
t('split the series at an occurrence (following)',r.s===200&&r.j.event?.eventId!==REVIEW.eventId&&r.j.event.start==='2026-11-14T14:00:00.000Z'&&r.j.event.recurrence?.[0]==='RRULE:FREQ=DAILY;COUNT=5',r.s+' '+JSON.stringify(r.j).slice(0,200));
const NEWSERIES=r.j.event;
list=await reviews();
const old=list.filter(e=>e.eventId===REVIEW.eventId),neu=list.filter(e=>e.eventId===NEWSERIES?.eventId);
t('the old series ends before it, its exception kept',old.length===5&&old.every(e=>e.start<'2026-11-14')&&old.some(e=>e.start==='2026-11-11T17:00:00.000Z'),JSON.stringify(old.map(e=>e.start)));
t('the new one carries on at the new time',neu.length===5&&neu.every(e=>e.summary==='Review (new time)'&&e.start.endsWith('T14:00:00.000Z')),JSON.stringify(neu.map(e=>e.start)));
raw=await (await dav('GET',`${WORK}${enc(reviewUid)}.ics`)).text();t('on the server, the old one ends with UNTIL',/RRULE:FREQ=DAILY;UNTIL=20261114T145959Z/.test(raw),raw.match(/RRULE[^\r\n]*/)?.[0]);
r=await api(A.token,'DELETE',`/v1/calendar/events/${enc(`${REVIEW.eventId}:20261110T150000Z`)}?scope=this`);t('delete one occurrence',r.s===200&&r.j.ok,r.s+' '+JSON.stringify(r.j));
raw=await (await dav('GET',`${WORK}${enc(reviewUid)}.ics`)).text();t('it is an EXDATE on the server',/EXDATE;TZID=America\/New_York:20261110T100000/.test(raw),raw.match(/EXDATE[^\r\n]*/)?.[0]);
list=await reviews();t('and gone from the window',!list.some(e=>e.start.startsWith('2026-11-10'))&&list.length===9,list.length);
r=await api(A.token,'DELETE',`/v1/calendar/events/${enc(REVIEW.eventId)}`);t('delete the whole (old) series',r.s===200&&r.j.ok,r.s);
t('it is gone from the server',(await dav('GET',`${WORK}${enc(reviewUid)}.ics`)).status===404);
list=await reviews();t('and from the window; the new series stays',list.length===5&&list.every(e=>e.eventId===NEWSERIES.eventId),list.length);
r=await api(A.token,'DELETE',`/v1/calendar/events/${enc(REVIEW.eventId)}`);t('deleting it again is not_found',r.s===404,r.s);

// ---- calendars: hidden, colour, default; free/busy
r=await api(A.token,'PATCH',`/v1/calendar/calendars/${home.id}`,{hidden:true,color:'#123456'});t('hide a calendar and choose its colour',r.s===200&&r.j.calendar?.hidden&&r.j.calendar.color==='#123456',JSON.stringify(r.j));
r=await api(A.token,'GET',`/v1/calendar/events?${W}`);t('a hidden calendar is left out by default',!r.j.events?.some(e=>e.calendarId===home.id),JSON.stringify(r.j.events?.map(e=>e.summary)));
r=await api(A.token,'PATCH',`/v1/calendar/calendars/${home.id}`,{hidden:false,color:null,isDefault:true});
r=await api(A.token,'GET','/v1/calendar/calendars');t('back to the server\'s colour, and the default moved',r.j.calendars?.find(c=>c.id===home.id)?.color==='#34c759'&&r.j.calendars.find(c=>c.isDefault)?.id===home.id&&r.j.calendars.filter(c=>c.isDefault).length===1,JSON.stringify(r.j.calendars?.map(c=>[c.name,c.color,c.isDefault])));
r=await api(A.token,'POST','/v1/calendar/freebusy',{emails:[EMAIL,'someone@else.test'],from:'2026-11-04T00:00:00Z',to:'2026-11-06T00:00:00Z'});
const mine=r.j.busy?.find(b=>b.email===EMAIL);
t('free/busy: my own from the cache, others unknown on Radicale',r.s===200&&mine?.intervals?.some(([a,b])=>a==='2026-11-04T15:00:00.000Z'&&b==='2026-11-04T15:30:00.000Z')&&mine.intervals.some(([a])=>a==='2026-11-05T18:00:00.000Z')&&JSON.stringify(r.j.unknown)==='["someone@else.test"]',JSON.stringify(r.j).slice(0,220));

// ---- the alarm: an event put straight into Radicale shows up by itself; one deleted there goes
let dbg=await api(A.token,'GET','/v1/calendar/debug/sync');
t('debug: the calendars sync by sync-collection, and the alarm is set',dbg.j.calendars?.filter(c=>!isNative(c)).every(c=>c.supportsSync&&c.hasToken)&&typeof dbg.j.nextAlarmAt==='number'&&dbg.j.runs?.length>0,JSON.stringify(dbg.j).slice(0,200));
const OUTSIDE=`outside-${tag}`;
res=await dav('PUT',`${WORK}${OUTSIDE}.ics`,ics('BEGIN:VEVENT',`UID:${OUTSIDE}`,'DTSTAMP:20261101T000000Z','DTSTART:20261106T090000Z','DTEND:20261106T100000Z','SUMMARY:Made elsewhere','END:VEVENT'),{'content-type':'text/calendar'});
t('another app adds an event on the server',res.status===201,res.status);
const seen=async()=>((await api(A.token,'GET','/v1/calendar/events?from=2026-11-06T00:00:00Z&to=2026-11-07T00:00:00Z')).j.events??[]).some(e=>e.summary==='Made elsewhere');
t('not in the cache before a sync',!(await seen()));
const waitStart=Date.now();let found=false;
while(Date.now()-waitStart<95_000&&!(found=await seen()))await sleep(3000);
t(`the alarm's sync picked it up (${Math.round((Date.now()-waitStart)/1000)} s)`,found);
dbg=await api(A.token,'GET','/v1/calendar/debug/sync');t('by a delta',dbg.j.runs?.some(x=>x.mode==='delta'&&x.changed>=1&&!x.error),JSON.stringify(dbg.j.runs?.slice(0,3)));
res=await dav('DELETE',`${WORK}${OUTSIDE}.ics`);
r=await api(A.token,'POST','/v1/calendar/debug/sync');t('debug: sync now',r.s===200&&r.j.synced>=2,JSON.stringify(r.j).slice(0,160));
t('an event deleted on the server goes',!(await seen()));

// ---- timing lines, and forgetting the account
const lines=fs.readFileSync(log,'utf8').split('\n').filter(l=>l.includes('[calendar] '));
t('a timing line per request, the route without ids',lines.some(l=>/\[calendar\] PATCH \/v1\/calendar\/events\/:id 200 \d+ms \(server \d+ms\)/.test(l))&&lines.some(l=>/\[calendar\] POST \/v1\/calendar\/events\/:id\/respond 200/.test(l)),lines.slice(-3).join(' | '));
t('no address, summary or id in a log line',!lines.some(l=>l.includes(EMAIL)||l.includes(tag)||l.includes(work.id)||l.includes('Lunch')));
r=await api(A.token,'GET',`/v1/calendar/events/${enc(LUNCH2.id)}`);const timingHeader=r.h.get('x-calendar-timing');t('the timing header (local dev only)',/^server=\d+$/.test(timingHeader??''),timingHeader);
r=await api(A.token,'DELETE',`/v1/calendar/accounts/${ACC}`);t('forget the account',r.s===200&&r.j.ok);
r=await api(A.token,'GET','/v1/calendar/calendars');t('its calendars go with it; the native one stays, the default again',r.j.calendars?.length===1&&r.j.calendars[0].id===NATIVE.id&&r.j.calendars[0].isDefault,JSON.stringify(r.j.calendars));
r=await api(A.token,'GET',`/v1/calendar/events?${W}`);t('and its events',r.j.events?.length===0);
r=await api(A.token,'DELETE',`/v1/calendar/accounts/${(await api(A.token,'GET','/v1/calendar/accounts')).j.accounts?.[0]?.id}`);t('the native account cannot be removed',r.s===400,r.s);

// ---- native calendars (platform phase 4.1): the store is the object, events on the bus, grants, busy time for members
const NW='from=2026-12-01T00:00:00Z&to=2026-12-31T00:00:00Z';
r=await api(A.token,'POST','/v1/calendar/events',{summary:`Native ${tag}`,start:'2026-12-03T15:00:00Z',end:'2026-12-03T16:00:00Z'});
t('native: an event with no calendarId lands on the native calendar',r.s===201&&r.j.event?.calendarId===NATIVE.id&&/^"1-/.test(r.j.event.etag),r.s+' '+JSON.stringify(r.j).slice(0,200));
const NEV=r.j.event;
r=await api(A.token,'GET',`/v1/calendar/events?${NW}`);t('native: the window lists it',r.j.events?.length===1&&r.j.events[0].id===NEV.id,JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(NEV.id)}`,{summary:'stale',etag:'"0-0"'});t('native: an old etag is a conflict',r.s===409&&r.j.error?.code==='conflict',r.s);
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(NEV.id)}`,{start:'2026-12-03T16:00:00Z',end:'2026-12-03T17:00:00Z',etag:NEV.etag});
t('native: patch it',r.s===200&&r.j.event?.start==='2026-12-03T16:00:00.000Z'&&r.j.event.etag!==NEV.etag,r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'POST','/v1/calendar/events',{summary:'Scratch',start:'2026-12-04T10:00:00Z',end:'2026-12-04T11:00:00Z'});const SCRATCH=r.j.event;
r=await api(A.token,'DELETE',`/v1/calendar/events/${enc(SCRATCH.id)}`);t('native: delete one',r.s===200&&r.j.ok,r.s);
r=await api(A.token,'GET',`/v1/calendar/events?${NW}`);t('native: gone from the window',r.j.events?.length===1,r.j.events?.length);
const refOf=e=>typeof e.ref==='string'?e.ref:e.ref&&`${e.ref.organizationId}/${e.ref.app}/${e.ref.kind}/${e.ref.id}`;
r=await api(A.token,'GET','/v1/events?since=0&types=calendar.*');
const added=(r.j.events??[]).find(e=>e.type==='calendar.event.added'&&e.data?.eventId===NEV.eventId);
t('native: her read shows calendar.event.added with its ref',r.s===200&&added&&refOf(added)===`${ORGA}/calendar/event/${NEV.eventId}`&&added.data.calendarId===NEV.calendarId&&added.data.ownerAccountId&&/\/calendar\/week\/2026-12-03\?event=/.test(added.data.url),r.s+' '+JSON.stringify(r.j).slice(0,240));
t('native: and updated, cancelled',(r.j.events??[]).some(e=>e.type==='calendar.event.updated'&&e.data?.eventId===NEV.eventId)&&(r.j.events??[]).some(e=>e.type==='calendar.event.cancelled'&&e.data?.summary==='Scratch'),JSON.stringify((r.j.events??[]).map(e=>e.type)));
// Bob, in Ann's organization
r=await api(A.token,'POST',`/v1/workspaces/${ORGA}/invites`,{email:`cal-bob-${tag}@example.com`});const invite=(r.j.inviteUrl??'').split('/').pop();
const Bob=await signup(`cal-bob-${tag}@example.com`,'Bob');
r=await api(Bob.token,'POST','/v1/invites/accept',{token:invite});t('native: Bob joins her organization',r.s<300&&!!Bob.token,r.s+' '+JSON.stringify(r.j).slice(0,100));
const NWIN=`/v1/calendar/events?${NW}&calendars=${NATIVE.id}`;
r=await api(Bob.token,'GET',NWIN);t('native: Bob cannot read her calendar (404)',r.s===404,r.s+' '+JSON.stringify(r.j));
r=await api(Bob.token,'GET',`/v1/calendar/events/${enc(NEV.id)}`);t('native: nor one event',r.s===404,r.s);
r=await api(Bob.token,'GET','/v1/events?since=0&types=calendar.*');t('native: nor its events on the bus',r.s===200&&!(r.j.events??[]).some(e=>e.data?.calendarId===NATIVE.id),JSON.stringify(r.j).slice(0,120));
// Bob's account id, from his own native calendar's id (n.<accountId>.<random>).
const bobId=(await api(Bob.token,'GET','/v1/calendar/calendars')).j.calendars?.[0]?.id?.split('.')[1];
r=await api(A.token,'PUT',`/v1/calendar/calendars/${NATIVE.id}/grants`,{principal:`link:x`,role:'viewer'});t('native: a link is not_supported',r.s===400&&r.j.error?.code==='not_supported',r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'PUT',`/v1/calendar/calendars/${NATIVE.id}/grants`,{principal:`account:${bobId}`,role:'viewer'});
t('native: Ann grants Bob viewer',r.s===200&&r.j.role==='owner'&&r.j.grants?.[0]?.principal===`account:${bobId}`&&r.j.grants[0].role==='viewer',r.s+' '+JSON.stringify(r.j).slice(0,200));
r=await api(Bob.token,'GET','/v1/calendar/shared');
t('native: Bob\'s shared calendars list it, with its name, colour and his role',r.s===200&&r.j.calendars?.length===1&&r.j.calendars[0].id===NATIVE.id&&r.j.calendars[0].name==='Calendar'&&r.j.calendars[0].role==='viewer'&&!!r.j.calendars[0].color,r.s+' '+JSON.stringify(r.j).slice(0,200));
r=await api(Bob.token,'GET',NWIN);t('native: his window read returns her event',r.s===200&&r.j.events?.length===1&&r.j.events[0].id===NEV.id,r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(Bob.token,'GET','/v1/events?since=0&types=calendar.event.added');t('native: and the bus shows him its events now',(r.j.events??[]).some(e=>e.data?.eventId===NEV.eventId),JSON.stringify(r.j).slice(0,120));
r=await api(Bob.token,'POST','/v1/calendar/events',{calendarId:NATIVE.id,summary:'By Bob',start:'2026-12-05T10:00:00Z',end:'2026-12-05T11:00:00Z'});t('native: a viewer cannot create (403)',r.s===403,r.s+' '+JSON.stringify(r.j));
r=await api(Bob.token,'PUT',`/v1/calendar/calendars/${NATIVE.id}/grants`,{principal:'org',role:'viewer'});t('native: nor share',r.s===403,r.s);
await api(A.token,'PUT',`/v1/calendar/calendars/${NATIVE.id}/grants`,{principal:`account:${bobId}`,role:'editor'});
r=await api(Bob.token,'POST','/v1/calendar/events',{calendarId:NATIVE.id,summary:'By Bob',start:'2026-12-05T10:00:00Z',end:'2026-12-05T11:00:00Z'});t('native: an editor can',r.s===201&&r.j.event?.calendarId===NATIVE.id,r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(Bob.token,'PATCH',`/v1/calendar/events/${enc(r.j.event?.id)}`,{summary:'By Bob (moved)',start:'2026-12-05T12:00:00Z',end:'2026-12-05T13:00:00Z'});t('native: and change it',r.s===200&&r.j.event?.summary==='By Bob (moved)',r.s);
r=await api(A.token,'GET',`/v1/calendar/events?${NW}`);t('native: Ann sees it on her calendar',r.j.events?.some(e=>e.summary==='By Bob (moved)'));
r=await api(Bob.token,'POST','/v1/calendar/freebusy',{emails:[ANN_ADDR,'nobody@else.test'],from:'2026-12-01T00:00:00Z',to:'2026-12-10T00:00:00Z'});
const annBusy=r.j.busy?.find(b=>b.email===ANN_ADDR);
t('native: free/busy for Ann\'s address from Bob: her busy intervals',r.s===200&&JSON.stringify(annBusy?.intervals)===JSON.stringify([['2026-12-03T16:00:00.000Z','2026-12-03T17:00:00.000Z'],['2026-12-05T12:00:00.000Z','2026-12-05T13:00:00.000Z']])&&r.j.unknown?.includes('nobody@else.test'),JSON.stringify(r.j).slice(0,240));
r=await api(Bo.token,'POST','/v1/calendar/freebusy',{emails:[ANN_ADDR],from:'2026-12-01T00:00:00Z',to:'2026-12-10T00:00:00Z'});t('native: not for someone of another organization',r.j.unknown?.includes(ANN_ADDR),JSON.stringify(r.j));
r=await api(A.token,'DELETE',`/v1/calendar/calendars/${NATIVE.id}/grants/${enc(`account:${bobId}`)}`);t('native: Ann revokes',r.s===200&&r.j.grants?.length===0,r.s+' '+JSON.stringify(r.j));
r=await api(Bob.token,'GET',NWIN);t('native: after the revoke Bob gets 404 again',r.s===404,r.s);
r=await api(Bob.token,'GET','/v1/calendar/shared');t('native: and it is no longer shared with him',r.j.calendars?.length===0,JSON.stringify(r.j));
r=await api(Bob.token,'GET','/v1/events?since=0&types=calendar.*');t('native: nor on his bus',!(r.j.events??[]).some(e=>e.data?.calendarId===NATIVE.id),JSON.stringify(r.j).slice(0,120));
// Shared with the whole organization (phase 4.4): listed for Bob, marked org, and its events on his bus; an account outside
// the organization cannot be given it.
const boId=(await api(Bo.token,'GET','/v1/calendar/calendars')).j.calendars?.[0]?.id?.split('.')[1];
r=await api(A.token,'PUT',`/v1/calendar/calendars/${NATIVE.id}/grants`,{principal:`account:${boId}`,role:'viewer'});t('org: a grant to an account outside the organization is 400 not_a_member',r.s===400&&r.j.error?.code==='not_a_member',r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'PUT',`/v1/calendar/calendars/${NATIVE.id}/grants`,{principal:'org',role:'viewer'});t('org: Ann shares it with the organization',r.s===200&&r.j.grants?.some(g=>g.principal==='org'),r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(Bob.token,'GET','/v1/calendar/shared');t('org: Bob\'s shared calendars list it, principal org',r.j.calendars?.length===1&&r.j.calendars[0].id===NATIVE.id&&r.j.calendars[0].principal==='org'&&r.j.calendars[0].role==='viewer',JSON.stringify(r.j).slice(0,200));
r=await api(Bob.token,'GET',`/v1/workspaces/${ORGA}/shared-with-me`);t('org: the index\'s shared-with-me leaves it out',!(r.j.shares??[]).some(x=>x.kind==='calendar'),JSON.stringify(r.j).slice(0,160));
r=await api(Bob.token,'GET',`/v1/workspaces/${ORGA}/shared-with-me?org=1`);t('org: and lists it with ?org=1',(r.j.shares??[]).some(x=>x.kind==='calendar'&&x.principal==='org'),JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'POST','/v1/calendar/events',{summary:`All hands ${tag}`,start:'2026-12-08T15:00:00Z',end:'2026-12-08T16:00:00Z'});const OEV=r.j.event;
r=await api(Bob.token,'GET','/v1/events?since=0&types=calendar.event.added');t('org: Bob\'s one-shot read has calendar.event.added for it',(r.j.events??[]).some(e=>e.data?.eventId===OEV?.eventId),JSON.stringify(r.j).slice(0,160));
r=await api(Bo.token,'GET','/v1/events?since=0&types=calendar.*');t('org: someone in another organization does not',r.s!==200||!(r.j.events??[]).some(e=>e.data?.eventId===OEV?.eventId),r.s);
await api(A.token,'DELETE',`/v1/calendar/events/${enc(OEV?.id)}`);
r=await api(A.token,'DELETE',`/v1/calendar/calendars/${NATIVE.id}/grants/org`);t('org: Ann stops sharing it',r.s===200&&!r.j.grants?.length,r.s);
r=await api(Bob.token,'GET','/v1/calendar/shared');t('org: and it is gone from Bob\'s list',r.j.calendars?.length===0,JSON.stringify(r.j));

// ---- scheduling between accounts (platform phase 4.2): Ann invites Bob, an agent and an outside guest by address; Bob
// and the agent get the event by object call, answer, follow a move and a cancellation; the guest would get mail.
r=await api(A.token,'POST',`/v1/workspaces/${ORGA}/agent-invites`,{});
r=await api(null,'POST','/v1/agents/redeem',{code:r.j.code,username:`calbot${tag}`,key:'a-long-agent-key-for-the-calendar-test',name:'Builder'});const AGT=r.j.agentToken;
t('sched: an agent joins Ann\'s organization',r.s===201&&!!AGT,r.s+' '+JSON.stringify(r.j).slice(0,120));
const BOB_ADDR=(await api(Bob.token,'GET','/v1/calendar/accounts')).j.accounts?.find(a=>a.kind==='native')?.email;
const BOT_ADDR=(await api(AGT,'GET','/v1/me')).j.accounts?.[0]?.address;
const GUEST=`guest-${tag}@example.com`, SW='from=2027-01-01T00:00:00Z&to=2027-01-31T00:00:00Z';
t('sched: Bob\'s and the agent\'s addresses',!!BOB_ADDR&&!!BOT_ADDR&&BOB_ADDR!==BOT_ADDR,BOB_ADDR+' '+BOT_ADDR);
r=await api(A.token,'POST','/v1/calendar/events',{summary:`Review ${tag}`,start:'2027-01-14T15:00:00Z',end:'2027-01-14T16:00:00Z',attendees:[{email:BOB_ADDR},{email:BOT_ADDR},{email:GUEST}]});
const REV=r.j.event;const acctOf=(ev,e)=>ev?.attendees?.find(a=>a.email===e)?.accountId;const answerOf=(ev,e)=>ev?.attendees?.find(a=>a.email===e)?.response;
t('sched: Ann creates it; Bob and the agent resolve to accounts, the guest is outside',r.s===201&&!!acctOf(REV,BOB_ADDR)&&!!acctOf(REV,BOT_ADDR)&&!acctOf(REV,GUEST),r.s+' '+JSON.stringify(REV?.attendees));
t('sched: the guest is the only one emailed (Ann has no mail account here, so it says so)',r.j.invitationsSent===false&&/No mail account/.test(r.j.invitationsNote??''),JSON.stringify(r.j).slice(-160));
r=await api(Bob.token,'GET',`/v1/calendar/events?${SW}`);const BCOPY=r.j.events?.find(e=>e.summary===`Review ${tag}`);
const bobDefault=(await api(Bob.token,'GET','/v1/calendar/calendars')).j.calendars?.find(c=>c.isDefault);
t('sched: Bob\'s default calendar holds it, needs-action',!!BCOPY&&BCOPY.calendarId===bobDefault?.id&&BCOPY.myResponse==='needs-action'&&BCOPY.organizer?.email===ANN_ADDR,JSON.stringify(BCOPY).slice(0,200));
r=await api(AGT,'GET',`/v1/calendar/events?${SW}&workspace=${ORGA}`);const ACOPY=r.j.events?.find(e=>e.summary===`Review ${tag}`);
t('sched: so does the agent\'s',r.s===200&&!!ACOPY&&ACOPY.myResponse==='needs-action'&&/^n\./.test(ACOPY.calendarId),r.s+' '+JSON.stringify(r.j).slice(0,200));
const invitedIn=async(tok,copy)=>((await api(tok,'GET','/v1/events?since=0&types=calendar.invited')).j.events??[]).find(e=>e.data?.eventId===copy?.eventId);
let ie=await invitedIn(Bob.token,BCOPY);t('sched: Bob\'s one-shot read has calendar.invited, with the organizer',!!ie&&ie.data.organizer?.email===ANN_ADDR&&ie.data.organizer.name==='Ann'&&!!ie.data.organizer.accountId&&ie.data.summary===`Review ${tag}`&&/\/calendar\/week\/2027-01-14\?event=/.test(ie.data.url),JSON.stringify(ie).slice(0,240));
ie=await invitedIn(AGT,ACOPY);t('sched: and the agent\'s',!!ie&&ie.data.organizer?.email===ANN_ADDR,JSON.stringify(ie).slice(0,160));
r=await api(A.token,'GET','/v1/events?since=0&types=calendar.invited');t('sched: an invitation is the invited account\'s alone',!(r.j.events??[]).some(e=>e.data?.summary===`Review ${tag}`),JSON.stringify(r.j).slice(0,120));
r=await api(Bob.token,'POST',`/v1/calendar/events/${enc(BCOPY.id)}/respond`,{response:'accepted'});t('sched: Bob accepts; the organizer told by object call',r.s===200&&r.j.event?.myResponse==='accepted'&&r.j.replied==='server',r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET',`/v1/calendar/events/${enc(REV.id)}`);t('sched: Ann\'s event shows Bob accepted',answerOf(r.j.event,BOB_ADDR)==='accepted'&&answerOf(r.j.event,BOT_ADDR)==='needs-action',JSON.stringify(r.j.event?.attendees));
r=await api(A.token,'GET','/v1/events?since=0&types=calendar.event.updated');t('sched: and her bus says who answered',(r.j.events??[]).some(e=>e.data?.eventId===REV.eventId&&e.data.attendeeResponse?.email===BOB_ADDR&&e.data.attendeeResponse.response==='accepted'),JSON.stringify((r.j.events??[]).map(e=>e.data?.attendeeResponse)).slice(0,160));
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(REV.id)}`,{start:'2027-01-14T16:00:00Z',end:'2027-01-14T17:00:00Z'});t('sched: Ann moves it an hour later',r.s===200,r.s);
r=await api(Bob.token,'GET',`/v1/calendar/events/${enc(BCOPY.id)}`);t('sched: Bob\'s copy moves and keeps accepted',r.j.event?.start==='2027-01-14T16:00:00.000Z'&&r.j.event.myResponse==='accepted',JSON.stringify(r.j.event).slice(0,200));
r=await api(AGT,'POST',`/v1/calendar/events/${enc(ACOPY.id)}/respond?workspace=${ORGA}`,{response:'declined'});t('sched: the agent declines through the API, as the agent',r.s===200&&r.j.event?.myResponse==='declined'&&r.j.replied==='server',r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET',`/v1/calendar/events/${enc(REV.id)}`);t('sched: Ann sees it',answerOf(r.j.event,BOT_ADDR)==='declined'&&answerOf(r.j.event,BOB_ADDR)==='accepted',JSON.stringify(r.j.event?.attendees));
r=await api(Bob.token,'PATCH',`/v1/calendar/events/${enc(BCOPY.id)}`,{summary:'Mine now'});t('sched: an attendee\'s PATCH of Ann\'s event is 403 not_organizer',r.s===403&&r.j.error?.code==='not_organizer',r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'DELETE',`/v1/calendar/events/${enc(REV.id)}`);t('sched: Ann cancels',r.s===200&&r.j.ok,r.s);
r=await api(Bob.token,'GET',`/v1/calendar/events/${enc(BCOPY.id)}`);t('sched: Bob\'s copy is kept, cancelled',r.s===200&&r.j.event?.status==='cancelled',r.s+' '+JSON.stringify(r.j.event).slice(0,160));
r=await api(AGT,'GET',`/v1/calendar/events/${enc(ACOPY.id)}`);t('sched: and the agent\'s',r.j.event?.status==='cancelled',JSON.stringify(r.j.event).slice(0,120));

// ---- the guest scheduler (docs/specs/guest-scheduler.md): Ann turns her booking page on, a guest with no session books a
// slot through /v1/book, the meeting lands on Ann's native calendar with the guest invited, the guest is mailed their own
// link (the Worker's log), and cancels with it. No token reaches a log line.
r=await api(A.token,'PATCH','/v1/calendar/scheduler?tz=UTC',{enabled:true,timezone:'UTC',minNoticeMin:0,title:`Chat ${tag}`});
const BTOK=r.j.token;t('book: Ann turns her page on and gets a readable link',r.s===200&&/^[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}-[0-9a-hjkmnp-tv-z]{4}$/.test(BTOK??'')&&r.j.url?.endsWith(`/calendar/book/${BTOK}`),r.s+' '+JSON.stringify(r.j).slice(0,200));
r=await api(null,'GET',`/v1/book/${BTOK.toUpperCase()}`);t('book: the page answers with no session, nothing private',r.s===200&&r.j.page?.title===`Chat ${tag}`&&!JSON.stringify(r.j).includes('@'),r.s+' '+JSON.stringify(r.j).slice(0,200));
r=await api(null,'GET','/v1/book/zzzz-zzzz-zzzz');t('book: an unknown token is 404',r.s===404,r.s);
const nextMonth=new Date(Date.UTC(new Date().getUTCFullYear(),new Date().getUTCMonth()+1,1)).toISOString().slice(0,7);
r=await api(null,'GET',`/v1/book/${BTOK}/days?month=${nextMonth}&duration=30&tz=UTC`);const BDAY=r.j.days?.[0];
t('book: next month has open weekdays',r.s===200&&r.j.days?.length>=15&&r.j.days.every(d=>![0,6].includes(new Date(d+'T00:00:00Z').getUTCDay())),r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(null,'GET',`/v1/book/${BTOK}/slots?date=${BDAY}&duration=30&tz=UTC`);const BSLOT=r.j.slots?.[0];
t('book: the first day starts at 9:00 UTC',BSLOT===`${BDAY}T09:00:00.000Z`&&r.j.slots.length===16,JSON.stringify(r.j).slice(0,160));
const BGUEST=`guest-${tag}@example.com`;
r=await api(null,'POST',`/v1/book/${BTOK}`,{start:BSLOT,duration:30,name:'Gus Guest',email:BGUEST,tz:'UTC'});
const MANAGE=r.j.manageToken;t('book: a guest books it',r.s===201&&r.j.booking?.status==='booked'&&/\/calendar\/book\/m\//.test(r.j.manageUrl??''),r.s+' '+JSON.stringify(r.j).slice(0,200));
r=await api(null,'POST',`/v1/book/${BTOK}`,{start:BSLOT,duration:30,name:'Second',email:`second-${tag}@example.com`,tz:'UTC'},{'cf-connecting-ip':'198.51.100.9'});t('book: the same slot again is slot_taken',r.s===409&&r.j.error?.code==='slot_taken',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET',`/v1/calendar/events?from=${BDAY}T00:00:00Z&to=${BDAY}T23:59:59Z`);const BEV=r.j.events?.find(e=>e.summary===`Chat ${tag}: Gus Guest`);
t('book: on Ann\'s native calendar with the guest invited',!!BEV&&BEV.calendarId===NATIVE.id&&BEV.attendees?.some(a=>a.email===BGUEST),JSON.stringify(r.j).slice(0,200));
await sleep(300);
{const L=fs.readFileSync(log,'utf8');
t('book: the guest is mailed their own link',new RegExp(`\\[mail\\] to=${BGUEST}.*calendar/book/m/${MANAGE}`).test(L));
t('book: no booking token in a log line',!L.split('\n').some(l=>l.startsWith('[calendar]')&&(l.includes(BTOK)||l.includes(MANAGE))));}
r=await api(null,'POST',`/v1/book/m/${MANAGE}/cancel`);t('book: the guest cancels with their link',r.s===200&&r.j.booking?.status==='cancelled',r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET',`/v1/calendar/events?from=${BDAY}T00:00:00Z&to=${BDAY}T23:59:59Z`);t('book: and it is off Ann\'s calendar',!r.j.events?.some(e=>e.summary===`Chat ${tag}: Gus Guest`),JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'PATCH','/v1/calendar/scheduler',{enabled:false});r=await api(null,'GET',`/v1/book/${BTOK}`);t('book: a page turned off is 404',r.s===404,r.s);
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
