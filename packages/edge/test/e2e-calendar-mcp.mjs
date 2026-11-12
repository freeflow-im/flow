// End-to-end check of the Calendar tools on the suite's MCP endpoint (/mcp, src/calendar/calendarTools.ts,
// docs/specs/web-mcp.md "Calendar tools"): OAuth consent with Calendar as a checkbox, then list, create (with an
// attendee), find free time, answer an invitation, change and delete with a scope, against Radicale in Docker; then native
// calendars (phase 4.3) with a second member, Bob: book with him, find free time over both, share, unshare, delete
// (`flow-radicale`, 127.0.0.1:5232, any password logs in; test/e2e-calendar.mjs says how to start it) and the same local
// `wrangler dev` as test/e2e-calendar.mjs, plus --local-upstream so OAuth's issuer is the local origin (as e2e-mail-mcp.mjs):
//   npx wrangler dev --port 18799 --local --enable-containers=false --local-upstream localhost:18799 \
//     --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 \
//     --var WEB_URL_BASE:http://localhost:18799 --var CALENDAR_ALLOW_INSECURE:1 > /tmp/edge-calendar.log 2>&1 &
//   node test/e2e-calendar-mcp.mjs /tmp/edge-calendar.log
// (B=http://localhost:<port> points it at another port; test/e2e-calendar.mjs runs against the same Worker.)
// It reads signup links from the Worker's log (local mail goes there). Each run uses Radicale calendars of its own.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18799';
const DAV=process.env.DAV??'http://127.0.0.1:5232';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,220):''));};
const api=async(tok,m,p,b,type,extra={})=>{const r=await fetch(B+p,{method:m,redirect:'manual',headers:{...extra,...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':type??'application/json'}:{})},body:b===undefined?undefined:(type?b:JSON.stringify(b))});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const form=(o)=>new URLSearchParams(o).toString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const USER=`mcp-${tag}`, EMAIL=`${USER}@test.local`;
const dav=(m,path,body,h={})=>fetch(DAV+path,{method:m,headers:{authorization:'Basic '+Buffer.from(USER+':x').toString('base64'),...h},body});
const ics=(...lines)=>['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//e2e//EN',...lines,'END:VCALENDAR',''].join('\r\n');

// --- Ann, with an organization and a Radicale calendar that has an invitation and a weekly series ---------------------
const A=await signup(`calmcp-${tag}@example.com`,'Ann');
let r=await api(A.token,'POST','/v1/workspaces',{name:`Acme ${tag}`,slug:`acme-${tag}`});const ORG=r.j.id;
t('Ann, with an organization',A.token&&ORG,r.s);
const WORK=`/${USER}/work/`;
let res=await dav('MKCALENDAR',WORK,`<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Work</D:displayname></D:prop></D:set></C:mkcalendar>`,{'content-type':'application/xml'});
t('Radicale: a Work calendar',res.status===201,res.status);
await dav('PUT',`${WORK}invite-${tag}.ics`,ics('BEGIN:VEVENT',`UID:invite-${tag}`,'DTSTAMP:20261101T000000Z','DTSTART:20261110T170000Z','DTEND:20261110T180000Z','SUMMARY:Pilot review','ORGANIZER;CN=Bo:mailto:bo@test.local',`ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${EMAIL}`,'END:VEVENT'),{'content-type':'text/calendar'});
await dav('PUT',`${WORK}gym-${tag}.ics`,ics('BEGIN:VEVENT',`UID:gym-${tag}`,'DTSTAMP:20261101T000000Z','DTSTART:20261109T150000Z','DTEND:20261109T160000Z','RRULE:FREQ=DAILY;COUNT=5','SUMMARY:Gym','END:VEVENT'),{'content-type':'text/calendar'});
r=await api(A.token,'POST','/v1/calendar/accounts',{email:EMAIL,displayName:'Ann',password:'x',server:{url:DAV+'/',username:USER}});
t('Ann connects Radicale',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,120));
// Her native calendar (phase 4.1) was the default; this run writes to the Radicale one.
await api(A.token,'PATCH',`/v1/calendar/calendars/${r.j.calendars?.find((c)=>c.name==='Work')?.id}`,{isDefault:true});

// --- OAuth: Calendar is a checkbox, on as the page starts ------------------------------------------------------------------
r=await api(null,'POST','/oauth/register',{client_name:'Calendar Agent',redirect_uris:['http://localhost/callback']});const CLIENT=r.j.client_id;
const cookie=(u)=>({cookie:`sid=${u.token}`});
const pkce=()=>{const v=randomBytes(32).toString('base64url');return{v,c:createHash('sha256').update(v).digest('base64url')}};
const authorizeUrl=(c,extra={})=>'/oauth/authorize?'+form({response_type:'code',client_id:CLIENT,redirect_uri:'http://localhost:51234/callback',code_challenge:c,code_challenge_method:'S256',state:'s',resource:`${B}/mcp`,...extra});
const consentOf=(html)=>({p:/name="p" value="([^"]+)"/.exec(html)?.[1],csrf:/name="csrf" value="([^"]+)"/.exec(html)?.[1],grants:[...html.matchAll(/name="grant_(\w+)" value="on"( checked)?/g)].map((m)=>({id:m[1],checked:!!m[2]}))});
async function connect(u,org,grants,extra={}){const {v,c}=pkce();let x=await api(null,'GET',authorizeUrl(c,extra),undefined,undefined,cookie(u));const page=await api(null,'GET',x.h.get('location'),undefined,undefined,cookie(u));const f=consentOf(page.j);
  const ticked=grants??f.grants.filter((g)=>g.checked).map((g)=>g.id);
  x=await api(null,'POST','/oauth/decision',form({p:f.p,csrf:f.csrf,org,allow:'yes',scopes_form:'1',...Object.fromEntries(ticked.map((g)=>[`grant_${g}`,'on']))}),'application/x-www-form-urlencoded',{...cookie(u),origin:B});
  if(x.s!==302)return{error:x.s,page:x.j,consent:f,html:page.j};
  const code=new URL(x.h.get('location')).searchParams.get('code');
  return {...(await api(null,'POST','/oauth/token',form({grant_type:'authorization_code',code,code_verifier:v,client_id:CLIENT,redirect_uri:'http://localhost:51234/callback'}),'application/x-www-form-urlencoded')).j,consent:f,html:page.j};}
const TOK=await connect(A,ORG);
t('consent offers Calendar, checked',TOK.consent.grants.some((g)=>g.id==='calendar'&&g.checked)&&TOK.html.includes('Calendar: see and change your events'),JSON.stringify(TOK.consent.grants));
t('the default token carries the calendar scopes',/calendar:read calendar:write/.test(TOK.scope??''),TOK.scope);
const READ=await connect(A,ORG,['calendar'],{scope:'calendar:read'});
t('a client asking for calendar:read gets only that',READ.scope==='calendar:read',READ.scope);

let rpcId=0;
const mcp=(tok,method,params={})=>api(tok,'POST','/mcp',{jsonrpc:'2.0',id:++rpcId,method,params},undefined,{accept:'application/json, text/event-stream'});
const list=async(tok)=>((await mcp(tok,'tools/list')).j.result?.tools??[]).map((x)=>x.name);
const call=async(tok,name,args)=>{const x=await mcp(tok,'tools/call',{name,arguments:args});const text=x.j?.result?.content?.[0]?.text;let v;try{v=JSON.parse(text)}catch{v=text}return{...x,v,isError:!!x.j?.result?.isError||!!x.j?.error,text:text??x.j?.error?.message}};
const CAL=['list_calendars','get_booking_link','list_shared_calendars','list_events','get_event','find_free_time','create_event','update_event','delete_event','respond_to_event','share_calendar','unshare_calendar'];
let names=await list(TOK.access_token);t('tools/list: the Calendar tools, beside Docs\'',CAL.every((n)=>names.includes(n))&&names.includes('read_range'),names.filter((n)=>CAL.includes(n)).join(','));
names=await list(READ.access_token);t('calendar:read lists only the reading ones',JSON.stringify(names)===JSON.stringify(['list_calendars','get_booking_link','list_shared_calendars','list_events','get_event','find_free_time']),names.join(','));
r=await call(READ.access_token,'create_event',{summary:'x',start:'2026-11-12',end:'2026-11-13'});t('and cannot create',r.isError,r.text);
r=await mcp(TOK.access_token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'e2e',version:'1'}});
t('the instructions speak of Calendar',/Calendar:/.test(r.j.result?.instructions??''),'');

// --- Reading -----------------------------------------------------------------------------------------------------------------
const T=TOK.access_token;
r=await call(T,'list_calendars',{});const work=r.v.calendars?.find((c)=>c.name==='Work');
t('list_calendars',work&&work.account===EMAIL&&work.default===true,JSON.stringify(r.v).slice(0,200));
r=await call(T,'list_events',{from:'2026-11-09T00:00:00Z',to:'2026-11-16T00:00:00Z'});const evs=r.v.events??[];
const invite=evs.find((e)=>e.summary==='Pilot review'),gyms=evs.filter((e)=>e.summary==='Gym');
t('list_events: the invitation and the series, an entry per occurrence',invite&&gyms.length===5&&gyms[0].repeats==='Daily, 5 times'&&gyms[0].series_id,JSON.stringify(evs.map((e)=>e.summary)));
t('the invitation, unanswered, with a link',invite?.my_response==='needs-action'&&invite.organizer==='Bo <bo@test.local>'&&invite.link?.startsWith(`${B}/calendar/week/2026-11-10?event=`),JSON.stringify(invite).slice(0,220));
r=await call(T,'list_events',{from:'2026-01-01',to:'2026-12-31'});t('a window over 93 days is refused',r.isError&&/93 days/.test(r.text),r.text);
r=await call(T,'get_event',{id:gyms[2]?.id});t('get_event: an occurrence, with its series',r.v.event?.id===gyms[2]?.id&&r.v.series?.recurrence?.[0]==='RRULE:FREQ=DAILY;COUNT=5',JSON.stringify(r.v).slice(0,200));
r=await call(T,'get_event',{id:'nope'});t('a malformed id is refused',r.isError&&/not an event id/.test(r.text),r.text);

// --- Free time, create, answer, change, delete ------------------------------------------------------------------------
r=await call(T,'find_free_time',{duration_minutes:60,from:'2026-11-10T13:00:00Z',to:'2026-11-10T22:00:00Z',attendees:['bo@test.local'],working_hours:null});
const slots=r.v.slots??[];
t('find_free_time: around the gym and the review, Bo unknown',slots.length>=2&&!slots.some((s)=>s.start<'2026-11-10T18:00:00.000Z'&&s.end>'2026-11-10T17:00:00.000Z')&&!slots.some((s)=>s.start<'2026-11-10T16:00:00.000Z'&&s.end>'2026-11-10T15:00:00.000Z')&&JSON.stringify(r.v.unknown)==='["bo@test.local"]',JSON.stringify(r.v).slice(0,220));
const slot=slots.find((s)=>s.minutes>=60);
r=await call(T,'create_event',{summary:`Planning ${tag}`,start:slot.start,end:new Date(Date.parse(slot.start)+3600000).toISOString(),attendees:['Bo <bo@test.local>'],location:'Room 4',calendar_id:work.id});
const made=r.v.created;t('create_event, inviting Bo',made?.summary===`Planning ${tag}`&&JSON.stringify(r.v.invited)==='["bo@test.local"]'&&made.calendar?.name==='Work',JSON.stringify(r.v).slice(0,220));
const uid=decodeURIComponent(made?.id?.split(':')[1]??'');
let raw=await (await dav('GET',`${WORK}${encodeURIComponent(uid)}.ics`)).text();t('it is on the server with Bo as an attendee',raw.includes(`Planning ${tag}`)&&/bo@test\.local/.test(raw.replace(/\r\n /g,'')),raw.slice(0,80));
r=await call(T,'respond_to_event',{id:invite.id,response:'accepted'});t('respond_to_event: accept the invitation',r.v.answered==='accepted'&&r.v.event?.my_response==='accepted',JSON.stringify(r.v).slice(0,160));
raw=await (await dav('GET',`${WORK}invite-${tag}.ics`)).text();t('the server has PARTSTAT=ACCEPTED',new RegExp(`PARTSTAT=ACCEPTED[^\\r\\n]*mailto:${EMAIL}`).test(raw.replace(/\r\n /g,'')),'');
r=await call(T,'update_event',{id:made.id,summary:`Planning (moved) ${tag}`,start:'2026-11-11T17:00:00Z',end:'2026-11-11T18:00:00Z'});
t('update_event: moved and renamed',r.v.updated?.start==='2026-11-11T17:00:00.000Z'&&r.v.updated.summary===`Planning (moved) ${tag}`,JSON.stringify(r.v).slice(0,160));
r=await call(T,'delete_event',{id:gyms[1].id,scope:'this'});t('delete_event: one occurrence',r.v.deleted===gyms[1].id,JSON.stringify(r.v));
raw=await (await dav('GET',`${WORK}gym-${tag}.ics`)).text();t('it is an EXDATE on the server',/EXDATE/.test(raw),raw.match(/EXDATE[^\r\n]*/)?.[0]);
r=await call(T,'delete_event',{id:gyms[3].id,scope:'following'});t('delete_event: this and following',!r.isError,r.text);
r=await call(T,'list_events',{from:'2026-11-09T00:00:00Z',to:'2026-11-16T00:00:00Z'});t('two gyms left',(r.v.events??[]).filter((e)=>e.summary==='Gym').length===2,JSON.stringify((r.v.events??[]).map((e)=>e.start.slice(5,10)+' '+e.summary)));
r=await call(T,'delete_event',{id:made.id});t('delete_event: the event',!r.isError,r.text);
t('gone from the server',(await dav('GET',`${WORK}${encodeURIComponent(uid)}.ics`)).status===404);
r=await call(T,'get_event',{id:made.id});t('and not found after',r.isError&&/Not found/.test(r.text),r.text);

// --- Native calendars (phase 4.3): Bob joins Ann's organization ------------------------------------------------------------
r=await api(A.token,'POST',`/v1/workspaces/${ORG}/invites`,{email:`calmcp-bob-${tag}@example.com`});const invTok=(r.j.inviteUrl??'').split('/').pop();
const Bob=await signup(`calmcp-bob-${tag}@example.com`,'Bob');
r=await api(Bob.token,'POST','/v1/invites/accept',{token:invTok});t('native: Bob joins Ann\'s organization',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,100));
const BT=(await connect(Bob,ORG)).access_token;t('native: Bob connects an agent too',!!BT);
const ANN_ADDR=(await api(A.token,'GET','/v1/calendar/accounts')).j.accounts?.find((a)=>a.kind==='native')?.email;
const BOB_ADDR=(await api(Bob.token,'GET','/v1/calendar/accounts')).j.accounts?.find((a)=>a.kind==='native')?.email;
r=await call(T,'list_calendars',{});const annNative=r.v.calendars?.find((c)=>c.native===true);
t('native: list_calendars marks her FreeFlow calendar native, the Radicale ones not',annNative?.role==='owner'&&annNative.account===ANN_ADDR&&r.v.calendars.find((c)=>c.name==='Work')?.native===false,JSON.stringify(r.v.calendars).slice(0,220));
r=await call(BT,'list_calendars',{});const bobNative=r.v.calendars?.[0];
t('native: Bob\'s one calendar is his native default',r.v.calendars?.length===1&&bobNative.native===true&&bobNative.default===true&&bobNative.role==='owner',JSON.stringify(r.v).slice(0,200));

