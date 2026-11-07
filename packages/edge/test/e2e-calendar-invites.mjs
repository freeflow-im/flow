// End-to-end check of invitations across Mail and Calendar (docs/specs/calendar.md §14: /v1/calendar/invites*, iMIP through
// the person's mail account), through the Worker, a person's Calendar and Mail objects, Radicale (a calendar server that does
// not schedule, so answers and invitations go by email) and GreenMail (SMTP 127.0.0.1:3025, IMAP 3143, any password; it makes
// a mailbox for any address it receives mail for):
//   docker run -d --name flow-radicale -p 5232:5232 tomsquest/docker-radicale     (as test/e2e-calendar.mjs)
//   docker run -d --name flow-greenmail ... greenmail/standalone                  (as test/e2e-mail.mjs)
// and a local `wrangler dev` started as test/e2e.mjs says (its .dev.vars), on port 18799 (B= for another), with both the
// mail's and the calendar's insecure dev modes on:
//   npx wrangler dev --port 18799 --local --enable-containers=false --var PORTED_HOSTS:edge.freeflow.im,localhost \
//     --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18799 \
//     --var MAIL_ALLOW_INSECURE:1 --var CALENDAR_ALLOW_INSECURE:1 > /tmp/edge-invites.log 2>&1 &
//   node test/e2e-calendar-invites.mjs /tmp/edge-invites.log
// Restart wrangler after editing the server (its hot reload has served a stale bundle). The person's mail account and calendar
// account share one address, as they would for a real person. "Ann", the organizer, sends her invitation and cancellation
// straight into GreenMail's SMTP (with nodemailer's icalEvent: Google's shape, a text/calendar alternative and invite.ics), and
// her mailbox is read straight over IMAP to see the answer arrive.
import fs from 'node:fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import PostalMime from 'postal-mime';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18799';
const DAV=process.env.DAV??'http://127.0.0.1:5232';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,200):''));};
const api=async(tok,m,p,b,h={})=>{const r=await fetch(B+p,{method:m,headers:{...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':'application/json'}:{}),...h},body:b===undefined?undefined:JSON.stringify(b)});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const USER=`inv-${tag}`, ME=`${USER}@test.local`, ANN=`ann-${tag}@test.local`, BO=`bo-${tag}@test.local`, CHEN=`chen-${tag}@test.local`;
const dav=(m,path,body,h={})=>fetch(DAV+path,{method:m,headers:{authorization:'Basic '+Buffer.from(USER+':x').toString('base64'),...h},body});
const enc=encodeURIComponent;
const smtp=nodemailer.createTransport({host:'127.0.0.1',port:3025,secure:false,ignoreTLS:true,auth:{user:ANN,pass:'x'}});
const unfold=s=>s.replace(/\r?\n[ \t]/g,'');
/** The messages of a GreenMail mailbox, read straight over IMAP and parsed. */
async function mailbox(address){const c=new ImapFlow({host:'127.0.0.1',port:3143,secure:false,doSTARTTLS:false,auth:{user:address,pass:'x'},logger:false});await c.connect();try{const out=[];const lock=await c.getMailboxLock('INBOX');try{for await(const m of c.fetch('1:*',{source:true}))out.push(await PostalMime.parse(m.source));}catch{}finally{lock.release()}return out}finally{await c.logout()}}
async function waitFor(fn,ms=15000){const end=Date.now()+ms;for(;;){const v=await fn();if(v||Date.now()>end)return v;await sleep(400);}}
const ics=(...lines)=>['BEGIN:VCALENDAR','PRODID:-//Google Inc//Google Calendar 70.9054//EN','VERSION:2.0','CALSCALE:GREGORIAN',...lines,'END:VCALENDAR',''].join('\r\n');
const UID=`plan-${tag}@google.com`;
const event=(seq,status,partstat='NEEDS-ACTION')=>['BEGIN:VEVENT','DTSTART:20261112T150000Z','DTEND:20261112T160000Z','DTSTAMP:20261105T120000Z',`ORGANIZER;CN=Ann Lee:mailto:${ANN}`,`UID:${UID}`,
  `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Ann Lee:mailto:${ANN}`,`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=${partstat};RSVP=TRUE;CN=${ME}:mailto:${ME}`,
  `SEQUENCE:${seq}`,`STATUS:${status}`,`SUMMARY:Planning ${tag}`,'LOCATION:Room 4','END:VEVENT'];
const send=(subject,method,body)=>smtp.sendMail({from:{name:'Ann Lee',address:ANN},to:ME,subject,text:`${subject}\n`,icalEvent:{method,content:body}});

const A=await signup(`invites-${tag}@example.com`,'Scott'),Bo=await signup(`invites-other-${tag}@example.com`,'Bo');
t('sign up',A.token&&Bo.token);
// Mail and calendars are an account's (platform.md §3.6): each person gets an organization.
const org=async(u,n)=>(await api(u.token,'POST','/v1/workspaces',{name:`${n} ${tag}`,slug:`${n.toLowerCase()}-${tag}`})).j?.id;
t('each with an organization',!!(await org(A,'Invann'))&&!!(await org(Bo,'Invbo')));

// ---- the person's mail account and calendar account, one address
const server=(port)=>({host:'127.0.0.1',port,security:'none'});
let r=await api(A.token,'POST','/v1/mail/accounts',{email:ME,displayName:'Scott Persinger',password:'x',imap:server(3143),smtp:server(3025)});
t('connect the mail account (GreenMail)',r.s===201&&r.j.account?.id,r.s+' '+JSON.stringify(r.j).slice(0,160));
const MACC=r.j.account?.id; const P=`/v1/mail/accounts/${MACC}`;
const CAL=`/${USER}/cal-${tag}/`;
const mk=`<?xml version="1.0" encoding="utf-8"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>Work</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>`;
let res=await dav('MKCALENDAR',CAL,mk,{'content-type':'application/xml'});t('Radicale: make the calendar',res.status===201,res.status);
r=await api(A.token,'POST','/v1/calendar/accounts',{email:ME,displayName:'Scott Persinger',password:'x',server:{url:DAV+'/',username:USER}});
t('connect the calendar account (Radicale)',r.s===201&&r.j.account?.id,r.s+' '+JSON.stringify(r.j).slice(0,160));
const work=r.j.calendars?.find(c=>c.name==='Work');
// The person's own native calendar (phase 4.1) was the default; this run puts invitations on the Radicale one.
r=await api(A.token,'PATCH',`/v1/calendar/calendars/${work?.id}`,{isDefault:true});t('its calendar, made the default one',r.j.calendar?.isDefault,JSON.stringify(r.j));

// ---- an invitation arrives
await send(`Invitation: Planning ${tag}`,'REQUEST',ics('METHOD:REQUEST',...event(0,'CONFIRMED')));
const inbox=async(subject)=>waitFor(async()=>{const x=await api(A.token,'GET',`${P}/messages?folder=INBOX&limit=30`);return x.j.messages?.find(m=>m.subject===subject)});
let msg=await inbox(`Invitation: Planning ${tag}`);
t('the invitation is in the inbox',!!msg,JSON.stringify(msg).slice(0,160));
let cal=msg?.attachments?.find(a=>a.mimeType==='text/calendar');
t('with a text/calendar part and invite.ics',cal&&msg.attachments.some(a=>a.filename==='invite.ics'),JSON.stringify(msg?.attachments));
const inviteBody=(m,part,extra={})=>({account:MACC,messageId:`${MACC}:INBOX:${m.uid}`,part,...extra});
r=await api(A.token,'POST','/v1/calendar/invites',inviteBody(msg,cal.index));
t('the card: an invitation, not on the calendar yet',r.s===200&&r.j.action==='request'&&r.j.onCalendar===null&&r.j.organizerIsMe===false,r.s+' '+JSON.stringify(r.j).slice(0,200));
t('what, when, where, who',r.j.event?.summary===`Planning ${tag}`&&r.j.event.start==='2026-11-12T15:00:00.000Z'&&r.j.event.location==='Room 4'&&r.j.event.organizer?.email===ANN&&r.j.event.attendees?.find(a=>a.self)?.email===ME&&r.j.event.myResponse==='needs-action',JSON.stringify(r.j.event).slice(0,200));
t('the calendars it can go on: the Radicale one, the default, and the native one',r.j.calendars?.length===2&&r.j.calendars.find(c=>c.isDefault)?.id===work.id&&r.j.calendars.some(c=>/^n\./.test(c.id)),JSON.stringify(r.j.calendars));
const ics2=msg.attachments.find(a=>a.filename==='invite.ics');
r=await api(A.token,'POST','/v1/calendar/invites',inviteBody(msg,ics2.index));t('the .ics file reads the same',r.j.action==='request'&&r.j.event?.summary===`Planning ${tag}`,JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST','/v1/calendar/invites',{account:MACC,messageId:{folder:'INBOX',uid:msg.uid},part:cal.index});t('the message named by folder and UID',r.j.action==='request');
r=await api(Bo.token,'POST','/v1/calendar/invites',inviteBody(msg,cal.index));t("someone else cannot read it",r.s===404,r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'POST','/v1/calendar/invites',inviteBody(msg,cal.index,{messageId:`other:INBOX:${msg.uid}`}));t('a message of another account is bad_request',r.s===400,r.s);
r=await api(A.token,'POST','/v1/calendar/invites',inviteBody(msg,9));t('a part that is not there is not_found',r.s===404,r.s+' '+JSON.stringify(r.j));

// ---- accept it: on Radicale with PARTSTAT=ACCEPTED, and the REPLY by email to Ann
r=await api(A.token,'POST','/v1/calendar/invites/respond',inviteBody(msg,cal.index,{response:'accepted'}));
t('accept: on the calendar, going, the answer emailed',r.s===200&&r.j.onCalendar?.calendarId===work.id&&r.j.onCalendar.myResponse==='accepted'&&r.j.replied==='email',r.s+' '+JSON.stringify(r.j).slice(0,200));
const href=`${CAL}${enc(UID)}.ics`;
res=await dav('GET',href);let raw=unfold(await res.text());
t('Radicale has it, with PARTSTAT=ACCEPTED for the person and no METHOD',res.status===200&&new RegExp(`PARTSTAT=ACCEPTED[^\\r\\n]*mailto:${ME}`).test(raw)&&!/^METHOD/m.test(raw),res.status+' '+raw.slice(0,160));
let annMail=await waitFor(async()=>(await mailbox(ANN)).find(m=>m.subject?.startsWith(`Accepted: Planning ${tag}`)));
t('Ann receives the REPLY',!!annMail&&annMail.from?.address===ME&&annMail.text?.includes(`Scott Persinger has accepted the invitation to Planning ${tag}`),annMail?.subject);
const replyPart=annMail?.attachments?.find(a=>a.mimeType==='text/calendar');
const replyIcs=replyPart?unfold(new TextDecoder().decode(replyPart.content)):'';
t('its text/calendar is METHOD:REPLY with only the person\'s PARTSTAT=ACCEPTED',/^METHOD:REPLY/m.test(replyIcs)&&(replyIcs.match(/^ATTENDEE/gm)??[]).length===1&&new RegExp(`PARTSTAT=ACCEPTED[^\\r\\n]*mailto:${ME}`).test(replyIcs),replyIcs.slice(0,200));
r=await api(A.token,'POST','/v1/calendar/invites',inviteBody(msg,cal.index));t('the card now: on your calendar, going',r.j.onCalendar?.myResponse==='accepted',JSON.stringify(r.j.onCalendar));
r=await api(A.token,'GET','/v1/calendar/events?from=2026-11-12T00:00:00Z&to=2026-11-13T00:00:00Z');t('and in Calendar\'s window',r.j.events?.some(e=>e.summary===`Planning ${tag}`&&e.myResponse==='accepted'));
r=await api(A.token,'POST','/v1/calendar/invites/respond',inviteBody(msg,cal.index,{response:'tentative'}));t('change the answer to maybe',r.j.onCalendar?.myResponse==='tentative'&&r.j.replied==='email',JSON.stringify(r.j).slice(0,160));
annMail=await waitFor(async()=>(await mailbox(ANN)).find(m=>m.subject?.startsWith('Tentatively accepted:')));t('Ann receives that too',!!annMail);

// ---- Ann replies to an event the person organized (a REPLY in the person's inbox): the card says who answered
await smtp.sendMail({from:{name:'Bo',address:BO},to:ME,subject:`Accepted: Lunch ${tag}`,text:'Bo accepted\n',icalEvent:{method:'REPLY',content:ics('METHOD:REPLY','BEGIN:VEVENT',`UID:lunch-${tag}`,'DTSTART:20261113T170000Z','DTEND:20261113T180000Z','DTSTAMP:20261105T120000Z',`ORGANIZER:mailto:${ME}`,`ATTENDEE;PARTSTAT=ACCEPTED;CN=Bo:mailto:${BO}`,'SUMMARY:Lunch','END:VEVENT')}});
msg=await inbox(`Accepted: Lunch ${tag}`);
r=await api(A.token,'POST','/v1/calendar/invites',inviteBody(msg,msg.attachments.find(a=>a.mimeType==='text/calendar').index));
t('a reply: who answered, to the person\'s own event',r.j.action==='reply'&&r.j.reply?.email===BO&&r.j.reply.response==='accepted'&&r.j.organizerIsMe===true,JSON.stringify(r.j).slice(0,200));

// ---- Ann cancels: the card offers Remove, which takes it off Radicale
await send(`Cancelled: Planning ${tag}`,'CANCEL',ics('METHOD:CANCEL',...event(1,'CANCELLED')));
msg=await inbox(`Cancelled: Planning ${tag}`);
cal=msg?.attachments?.find(a=>a.mimeType==='text/calendar');
r=await api(A.token,'POST','/v1/calendar/invites',inviteBody(msg,cal.index));
t('the card: a cancellation of an event on the calendar',r.j.action==='cancel'&&r.j.onCalendar?.calendarId===work.id&&r.j.event?.status==='cancelled',JSON.stringify(r.j).slice(0,200));
r=await api(A.token,'POST','/v1/calendar/invites/respond',inviteBody(msg,cal.index,{response:'accepted'}));t('a cancellation is not answered',r.s===400,r.s);
r=await api(A.token,'POST','/v1/calendar/invites/cancel',inviteBody(msg,cal.index));t('remove it from the calendar',r.s===200&&r.j.removed===true&&r.j.onCalendar===null,r.s+' '+JSON.stringify(r.j).slice(0,160));
res=await dav('GET',href);t('it is gone from Radicale',res.status===404,res.status);
r=await api(A.token,'POST','/v1/calendar/invites/cancel',inviteBody(msg,cal.index));t('a second time: nothing to remove',r.j.removed===false);

// ---- the person organizes: an event with a guest made here invites them by email, and deleting it cancels
r=await api(A.token,'POST','/v1/calendar/events',{calendarId:work.id,summary:`Review ${tag}`,start:'2026-11-16T15:00:00Z',end:'2026-11-16T15:30:00Z',timezone:'UTC',attendees:[{email:BO,name:'Bo'}]});
t('create an event with a guest: the invitation sent',r.s===201&&r.j.invitationsSent===true,r.s+' '+JSON.stringify(r.j).slice(0,200));
const REVIEW=r.j.event;
let boMail=await waitFor(async()=>(await mailbox(BO)).find(m=>m.subject?.startsWith(`Invitation: Review ${tag}`)));
let boIcs=boMail?unfold(new TextDecoder().decode(boMail.attachments.find(a=>a.mimeType==='text/calendar').content)):'';
t('Bo receives the REQUEST from the person\'s address',boMail?.from?.address===ME&&/^METHOD:REQUEST/m.test(boIcs)&&boIcs.includes(`ORGANIZER;CN=Scott Persinger:mailto:${ME}`)&&boIcs.includes(`mailto:${BO}`),boMail?.subject+' '+boIcs.slice(0,120));
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(REVIEW.id)}`,{location:'Room 7'});t('a change: the update sent',r.s===200&&r.j.invitationsSent===true,r.s+' '+JSON.stringify(r.j).slice(0,160));
boMail=await waitFor(async()=>(await mailbox(BO)).find(m=>m.subject?.startsWith(`Updated invitation: Review ${tag}`)));t('Bo receives the update',!!boMail&&boMail.text?.includes('Where: Room 7'),boMail?.subject);
r=await api(A.token,'PATCH',`/v1/calendar/events/${enc(REVIEW.id)}`,{reminders:[{minutes:5}]});t('a change to the person\'s own reminders sends nothing',r.s===200&&r.j.invitationsSent===undefined,JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'DELETE',`/v1/calendar/events/${enc(REVIEW.id)}`);t('delete it: the cancellation sent',r.s===200&&r.j.invitationsSent===true,r.s+' '+JSON.stringify(r.j));
boMail=await waitFor(async()=>(await mailbox(BO)).find(m=>m.subject?.startsWith(`Cancelled: Review ${tag}`)));
boIcs=boMail?unfold(new TextDecoder().decode(boMail.attachments.find(a=>a.mimeType==='text/calendar').content)):'';
t('Bo receives the CANCEL',/^METHOD:CANCEL/m.test(boIcs)&&boIcs.includes('STATUS:CANCELLED'),boIcs.slice(0,120));
r=await api(A.token,'POST','/v1/calendar/events',{calendarId:work.id,summary:`Alone ${tag}`,start:'2026-11-16T17:00:00Z',end:'2026-11-16T17:30:00Z'});t('an event without guests sends nothing',r.s===201&&r.j.invitationsSent===undefined,JSON.stringify(r.j).slice(0,120));

// ---- an RSVP from Calendar's own card, on an invitation another app put on Radicale: the organizer told by email
const CU=`sync-${tag}`;
res=await dav('PUT',`${CAL}${CU}.ics`,['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//e2e//EN','BEGIN:VEVENT',`UID:${CU}`,'DTSTAMP:20261105T120000Z','DTSTART:20261117T150000Z','DTEND:20261117T160000Z','SUMMARY:Sync',`ORGANIZER;CN=Chen:mailto:${CHEN}`,`ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${ME}`,'END:VEVENT','END:VCALENDAR',''].join('\r\n'),{'content-type':'text/calendar'});
await api(A.token,'POST','/v1/calendar/debug/sync');
r=await api(A.token,'POST',`/v1/calendar/events/${enc(`${work.id}:${CU}`)}/respond`,{response:'declined'});
t('decline in Calendar: the answer emailed',r.s===200&&r.j.event?.myResponse==='declined'&&r.j.replied==='email',r.s+' '+JSON.stringify(r.j).slice(0,160));
const chenMail=await waitFor(async()=>(await mailbox(CHEN)).find(m=>m.subject?.startsWith('Declined: Sync')));t('Chen receives the REPLY',!!chenMail,chenMail?.subject);

// ---- the log: one line per request, no address, summary or id in them
const lines=fs.readFileSync(log,'utf8').split('\n').filter(l=>/\[calendar\] POST \/v1\/calendar\/invites/.test(l));
t('timing lines for the invite routes',lines.some(l=>/POST \/v1\/calendar\/invites 200/.test(l))&&lines.some(l=>/POST \/v1\/calendar\/invites\/respond 200/.test(l))&&lines.some(l=>/POST \/v1\/calendar\/invites\/cancel 200/.test(l)),lines.slice(-3).join(' | '));
t('with no address, summary or id',!lines.some(l=>l.includes(tag)||l.includes('@')),lines.find(l=>l.includes(tag)||l.includes('@')));

smtp.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