// Ann books with Bob: on her FreeFlow calendar (not the Radicale default), Bob scheduled by object call.
r=await call(T,'create_event',{summary:`Sync ${tag}`,start:'2026-12-03T15:00:00Z',end:'2026-12-03T16:00:00Z',attendees:[`Bob <${BOB_ADDR}>`]});
const sync=r.v.created;
t('native: create_event defaults to her FreeFlow calendar and schedules Bob',sync?.calendar?.id===annNative?.id&&sync.calendar.native===true&&JSON.stringify(r.v.scheduled_to_members)===JSON.stringify([BOB_ADDR])&&!r.v.emailed,JSON.stringify(r.v).slice(0,240));
r=await call(BT,'list_events',{from:'2026-12-01T00:00:00Z',to:'2026-12-08T00:00:00Z'});const bobCopy=(r.v.events??[]).find((e)=>e.summary===`Sync ${tag}`);
t('native: Bob\'s calendar has it, needs-action',bobCopy?.my_response==='needs-action'&&bobCopy.calendar?.id===bobNative?.id,JSON.stringify(r.v).slice(0,200));
r=await call(BT,'update_event',{id:bobCopy?.id,summary:'Mine now'});t('native: Bob cannot change Ann\'s event (not_organizer, in words)',r.isError&&/Only the organizer/.test(r.text)&&/respond_to_event/.test(r.text),r.text);
r=await call(BT,'respond_to_event',{id:bobCopy?.id,response:'accepted'});t('native: Bob accepts; Ann hears it by object call',r.v.organizer_told==='server',JSON.stringify(r.v).slice(0,160));

// Free time for Ann and Bob, around the event just made.
r=await call(T,'find_free_time',{duration_minutes:60,from:'2026-12-03T13:00:00Z',to:'2026-12-03T19:00:00Z',attendees:[BOB_ADDR],working_hours:null});
const fs2=r.v.slots??[];
t('native: find_free_time for Ann and Bob avoids it, Bob read from his object',fs2.length>=1&&!fs2.some((x)=>x.start<'2026-12-03T16:00:00.000Z'&&x.end>'2026-12-03T15:00:00.000Z')&&JSON.stringify(r.v.members)===JSON.stringify([BOB_ADDR])&&r.v.unknown?.length===0,JSON.stringify(r.v).slice(0,240));

// Ann shares her FreeFlow calendar with Bob as viewer, then stops.
r=await call(T,'share_calendar',{calendar_id:annNative?.id,principal:{account:BOB_ADDR},role:'viewer'});
t('native: share_calendar with Bob by address, viewer',r.v.shared?.role==='viewer'&&/^account:/.test(r.v.shared.principal)&&r.v.grants?.length===1,JSON.stringify(r.v).slice(0,200));
r=await call(T,'share_calendar',{calendar_id:annNative?.id,principal:{account:'nobody@else.test'},role:'viewer'});t('native: an address outside the organization is refused',r.isError&&/not a member/.test(r.text),r.text);
r=await call(BT,'list_calendars',{});const seen=r.v.calendars?.find((c)=>c.id===annNative?.id);
t('native: Bob\'s list_calendars shows it, role viewer',seen?.shared===true&&seen.role==='viewer'&&seen.read_only===true,JSON.stringify(r.v.calendars).slice(0,220));
r=await call(BT,'list_shared_calendars',{});t('native: and list_shared_calendars',r.v.calendars?.length===1&&r.v.calendars[0].id===annNative?.id,JSON.stringify(r.v).slice(0,160));
r=await call(BT,'list_events',{from:'2026-12-01T00:00:00Z',to:'2026-12-08T00:00:00Z',calendars:[bobNative?.id,annNative?.id]});
t('native: Bob reads hers beside his own (forwarded)',(r.v.events??[]).filter((e)=>e.summary===`Sync ${tag}`).map((e)=>e.calendar?.id).sort().join()===[annNative?.id,bobNative?.id].sort().join(),JSON.stringify((r.v.events??[]).map((e)=>e.calendar)).slice(0,200));
r=await call(BT,'create_event',{summary:'By Bob',start:'2026-12-04T15:00:00Z',end:'2026-12-04T16:00:00Z',calendar_id:annNative?.id});t('native: a viewer cannot create on it (forbidden, in words)',r.isError&&/role/.test(r.text),r.text);
r=await call(T,'unshare_calendar',{calendar_id:annNative?.id,principal:{account:BOB_ADDR}});t('native: unshare_calendar',r.v.grants?.length===0,JSON.stringify(r.v).slice(0,160));
r=await call(BT,'list_calendars',{});t('native: Bob no longer sees it',!r.v.calendars?.some((c)=>c.id===annNative?.id),JSON.stringify(r.v.calendars).slice(0,160));

// delete_event on /mcp runs (its destructive annotation is the client's to heed); Bob's copy is cancelled.
r=await call(T,'delete_event',{id:sync?.id});t('native: delete_event on /mcp, Bob\'s copy cancelled',!r.isError&&JSON.stringify(r.v.cancelled_for_members)===JSON.stringify([BOB_ADDR]),JSON.stringify(r.v).slice(0,200));
r=await call(BT,'get_event',{id:bobCopy?.id});t('native: Bob\'s copy shows cancelled',r.v.event?.status==='cancelled',JSON.stringify(r.v).slice(0,160));
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
