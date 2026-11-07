// End-to-end check of Chat through the Worker, the directory and an organization object, against a local `wrangler dev`:
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars; mkdir -p public
//   npx wrangler dev --port 18796 --local --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none \
//     --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18796 \
//     --var LIVEKIT_API_KEY:devkey --var LIVEKIT_API_SECRET:devsecret-devsecret-devsecret-00 --var LIVEKIT_URL:wss://dev.livekit.invalid \
//     --var FLOW_UNFURL_ALLOW_HOSTS:localhost > /tmp/edge.log 2>&1 &
// (FLOW_UNFURL_ALLOW_HOSTS lets the link preview check fetch the test page this script serves on localhost.)
//   node test/e2e.mjs /tmp/edge.log
// The wake-job checks want the flow-jobs queue's first check soon: add --var JOBS_ACK_DELAY_SECONDS:2.
// The domain checks serve a DNS-over-HTTPS stub on DOH_PORT (default 18897): add --var DNS_RESOLVER_URL:http://localhost:18897/dns-query.
// The mail provider's records and DKIM want the fake provider: add --var MAIL_PROVIDER:fake.
// It reads signup links and the dev push driver's lines from the Worker's log, because local mail and pushes go there.
// Without the LIVEKIT_* vars the huddle checks expect huddles to be off instead.
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
const log=process.argv[2]; const B='http://localhost:18796', WS='ws://localhost:18796';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const api=async(tok,m,p,b,h={})=>{const r=await fetch(B+p,{method:m,headers:{...h,...(tok?{authorization:'Bearer '+tok}:{}),...(b?{'content-type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});let j;const x=await r.text();try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const link=async(re,tries=20)=>{for(let i=0;i<tries;i++){const m=[...fs.readFileSync(log,'utf8').matchAll(re)].at(-1);if(m)return m;await sleep(250)}};
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const A=await signup('ann@example.com','Ann'),Bo=await signup('bob@example.com','Bob');t('two sign-ups',A.token&&Bo.token);
let r=await api(A.token,'POST','/v1/workspaces',{name:'Locked In',slug:'locked-in'});t('create organization',r.s===201,JSON.stringify(r.j).slice(0,110));const W=r.j.id;
r=await api(A.token,'GET','/v1/me/workspaces');t('me/workspaces fans out',r.j.workspaces?.length===1&&r.j.workspaces[0].id===W,JSON.stringify(r.j).slice(0,110));
r=await api(Bo.token,'GET','/v1/me/workspaces');t('stranger has none',r.j.workspaces?.length===0);
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/channels`);t('stranger refused channels',r.s===403||r.s===404,r.s);
r=await api(A.token,'GET',`/v1/workspaces/${W}/channels`);t('default channel',r.s===200&&(r.j.channels??r.j).length>=1,JSON.stringify(r.j).slice(0,90));const gen=(r.j.channels??r.j)[0];
r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{email:'bob@example.com'});t('invite',r.s===201,JSON.stringify(r.j).slice(0,110));const inv=r.j;
const tokm=[null,(inv.inviteUrl??'').split('/').pop()];t('invite carries link',!!tokm[1],inv.inviteUrl);
r=await api(Bo.token,'POST','/v1/invites/accept',{token:tokm[1]});t('accept by token',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(Bo.token,'GET','/v1/me/workspaces');t('membership reached directory',r.j.workspaces?.length===1);
r=await api(Bo.token,'GET','/v1/me');t('the membership made an account with an address',r.j.accounts?.length===1&&r.j.accounts[0].address.endsWith('@locked-in.freeflow.im'),JSON.stringify(r.j.accounts));
const sock=(tok)=>new Promise((res,rej)=>{const ws=new WebSocket(`${WS}/v1/ws?workspace=${W}`);const ev=[];ws.onopen=()=>ws.send(JSON.stringify({op:'auth',token:tok}));ws.onmessage=e=>{const f=JSON.parse(e.data);if(f.op==='hello')res({ws,ev,hello:f});if(f.op==='event')ev.push(f.event);if(f.op==='error')rej(new Error(f.message));};ws.onerror=()=>rej(new Error('ws'));setTimeout(()=>rej(new Error('ws timeout')),6000)});
const sa=await sock(A.token),sb=await sock(Bo.token);t('sockets hello',sa.hello.heartbeat==='client');
await sleep(200);t('presence reaches Ann',sa.ev.some(e=>e.type==='presence'&&e.data.userId===Bo.user.id));
r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'hello everyone'});t('send by channel id',r.s===201,JSON.stringify(r.j).slice(0,100));const M=r.j;
await sleep(250);t('Bob gets it live',sb.ev.some(e=>e.type==='message.created'&&e.data?.id===M.id));
// ---- the event log (platform.md §5.2): the same events, kept, read by cursor
r=await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=0&limit=500`);{const e=r.j.events?.find(x=>x.type==='chat.message.created'&&x.data?.id===M.id);t('the event log has the message for Bob',r.s===200&&e?.seq>0&&e.organizationId===W&&!!e.actor&&e.channelId===gen.id,JSON.stringify(e??r.j).slice(0,160));t('no presence in the log',!r.j.events?.some(x=>x.type==='chat.presence'));}
const before=sa.ev.length;
r=await api(Bo.token,'PUT',`/v1/messages/${M.id}/reactions/${encodeURIComponent('👍')}`);t('react by message id',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'in a thread',threadRootId:M.id});t('thread reply',r.s===201);
r=await api(A.token,'GET',`/v1/messages/${M.id}/thread`);t('thread read',r.s===200,JSON.stringify(r.j).slice(0,80));
r=await api(Bo.token,'GET',`/v1/channels/${gen.id}/messages`);t('list decrypts',r.j.messages?.[0]?.body==='hello everyone',JSON.stringify(r.j.messages?.[0]?.body));
r=await api(A.token,'POST',`/v1/workspaces/${W}/channels`,{name:'secret',isPrivate:true});t('private channel',r.s===201);const P=r.j;
sb.ev.length=0;
r=await api(A.token,'POST',`/v1/channels/${P.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'for me only'});t('private send',r.s===201);
await sleep(250);t('Bob does NOT get private message',!sb.ev.some(e=>e.channelId===P.id),sb.ev.map(e=>e.type).join(','));t('Ann does',sa.ev.some(e=>e.channelId===P.id&&e.type==='message.created'));
r=await api(Bo.token,'GET',`/v1/channels/${P.id}/messages`);t('Bob refused private list',r.s>=400,r.s);
r=await api(A.token,'GET',`/v1/events?workspace=${W}&since=0&limit=500&channel=${P.id}`);t('the private channel\'s events are in Ann\'s log',r.j.events?.some(e=>e.type==='chat.message.created'&&e.channelId===P.id),JSON.stringify(r.j).slice(0,120));
r=await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=0&limit=500`);t('and not in Bob\'s',r.s===200&&r.j.events.length>0&&!r.j.events.some(e=>e.channelId===P.id),r.j.events?.length);
{const nx=r.j.next;r=await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=${nx}&limit=500`);t('since=next: nothing new',r.s===200&&r.j.events.length===0&&r.j.next===nx,JSON.stringify(r.j).slice(0,120));}
r=await api(A.token,'GET',`/v1/events?workspace=${W}&since=0&types=chat.reaction.*`);t('a type pattern',r.j.events?.length>=1&&r.j.events.every(e=>e.type.startsWith('chat.reaction.')),JSON.stringify(r.j.events?.map(e=>e.type)));
{const C=await signup('dee@example.com','Dee');r=await api(C.token,'GET','/v1/events?since=0');t('no account: 403 no_account',r.s===403&&r.j.error?.code==='no_account',r.s+' '+JSON.stringify(r.j).slice(0,100));}
// ---- artifacts on grants (platform phase 3.4): Ann's app in #secret is nobody else's until she shares it; a viewer opens it by id
{r=await api(A.token,'GET',`/v1/workspaces/${W}/members`);const bobAcct=(r.j.members??[]).find(m=>m.userId===Bo.user.id)?.accountId;
 r=await api(A.token,'POST','/v1/artifacts',{channelId:P.id,url:'https://secret-app.example/',name:'Secret plan',app:true});const SA=r.j;t('Ann pins an app in #secret',r.s===201&&!!SA.id&&!!SA.appSecret,r.s+' '+JSON.stringify(r.j).slice(0,100));
 const AREF=`${W}/chat/artifact/${SA.id}`;
 r=await api(Bo.token,'GET',`/v1/artifacts/${SA.id}`);t('the artifact is 404 for Bob by id',r.s===404,r.s);
 r=await api(Bo.token,'POST',`/v1/artifacts/${SA.id}/app-token`);t('the app-token mint refuses a non-member',r.s===404,r.s);
 r=await api(Bo.token,'PUT',`/v1/artifacts/${SA.id}/grants`,{principal:`account:${bobAcct}`,role:'viewer'});t('Bob cannot share it with himself',r.s===404,r.s);
 r=await api(A.token,'PUT',`/v1/artifacts/${SA.id}/grants`,{principal:`link:${'x'.repeat(32)}`,role:'viewer'});t('a link grant is not offered yet',r.s===400&&r.j.error?.code==='not_supported',r.s+' '+JSON.stringify(r.j).slice(0,100));
 r=await api(A.token,'PUT',`/v1/artifacts/${SA.id}/grants`,{principal:`account:${bobAcct}`,role:'viewer'});t('Ann grants Bob viewer',r.s===200&&r.j.role==='owner'&&(r.j.grants??[]).some(g=>g.principal===`account:${bobAcct}`&&g.role==='viewer'),r.s+' '+JSON.stringify(r.j).slice(0,140));
 r=await api(Bo.token,'GET',`/v1/artifacts/${SA.id}`);t('Bob opens it by id',r.s===200&&r.j.id===SA.id&&!r.j.appSecret,r.s+' '+JSON.stringify(r.j).slice(0,100));
 r=await api(Bo.token,'GET',`/v1/artifacts/${SA.id}/grants`);t('and reads its grants, as a viewer',r.s===200&&r.j.role==='viewer',r.s+' '+JSON.stringify(r.j).slice(0,100));
 r=await api(Bo.token,'GET',`/v1/workspaces/${W}/artifacts`);t('the listing stays per channel',r.s===200&&!(r.j.artifacts??[]).some(a=>a.id===SA.id),r.s);
 let dmLine=null;for(let i=0;i<15&&!dmLine;i++){await sleep(200);r=await api(Bo.token,'GET',`/v1/me/notifications?workspace=${W}`);dmLine=(r.j.notifications??[]).find(n=>(n.message?.body??'').includes(`/?open=artifact%3A${SA.id}`))}
 t('Bob has the file_shared DM line, with the artifact\'s link',/^Ann shared Secret plan with you\n\S+\/\?open=artifact%3A/.test(dmLine?.message?.body??'')&&dmLine?.message?.systemKind==='file_shared',JSON.stringify(dmLine??r.j).slice(0,160));
 r=await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=0&types=sharing.granted`);t('and the sharing.granted event',(r.j.events??[]).some(e=>e.data?.ref===AREF&&e.data?.kind==='artifact'&&e.data?.url===`/?open=artifact%3A${SA.id}`),JSON.stringify(r.j).slice(0,160));
 r=await api(Bo.token,'GET',`/v1/workspaces/${W}/shared-with-me`);t('shared-with-me lists the artifact',(r.j.shares??[]).some(x=>x.ref===AREF&&x.title==='Secret plan'),JSON.stringify(r.j).slice(0,140));
 r=await api(Bo.token,'DELETE',`/v1/artifacts/${SA.id}`);t('Bob cannot delete it',r.s===403,r.s);
 r=await api(Bo.token,'POST',`/v1/artifacts/${SA.id}/app-token`);t('nor mint an app token as a viewer',r.s===403,r.s);
 r=await api(A.token,'DELETE',`/v1/artifacts/${SA.id}/grants/${encodeURIComponent('account:'+bobAcct)}`);t('Ann revokes',r.s===200&&(r.j.grants??[]).length===0,r.s+' '+JSON.stringify(r.j).slice(0,100));
 r=await api(Bo.token,'GET',`/v1/artifacts/${SA.id}`);t('Bob gets 404 again',r.s===404,r.s);
 await sleep(500);r=await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=0&types=sharing.revoked`);t('and the sharing.revoked event',(r.j.events??[]).some(e=>e.data?.ref===AREF),JSON.stringify(r.j).slice(0,140));
 r=await api(A.token,'POST',`/v1/artifacts/${SA.id}/app-token`);t('Ann, a member, still mints',r.s===200&&!!r.j.token,r.s);}
// ---- subscriptions: durable consumers with a cursor, read by HTTP, long-polled with wait
{const head=(await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=0&limit=500`)).j;let nx=head.next;while(true){const p=(await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=${nx}&limit=500`)).j;if(!p.events.length){nx=p.next;break}nx=p.next}
 const SP=`/v1/events/subscriptions?workspace=${W}`,sp=(id,q='')=>`/v1/events/subscriptions/${id}?workspace=${W}${q}`;
 r=await api(Bo.token,'POST',SP,{name:'chat for Bob',filter:{types:['chat.*']}});const S=r.j.subscription;t('Bob subscribes to chat.*',r.s===201&&!!S?.id&&S.name==='chat for Bob',r.s+' '+JSON.stringify(r.j).slice(0,140));
 t('a new subscription starts at the head',S?.cursor===nx&&S?.delivery==='pull',S?.cursor+' vs '+nx);
 r=await api(Bo.token,'POST',SP,{name:'bad',filter:{kinds:['x']}});t('an unknown filter field is refused',r.s===400,r.s+' '+JSON.stringify(r.j).slice(0,100));
 r=await api(Bo.token,'GET',sp(S.id));t('nothing new yet: next is the head',r.s===200&&r.j.events.length===0&&r.j.next===nx,JSON.stringify(r.j).slice(0,120));
 const t0=Date.now();const waiting=api(Bo.token,'GET',sp(S.id,'&wait=5'));await sleep(400);
 r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'for the subscription'});const M2=r.j;
 r=await waiting;const got=r.j.events?.find(e=>e.type==='chat.message.created'&&e.data?.id===M2.id);t('a waiting read returns Ann\'s message within the wait',r.s===200&&!!got&&Date.now()-t0<4500,(Date.now()-t0)+'ms '+JSON.stringify(r.j).slice(0,140));
 t('and next is past it',r.j.next>=got?.seq,r.j.next);
 const next=r.j.next;r=await api(Bo.token,'POST',`/v1/events/subscriptions/${S.id}/ack?workspace=${W}`,{cursor:next});t('ack moves the cursor',r.s===200&&r.j.cursor===next,JSON.stringify(r.j));
 r=await api(Bo.token,'POST',`/v1/events/subscriptions/${S.id}/ack?workspace=${W}`,{cursor:1});t('and never back',r.j.cursor===next,JSON.stringify(r.j));
 r=await api(Bo.token,'GET',sp(S.id));t('after the ack a read is empty',r.s===200&&r.j.events.length===0,JSON.stringify(r.j).slice(0,120));
 const t1=Date.now();r=await api(Bo.token,'GET',sp(S.id,'&wait=2'));const dt=Date.now()-t1;t('wait=2 with nothing new answers empty after about two seconds',r.s===200&&r.j.events.length===0&&dt>=1800&&dt<4000,dt+'ms');
 r=await api(Bo.token,'GET',SP);t('Bob lists his subscriptions',r.j.subscriptions?.length===1&&r.j.subscriptions[0].id===S.id&&r.j.subscriptions[0].cursor===next,JSON.stringify(r.j).slice(0,140));
 r=await api(A.token,'POST',SP,{name:'Ann\'s',filter:{}});const SA=r.j.subscription;
 r=await api(Bo.token,'GET',sp(SA.id));t('Ann\'s subscription is 404 for Bob',r.s===404,r.s);
 r=await api(Bo.token,'POST',`/v1/events/subscriptions/${SA.id}/ack?workspace=${W}`,{cursor:1});t('and so is acking it',r.s===404,r.s);
 r=await api(Bo.token,'DELETE',sp(SA.id));t('and deleting it',r.s===404,r.s);
 r=await api(A.token,'GET',SP);t('Ann lists only hers',r.j.subscriptions?.length===1&&r.j.subscriptions[0].id===SA.id,JSON.stringify(r.j).slice(0,100));
 r=await api(A.token,'DELETE',sp(SA.id));t('Ann deletes hers',r.s===200&&r.j.ok===true,r.s);
 r=await api(A.token,'GET',sp(SA.id));t('then it is gone',r.s===404,r.s);
 const C=await signup('dee2@example.com','Dee');r=await api(C.token,'GET','/v1/events/subscriptions');t('subscriptions without an account: 403 no_account',r.s===403&&r.j.error?.code==='no_account',r.s);}
// ---- the socket is a consumer (§5.2, phase 2.3): `since` on auth replays the log, `cursor` frames mark it, `socket` subscriptions poke
{const sock2=(tok,since)=>new Promise((res,rej)=>{const ws=new WebSocket(`${WS}/v1/ws?workspace=${W}`);const fr=[];ws.onopen=()=>ws.send(JSON.stringify({op:'auth',token:tok,...(since!==undefined?{since}:{})}));ws.onmessage=e=>{const f=JSON.parse(e.data);fr.push(f);if(f.op==='hello')res({ws,fr});if(f.op==='error')rej(new Error(f.message));};ws.onerror=()=>rej(new Error('ws'));setTimeout(()=>rej(new Error('ws timeout')),6000)});
 const s0=await sock2(Bo.token,0);await sleep(600);
 const i=s0.fr.findIndex(f=>f.op==='event'&&f.event.type==='message.created'&&f.event.data?.id===M.id),ci=s0.fr.findIndex(f=>f.op==='cursor');
 t('since 0: the earlier message.created comes back with its seq',i>0&&s0.fr[i].seq>0&&s0.fr[i].event.channelId===gen.id&&s0.fr[i].event.workspaceId===W&&!!s0.fr[i].event.ts,JSON.stringify(s0.fr[i]??s0.fr.map(f=>f.op)).slice(0,160));
 t('then a cursor frame at or past it',ci>i&&s0.fr[ci].seq>=s0.fr[i]?.seq,JSON.stringify(s0.fr[ci]));
 const back=s0.fr.slice(0,ci).filter(f=>f.op==='event');
 t('the backlog is in seq order and carries no private channel of Ann\'s',back.every((f,k)=>typeof f.seq==='number'&&(k===0||back[k-1].seq<f.seq))&&!back.some(f=>f.event.channelId===P.id),back.length);
 t('no gap inside the window',!s0.fr.some(f=>f.op==='gap'));
 const head=s0.fr[ci]?.seq;const sh=await sock2(Bo.token,head);await sleep(500);
 t('since at the head: only the cursor frame',sh.fr.filter(f=>f.op==='event'&&f.seq!==undefined).length===0&&sh.fr.filter(f=>f.op==='cursor').length===1&&sh.fr.find(f=>f.op==='cursor').seq===head,JSON.stringify(sh.fr.map(f=>f.op+(f.seq??''))));
 const c0=sh.fr.length;
 r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'after the head'});const M3=r.j;await sleep(600);
 const live=sh.fr.slice(c0);const li=live.findIndex(f=>f.op==='event'&&f.event.data?.id===M3.id),lc=live.findIndex(f=>f.op==='cursor');
 t('a new message arrives live (no seq), then a cursor frame past the head',li>=0&&live[li].seq===undefined&&lc>li&&live[lc].seq>head,JSON.stringify(live.map(f=>f.op+(f.seq??''))));
 r=await api(Bo.token,'POST',`/v1/events/subscriptions?workspace=${W}`,{name:'poke me',filter:{types:['chat.*']},delivery:'socket'});const SS=r.j.subscription;
 t('Bob makes a socket subscription',r.s===201&&SS?.delivery==='socket',r.s+' '+JSON.stringify(r.j).slice(0,120));
 const c1=sh.fr.length,a1=sa.ev.length;
 r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'poke'});await sleep(800);
 t('Bob\'s socket is poked with the subscription\'s id',sh.fr.slice(c1).some(f=>f.op==='subscription'&&f.id===SS.id),JSON.stringify(sh.fr.slice(c1).map(f=>f.op)));
 r=await api(Bo.token,'GET',`/v1/events/subscriptions/${SS.id}?workspace=${W}`);t('and reading it returns the message',r.j.events?.some(e=>e.type==='chat.message.created'&&e.data?.body==='poke'),JSON.stringify(r.j).slice(0,120));
 const pokedAnn=await new Promise(res=>{const ws=new WebSocket(`${WS}/v1/ws?workspace=${W}`);const fr=[];ws.onopen=()=>ws.send(JSON.stringify({op:'auth',token:A.token}));ws.onmessage=e=>fr.push(JSON.parse(e.data));setTimeout(async()=>{await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'poke again'});setTimeout(()=>{ws.close();res(fr.some(f=>f.op==='subscription'))},800)},400)});
 t('Ann\'s socket is not poked for Bob\'s subscription',!pokedAnn);
 r=await api(Bo.token,'DELETE',`/v1/events/subscriptions/${SS.id}?workspace=${W}`);t('the socket subscription goes',r.s===200,r.s);
 s0.ws.close();sh.ws.close();void a1;}
const pong=await new Promise(res=>{sa.ws.addEventListener('message',e=>{if(JSON.parse(e.data).op==='pong')res(true)});sa.ws.send('{"op":"ping"}');setTimeout(()=>res(false),2000)});t('client ping answered',pong);
sa.ws.send(JSON.stringify({op:'typing',channelId:gen.id}));await sleep(200);t('typing relayed',sb.ev.some(e=>e.type==='typing'));
r=await api(null,'GET',`/v1/channels/${gen.id}/messages`);t('no session refused',r.s===401,r.s);
r=await api(A.token,'GET',`/v1/channels/00000000-0000-7000-8000-000000000000/messages`);t('unknown id 404',r.s===404,r.s);
sb.ws.close();await sleep(300);t('offline presence',sa.ev.some(e=>e.type==='presence'&&e.data.status==='offline'));
r=await api(A.token,'GET',`/v1/workspaces/${W}/members`);t('members join works',r.s===200,JSON.stringify(r.j).slice(0,100));
// ---- what names no organization
r=await api(null,'GET','/v1/client-info');t('client-info says one socket per organization',r.j.capabilities?.socketPerOrganization===true);
r=await api(null,'GET','/v1/config');t('config',r.s===200&&r.j.maxFileBytes>0);
r=await api(Bo.token,'POST','/v1/workspaces',{name:'Other',slug:'locked-in'});t('slug unique across organizations',r.s===409,r.s+' '+JSON.stringify(r.j).slice(0,80));
r=await api(Bo.token,'POST','/v1/workspaces',{name:'Other',slug:'locked-in-2'});t('second organization',r.s===201,r.s);const W2=r.j.id;
r=await api(Bo.token,'GET','/v1/me/workspaces');t('Bob sees both',r.j.workspaces?.length===2,r.j.workspaces?.length);
const sa2=sa.ev.length;
r=await api(Bo.token,'PATCH','/v1/me',{displayName:'Robert',title:'Builder'});t('profile edit',r.s===200&&r.j.displayName==='Robert',JSON.stringify(r.j).slice(0,80));
await sleep(250);t('reaches other members live',sa.ev.slice(sa2).some(e=>e.type==='user.updated'&&e.data.displayName==='Robert'));
r=await api(A.token,'GET',`/v1/workspaces/${W}/members`);t('the organization copy changed',(r.j.members??[]).some(m=>m.displayName==='Robert'),JSON.stringify((r.j.members??[]).map(m=>m.displayName)));
r=await api(Bo.token,'GET','/v1/me');t('the directory changed',r.j.displayName==='Robert');
const fd=new FormData();fd.append('file',new Blob([new Uint8Array([137,80,78,71])],{type:'image/png'}),'a.png');
let rr=await fetch(B+'/v1/me/avatar',{method:'POST',headers:{authorization:'Bearer '+Bo.token},body:fd});let aj=await rr.json();t('avatar upload',rr.status===200&&aj.avatarUrl?.startsWith('/v1/avatars/'),rr.status+' '+JSON.stringify(aj).slice(0,90));
rr=await fetch(B+aj.avatarUrl,{headers:{authorization:'Bearer '+A.token}});t('avatar read',rr.status===200&&rr.headers.get('content-type')==='image/png',rr.status);
rr=await fetch(B+aj.avatarUrl);t('avatar needs a session',rr.status===401,rr.status);
r=await api(Bo.token,'GET','/v1/me/notifications');t('notifications across organizations',r.s===200&&Array.isArray(r.j.notifications),r.s+' '+JSON.stringify(r.j).slice(0,90));
const DEVICE='e2e0'+crypto.randomUUID().replace(/-/g,'')+'0'.repeat(28);
r=await api(Bo.token,'POST','/v1/me/devices',{token:DEVICE,platform:'ios',environment:'sandbox',bundleId:'im.freeflow.app'});t('register a push device',r.s===200&&r.j.ok===true,r.s+' '+JSON.stringify(r.j).slice(0,90));
r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'hey @Robert',mentions:[Bo.user.id]});t('mention sent',r.s===201);
await sleep(200);r=await api(Bo.token,'GET','/v1/me/notifications');t('mention notifies',(r.j.notifications??[]).length>=1,JSON.stringify(r.j).slice(0,120));
const pushed=await link(new RegExp('\\[push:dev\\] token='+DEVICE.slice(0,12)+'.*?type=alert title="([^"]*)"','g'));t('the alarm pushes the mention to the device (dev driver)',!!pushed&&pushed[1].includes('Ann'),pushed?.[0]);
r=await api(Bo.token,'POST','/v1/me/notifications/read',{all:true});t('mark read',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,90));
const at=new Date(Date.now()+3000).toISOString();const beforeSched=sa.ev.length;
r=await api(A.token,'POST','/v1/scheduled-messages',{channelId:gen.id,body:'scheduled hello',recurrence:{type:'once',at}});t('schedule',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,130));
r=await api(A.token,'GET',`/v1/scheduled-messages?workspaceId=${W}`);t('schedule listed',(r.j.scheduledMessages??[]).length===1,JSON.stringify(r.j).slice(0,100));
await sleep(5000);t('the alarm posts it, with nobody calling',sa.ev.slice(beforeSched).some(e=>e.type==='message.created'&&e.data?.scheduled===true),sa.ev.slice(beforeSched).map(e=>e.type).join(','));
r=await api(A.token,'POST',`/v1/workspaces/${W}/files/presign`,{channelId:gen.id,filename:'a.txt',name:'a.txt',mimeType:'text/plain',sizeBytes:5});t('presign',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,150));
if(r.s<300){const f=r.j.file;let u=await fetch(B+r.j.upload.url,{method:'PUT',headers:{authorization:'Bearer '+A.token,'content-type':'text/plain'},body:'hello'});t('upload bytes',u.ok,u.status+' '+(await u.text()).slice(0,100));
 r=await api(A.token,'POST',`/v1/files/${f.id}/complete`);t('complete',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,120));
 r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'see attached',fileIds:[f.id]});t('attach',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,100));
 let dl=await fetch(B+`/v1/files/${f.id}`,{headers:{authorization:'Bearer '+Bo.token},redirect:'manual'});const dt=await dl.text();t('Bob downloads',dl.status===200&&dt==='hello',dl.status+' '+dt.slice(0,100));}
// A page to preview, with a picture, served here: the Worker fetches it (FLOW_UNFURL_ALLOW_HOSTS lets it reach localhost).
const chunk=(type,data)=>{const b=Buffer.alloc(8+data.length+4);b.writeUInt32BE(data.length,0);b.write(type,4,'latin1');data.copy(b,8);b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type,'latin1'),data])),8+data.length);return b;};
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(2400,0);ihdr.writeUInt32BE(1260,4);ihdr[8]=8;ihdr[9]=0;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.alloc(1260*2401))),chunk('IEND',Buffer.alloc(0))]);
const site=http.createServer((q,s)=>{if(q.url==='/pic.png'){s.setHeader('content-type','image/png');return s.end(png);}if(q.url==='/article'){s.setHeader('content-type','text/html; charset=utf-8');return s.end(`<html><head><title>Ignored</title><meta property="og:title" content="A page to preview"><meta property="og:description" content="Fetched by the Worker."><meta property="og:image" content="/pic.png"><meta property="og:site_name" content="Test Site"></head><body>${'x'.repeat(5000)}</body></html>`);}s.statusCode=404;s.end();});
await new Promise(res=>site.listen(0,'127.0.0.1',res));const pageUrl=`http://localhost:${site.address().port}/article`;
const beforeLink=sa.ev.length;
r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:`link ${pageUrl}`});t('message with a link',r.s===201,r.s);const LM=r.j;
let card;for(let i=0;i<40&&!card;i++){card=sa.ev.slice(beforeLink).find(e=>e.type==='message.updated'&&e.data?.id===LM.id&&e.data.unfurls?.length)?.data.unfurls[0];if(!card)await sleep(250);}
t('its preview arrives over the socket',card?.title==='A page to preview'&&card.description==='Fetched by the Worker.'&&card.siteName==='Test Site',JSON.stringify(card??sa.ev.slice(beforeLink).map(e=>e.type)).slice(0,170));
rr=card?.image?await fetch(B+card.image.url,{headers:{authorization:'Bearer '+A.token}}):null;const pic=rr?Buffer.from(await rr.arrayBuffer()):null;
t('its picture is served by Flow, not hotlinked',rr?.status===200&&card.image.url.startsWith('/v1/unfurl-images/'),rr?rr.status+' '+rr.headers.get('content-type'):JSON.stringify(card?.image));
// Cloudflare Images (the IMAGES binding) resizes it to fit 1200×630 as WebP, with a 128×128 thumbnail; without it the picture is kept as fetched.
const webpSize=b=>{const k=b.subarray(12,16).toString('latin1');if(k==='VP8X')return[1+b.readUIntLE(24,3),1+b.readUIntLE(27,3)];if(k==='VP8 ')return[b.readUInt16LE(26)&0x3fff,b.readUInt16LE(28)&0x3fff];if(k==='VP8L'){const v=b.readUInt32LE(21);return[(v&0x3fff)+1,((v>>14)&0x3fff)+1];}return null;};
const webp=pic&&pic.subarray(0,4).toString('latin1')==='RIFF'&&pic.subarray(8,12).toString('latin1')==='WEBP';
if(webp){t('its picture is resized to 1200×630 WebP',rr.headers.get('content-type')==='image/webp'&&card.image.width===1200&&card.image.height===630&&pic.length<png.length,JSON.stringify(card.image));
  const th=await fetch(B+card.image.thumbUrl,{headers:{authorization:'Bearer '+A.token}});const tb=Buffer.from(await th.arrayBuffer());t('with a 128×128 WebP thumbnail',th.status===200&&card.image.thumbUrl!==card.image.url&&tb.subarray(8,12).toString('latin1')==='WEBP'&&String(webpSize(tb))==='128,128',th.status+' '+webpSize(tb));}
else t('its picture is kept as fetched (no Images binding)',rr?.headers.get('content-type')==='image/png'&&pic?.equals(png)&&card.image.width===2400&&card.image.height===1260,rr?.headers.get('content-type')+' '+JSON.stringify(card?.image));
r=await api(Bo.token,'GET',`/v1/channels/${gen.id}/messages`);t('the preview stays with the message',(r.j.messages??[]).find(m=>m.id===LM.id)?.unfurls?.[0]?.title==='A page to preview',JSON.stringify((r.j.messages??[]).find(m=>m.id===LM.id)?.unfurls).slice(0,120));
// An attached picture: its size is read and its thumbnail made (512 px at most, WebP) by the same binding.
r=await api(A.token,'POST',`/v1/workspaces/${W}/files/presign`,{channelId:gen.id,filename:'pic.png',name:'pic.png',mimeType:'image/png',sizeBytes:png.length});
if(r.s<300){const f=r.j.file;await fetch(B+r.j.upload.url,{method:'PUT',headers:{authorization:'Bearer '+A.token,'content-type':'image/png'},body:png});
  r=await api(A.token,'POST',`/v1/files/${f.id}/complete`);const fd2=r.j.file??r.j;
  const th=await fetch(B+`/v1/files/${f.id}/thumb`,{headers:{authorization:'Bearer '+A.token}});const tb=Buffer.from(await th.arrayBuffer());
  if(webp)t('an attached picture gets its size and a 512 px WebP thumbnail',fd2.width===2400&&fd2.height===1260&&fd2.hasThumb&&String(webpSize(tb))==='512,269',JSON.stringify(fd2).slice(0,90)+' '+webpSize(tb));
  else t('an attached picture keeps itself as its thumbnail (no Images binding)',th.status===200&&tb.equals(png),th.status);}
else t('presign a picture',false,r.s);
site.close();
// ---- huddles
const cfg=(await api(null,'GET','/v1/config')).j;
r=await api(A.token,'POST',`/v1/channels/${gen.id}/huddle/join`);
if(cfg.huddles){t('huddle join returns a LiveKit token',r.s===200&&typeof r.j.token==='string'&&r.j.token.split('.').length===3&&r.j.url.startsWith('wss://'),r.s+' '+JSON.stringify(r.j).slice(0,120));
 const claims=r.j.token?JSON.parse(Buffer.from(r.j.token.split('.')[1],'base64url').toString()):{};t('the token is for the channel room',claims.video?.room===gen.id&&claims.sub===A.user.id,JSON.stringify(claims.video));
 r=await api(A.token,'GET',`/v1/workspaces/${W}/channels`);const hc=(r.j.channels??r.j).find(c=>c.id===gen.id);t('the channel list shows who is in the huddle',hc?.huddleParticipants?.[0]?.userId===A.user.id,JSON.stringify(hc?.huddleParticipants));
 r=await api(A.token,'POST',`/v1/channels/${gen.id}/huddle/leave`);t('huddle leave',r.s===200);
 const wh=await fetch(B+'/v1/livekit/webhook',{method:'POST',headers:{'content-type':'application/webhook+json',authorization:'forged'},body:JSON.stringify({event:'room_finished',room:{name:gen.id}})});t('an unsigned LiveKit webhook is refused',wh.status===400,wh.status);}
else{t('huddles off without LiveKit settings',r.s===503,r.s);}
// ---- agents
r=await api(A.token,'POST',`/v1/workspaces/${W}/agent-invites`,{});t('agent invite',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,100));const code=r.j.code;
r=await api(null,'POST','/v1/agents/redeem',{code,username:'flowbot',key:'a-long-agent-key-for-the-test',name:'Flowbot'});t('redeem',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,110));const AGT=r.j.agentToken,AGT_ID=r.j.user?.id;
r=await api(AGT,'GET','/v1/me');t('the agent token works, via the directory',r.j.isAgent===true&&r.j.displayName==='Flowbot',JSON.stringify(r.j).slice(0,90));
r=await api(AGT,'GET','/v1/me/workspaces');t('the agent sees its organization',r.j.workspaces?.[0]?.id===W);
const sag=await sock(AGT);t('the agent socket',!!sag.hello);
r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'hi @flowbot'});await sleep(250);t('the agent hears a message',sag.ev.some(e=>e.type==='message.created'&&e.data?.body==='hi @flowbot'),sag.ev.map(e=>e.type).join(','));
r=await api(AGT,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'agent reply'});t('the agent replies',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(null,'POST','/v1/agents/login',{username:'flowbot',key:'wrong-key-wrong-key-wrong-key'});t('wrong key refused',r.s===401,r.s);
r=await api(null,'POST','/v1/agents/login',{username:'flowbot',key:'a-long-agent-key-for-the-test'});t('login',r.s===201&&!!r.j.agentToken,r.s);const AGT2=r.j.agentToken;
r=await api(AGT,'GET','/v1/me');t('login ends the old token',r.s===401,r.s);r=await api(AGT2,'GET','/v1/me');t('new token works',r.s===200);
// ---- agents by account (platform.md §3.3)
t('the agent has one account, with its address in the organization',r.j.accounts?.length===1&&r.j.accounts[0].address==='flowbot@locked-in.freeflow.im'&&r.j.accounts[0].organizationId===W,JSON.stringify(r.j.accounts));
r=await api(AGT2,'POST','/v1/workspaces',{name:'Bots',slug:'bots-co'});t('an agent cannot create an organization',r.s===403&&r.j.error?.code==='agent_forbidden',r.s+' '+JSON.stringify(r.j).slice(0,90));
r=await api(AGT2,'POST',`/v1/workspaces/${W}/agent-invites`,{});t('nor sponsor an agent',r.s===403&&r.j.error?.code==='agent_forbidden',r.s+' '+JSON.stringify(r.j).slice(0,90));
r=await api(A.token,'PATCH',`/v1/workspaces/${W}/members/${AGT_ID}/role`,{role:'admin'});t('nor be made an admin',r.s===403&&r.j.error?.code==='agent_forbidden',r.s+' '+JSON.stringify(r.j).slice(0,90));
r=await api(A.token,'POST',`/v1/workspaces/${W}/owner`,{userId:AGT_ID});t('nor own the organization',r.s===403&&r.j.error?.code==='agent_forbidden',r.s+' '+JSON.stringify(r.j).slice(0,90));
// ---- organizations: the address on every member, the policies, handing the organization on (platform.md §3.1, §3.2)
r=await api(Bo.token,'GET','/v1/me');const bobAddr=r.j.accounts?.find(a=>a.organizationId===W)?.address;
r=await api(A.token,'GET',`/v1/workspaces/${W}/members`);const ms=r.j.members??r.j??[];t('the members list carries Bob\'s address',!!bobAddr&&ms.find(m=>m.userId===Bo.user.id)?.address===bobAddr,JSON.stringify(ms.map(m=>m.address)));
t('and the agent\'s, made after its redeem',!!ms.find(m=>m.isAgent)?.address?.startsWith('flowbot@'),JSON.stringify(ms.map(m=>m.address)));
r=await api(Bo.token,'PATCH',`/v1/workspaces/${W}`,{policies:{inviteBy:'admins'}});t('a member cannot set policies',r.s===403,r.s);
r=await api(A.token,'PATCH',`/v1/workspaces/${W}`,{policies:{inviteBy:'admins'}});t('Ann sets who may invite',r.s===200&&r.j.policies?.inviteBy==='admins'&&r.j.policies?.agentsBy==='members'&&r.j.policies?.linkSharing===true,r.s+' '+JSON.stringify(r.j.policies));
r=await api(Bo.token,'POST',`/v1/workspaces/${W}/invites`,{email:'dee@example.com'});t('an invite by Bob is refused by the policy',r.s===403&&r.j.error?.code==='policy_forbids',r.s+' '+JSON.stringify(r.j).slice(0,90));
r=await api(Bo.token,'POST',`/v1/workspaces/${W}/join-link`);t('and so is a join link',r.s===403&&r.j.error?.code==='policy_forbids',r.s+' '+JSON.stringify(r.j).slice(0,90));
r=await api(A.token,'POST',`/v1/workspaces/${W}/owner`,{userId:Bo.user.id});t('Ann hands the organization to Bob',r.s===200&&r.j.role==='admin',r.s+' '+JSON.stringify(r.j).slice(0,90));
r=await api(A.token,'POST',`/v1/workspaces/${W}/owner`,{userId:Bo.user.id});t('Ann cannot hand it on again',r.s===403,r.s);
r=await api(Bo.token,'GET','/v1/me/workspaces');const bw=r.j.workspaces?.find(w=>w.id===W);t('Bob\'s workspaces say owner, with his address',bw?.role==='owner'&&bw.address===bobAddr,JSON.stringify(bw).slice(0,160));
r=await api(Bo.token,'GET','/v1/me');t('his account in the directory says owner',r.j.accounts?.find(a=>a.organizationId===W)?.role==='owner',JSON.stringify(r.j.accounts));
r=await api(Bo.token,'POST',`/v1/workspaces/${W}/owner`,{userId:A.user.id});t('Bob hands it back',r.s===200&&r.j.role==='admin',r.s);
// ---- domains: the platform subdomain, an own domain verified over DNS, new addresses on the primary (platform.md §3.2, phase 5.1)
{let token='';const doh=http.createServer((q,s)=>{const u=new URL(q.url,'http://x');const name=u.searchParams.get('name'),type=u.searchParams.get('type');s.setHeader('content-type','application/dns-json');
  s.end(JSON.stringify(name==='_freeflow.acme.test'&&type==='TXT'&&token?{Status:0,Answer:[{name,type:16,TTL:60,data:JSON.stringify(token)}]}:{Status:3}));});
 await new Promise(res=>doh.listen(Number(process.env.DOH_PORT||18897),'127.0.0.1',res));
 const D=`/v1/workspaces/${W}/domains`;
 t('the platform subdomain\'s records went to the dev DNS driver',!!(await link(/platform dns \(dev\): MX locked-in\.freeflow\.im/g)));
 r=await api(A.token,'GET',D);const pd=r.j.domains?.[0];t('the domains list has the platform domain, verified and primary',r.s===200&&r.j.domains?.length===1&&pd.domain==='locked-in.freeflow.im'&&pd.kind==='platform'&&pd.verified&&pd.primary,r.s+' '+JSON.stringify(r.j).slice(0,160));
 r=await api(A.token,'POST',D,{domain:'Acme.Test'});const vt=r.j.records?.find(x=>x.purpose==='verification');token=vt?.value??'';
 t('Ann adds acme.test and gets a token and records',r.s===201&&r.j.domain==='acme.test'&&!r.j.verified&&vt?.name==='_freeflow.acme.test'&&/^freeflow-verify=/.test(token)&&r.j.records.some(x=>x.type==='MX')&&r.j.records.some(x=>x.purpose==='spf')&&r.j.records.some(x=>x.purpose==='dmarc'),r.s+' '+JSON.stringify(r.j).slice(0,160));
 r=await api(Bo.token,'POST',`/v1/workspaces/${W2}/domains`,{domain:'acme.test'});t('another organization cannot take it',r.s===409&&r.j.error?.code==='domain_taken',r.s+' '+JSON.stringify(r.j).slice(0,90));
 r=await api(A.token,'PATCH',`${D}/acme.test`,{primary:true});t('an unverified domain cannot be primary',r.s===409&&r.j.error?.code==='domain_unverified',r.s);
 r=await api(A.token,'POST',`${D}/acme.test/verify`);t('verify finds the token over DNS over HTTPS',r.s===200&&r.j.verified===true&&r.j.found?.includes(token),r.s+' '+JSON.stringify(r.j).slice(0,140));
 r=await api(A.token,'GET',D);const st=r.j.domains?.find(d=>d.domain==='acme.test')?.status;t('the checker finds the verification TXT and not the MX',st?.[0]?.record==='present'&&st?.[1]?.record==='missing',JSON.stringify(st));
 // The mail provider's records and DKIM (phase 5.2, MAIL_PROVIDER=fake).
 {const recs=r.j.domains?.find(d=>d.domain==='acme.test')?.records??[];t('the records are the fake provider\'s MX and SPF',recs.some(x=>x.purpose==='mx'&&x.value==='mx.fake-mail.test')&&recs.some(x=>x.purpose==='spf'&&x.value==='v=spf1 include:_spf.fake-mail.test ~all')&&!recs.some(x=>x.purpose==='dkim'),JSON.stringify(recs).slice(0,160));}
 r=await api(A.token,'POST',`${D}/nope.test/dkim`);t('DKIM on a domain the organization does not have is refused',r.s===404,r.s);
 r=await api(A.token,'POST',`${D}/acme.test/dkim`);const dk=r.j.record;t('Ann sets up DKIM and gets the TXT record',r.s===200&&dk?.type==='TXT'&&dk?.purpose==='dkim'&&dk?.name===`${r.j.selector}._domainkey.acme.test`&&/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]{300,}$/.test(dk?.value),r.s+' '+JSON.stringify(r.j).slice(0,160));
 r=await api(A.token,'GET',D);t('the list now has the DKIM record',r.j.domains?.find(d=>d.domain==='acme.test')?.records?.some(x=>x.purpose==='dkim'&&x.value===dk?.value),JSON.stringify(r.j.domains?.find(d=>d.domain==='acme.test')?.records?.map(x=>x.purpose)));
 r=await api(A.token,'PATCH',`${D}/acme.test`,{primary:true});t('Ann makes it primary',r.s===200&&r.j.primary===true,r.s+' '+JSON.stringify(r.j).slice(0,90));
 r=await api(A.token,'GET',D);t('the list says so',r.j.domains?.find(d=>d.domain==='acme.test')?.primary===true&&r.j.domains?.find(d=>d.kind==='platform')?.primary===false,JSON.stringify(r.j.domains?.map(d=>[d.domain,d.verified,d.primary])));
 const C=await signup('carol@example.com','Carol');r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{email:'carol@example.com'});const ctok=(r.j.inviteUrl??'').split('/').pop();
 r=await api(C.token,'POST','/v1/invites/accept',{token:ctok});t('Ann invites Carol',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,90));
 r=await api(C.token,'GET','/v1/me');t('Carol\'s address is on acme.test',r.j.accounts?.find(a=>a.organizationId===W)?.address==='carol@acme.test',JSON.stringify(r.j.accounts));
 r=await api(Bo.token,'GET','/v1/me');t('Bob\'s address is unchanged',r.j.accounts?.find(a=>a.organizationId===W)?.address===bobAddr,JSON.stringify(r.j.accounts?.map(a=>a.address)));
 r=await api(C.token,'GET',D);t('a member cannot see the domains',r.s===403,r.s);
 await api(A.token,'PATCH',`${D}/locked-in.freeflow.im`,{primary:true});
 r=await api(A.token,'DELETE',`${D}/acme.test`);t('acme.test cannot be removed while Carol\'s address is on it',r.s===409&&r.j.error?.code==='domain_in_use',r.s+' '+JSON.stringify(r.j).slice(0,90));
 r=await api(A.token,'DELETE',`${D}/locked-in.freeflow.im`);t('nor can the platform domain',r.s===409&&r.j.error?.code==='domain_platform',r.s);
 await api(A.token,'POST',D,{domain:'spare.test'});r=await api(A.token,'DELETE',`${D}/spare.test`);t('an unused domain can',r.s===200,r.s);
 doh.close();}
// ---- leaving
const del=await signup('cy@example.com','Cy');r=await api(del.token,'POST','/v1/workspaces',{name:'Cy co',slug:'cy-co'});
r=await api(del.token,'DELETE','/v1/me');t('delete account',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,90));r=await api(del.token,'GET','/v1/me');t('its session ended',r.s===401,r.s);
// ---- a removed member's account is refused (platform.md §3.6)
r=await api(Bo.token,'POST',`/v1/workspaces/${W}/agent-invites`,{});t('Bob sponsors an agent',r.s===201,r.s);
r=await api(null,'POST','/v1/agents/redeem',{code:r.j.code,username:'bobbot',key:'another-long-agent-key-for-the-test',name:'Bobbot'});const BOT=r.j.agentToken;
r=await api(BOT,'GET',`/v1/workspaces/${W}/channels`);t('his agent is in',r.s===200,r.s);
// ---- wake jobs through the flow-jobs Queue, post actions and schedules (platform.md §5.2, phase 2.4)
{const SP=`/v1/events/subscriptions?workspace=${W}`,JB=(id,step)=>`/v1/events/jobs/${id}/${step}?workspace=${W}`;
 const acct=async(tok)=>(await api(tok,'GET','/v1/me')).j.accounts?.find(a=>a.organizationId===W)?.id;
 const botAcct=await acct(BOT),bobAcct=await acct(Bo.token),flowbotAcct=await acct(AGT2);
 r=await api(Bo.token,'GET',`/v1/workspaces/${W}/members`);t('the members list carries the agent\'s accountId (the Automations page picks by it)',!!botAcct&&r.j.members?.find(m=>m.isAgent&&m.accountId===botAcct)?.displayName==='Bobbot',JSON.stringify(r.j.members?.filter(m=>m.isAgent).map(m=>({n:m.displayName,a:m.accountId}))).slice(0,160));
 r=await api(BOT,'POST',SP,{name:'my jobs',filter:{types:['agent.job'],self:true}});const JQ=r.j.subscription;t('the agent subscribes to its own jobs',r.s===201,r.s);
 const jobsAfter=async(pred,ms)=>{const end=Date.now()+ms;for(;;){const q=(await api(BOT,'GET',`/v1/events/subscriptions/${JQ.id}?workspace=${W}&wait=1`)).j;const hit=q.events?.filter(pred)??[];if(q.next)await api(BOT,'POST',`/v1/events/subscriptions/${JQ.id}/ack?workspace=${W}`,{cursor:q.next});if(hit.length)return hit;if(Date.now()>end)return [];}};
 r=await api(BOT,'POST',SP,{name:'not mine',delivery:'wake',consumer:flowbotAcct,filter:{},action:{kind:'wake',prompt:'p'}});t('an agent may not make a wake subscription for another\'s agent',r.s===403&&r.j.error?.code==='agent_forbidden',r.s+' '+JSON.stringify(r.j).slice(0,120));
 r=await api(Bo.token,'POST',SP,{name:'bad',filter:{},consumer:botAcct});t('consumer is for wake only',r.s===400,r.s+' '+JSON.stringify(r.j).slice(0,120));
 r=await api(Bo.token,'POST',SP,{name:'summaries',delivery:'wake',consumer:botAcct,filter:{types:['chat.message.created'],channelId:gen.id},action:{kind:'wake',prompt:'Summarize: {{data}}'}});const WS1=r.j.subscription;
 t('Bob makes a wake subscription for his agent',r.s===201&&WS1?.delivery==='wake'&&WS1.consumer===botAcct&&WS1.owner===bobAcct&&WS1.action?.prompt==='Summarize: {{data}}',r.s+' '+JSON.stringify(r.j).slice(0,160));
 r=await api(Bo.token,'GET',SP);t('and lists it as its owner',r.j.subscriptions?.some(x=>x.id===WS1?.id),JSON.stringify(r.j).slice(0,100));
 const t0=Date.now();r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'please summarize me'});const MW=r.j;
 let jobs=await jobsAfter(e=>e.type==='agent.job'&&e.data?.subscriptionId===WS1?.id,3000);const J=jobs[0];const JID=J?.data?.jobId;
 t('within 3 s the agent\'s queue has an agent.job',!!J&&Date.now()-t0<3500,(Date.now()-t0)+'ms '+JSON.stringify(J??null).slice(0,160));
 t('with the rendered prompt, depth 1, caused by the job',J?.data?.prompt?.startsWith('Summarize: {')&&J.data.prompt.includes('please summarize me')&&J.depth===1&&J.causedBy===JID&&J.data.event?.channelId===gen.id,JSON.stringify(J?.data??null).slice(0,160));
 r=await api(A.token,'POST',JB(JID,'ack'));t('Ann cannot ack the agent\'s job',r.s===404,r.s);
 r=await api(BOT,'POST',JB(JID,'ack'));t('the agent acks: running, under a lease',r.s===200&&r.j.job?.state==='running'&&Date.parse(r.j.job.leaseUntil)>Date.now()+500_000,r.s+' '+JSON.stringify(r.j).slice(0,140));
 r=await api(BOT,'POST',JB(JID,'extend'));t('and extends it',r.s===200&&r.j.job?.state==='running',r.s);
 r=await api(BOT,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'Summary: Ann asked for one.'},{'x-flow-job':JID});const MJ=r.j;t('the agent posts during the job\'s turn',r.s===201,r.s);
 await sleep(400);r=await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=0&limit=500&types=chat.message.created&channel=${gen.id}`);let all=r.j.events??[];while(r.j.events?.length===500){r=await api(Bo.token,'GET',`/v1/events?workspace=${W}&since=${r.j.next}&limit=500&types=chat.message.created&channel=${gen.id}`);all=all.concat(r.j.events)}
 const EJ=all.find(e=>e.data?.id===MJ.id),EA=all.find(e=>e.data?.id===MW.id);
 t('its message\'s event carries causedBy the job and depth 2',EJ?.causedBy===JID&&EJ.depth===2,JSON.stringify(EJ&&{causedBy:EJ.causedBy,depth:EJ.depth}));
 t('and Ann\'s, no cause and depth 0',EA&&!EA.causedBy&&EA.depth===0,JSON.stringify(EA&&{causedBy:EA.causedBy,depth:EA.depth}));
 r=await api(BOT,'POST',JB(JID,'done'),{ok:true,note:'summarized'});t('the agent reports done',r.s===200&&r.j.job?.state==='done'&&r.j.job.note==='summarized',r.s+' '+JSON.stringify(r.j).slice(0,120));
 r=await api(Bo.token,'GET',`/v1/events/jobs?subscription=${WS1.id}&workspace=${W}`);t('Bob\'s job list says done, and the agent\'s own post woke nothing',r.s===200&&r.j.jobs?.length===1&&r.j.jobs[0].state==='done'&&r.j.jobs[0].id===JID,r.s+' '+JSON.stringify(r.j).slice(0,160));
 r=await api(BOT,'GET',`/v1/events/jobs?subscription=${WS1.id}&workspace=${W}`);t('so does the agent\'s',r.j.jobs?.[0]?.state==='done',r.s);
 r=await api(A.token,'GET',`/v1/events/jobs?subscription=${WS1.id}&workspace=${W}`);t('Ann\'s is 404',r.s===404,r.s);
 r=await api(BOT,'POST',JB(JID,'extend'));t('a done job cannot be extended',r.s===409&&r.j.error?.code==='job_state',r.s);
 r=await api(Bo.token,'DELETE',`/v1/events/subscriptions/${WS1.id}?workspace=${W}`);t('the owner deletes the wake subscription',r.s===200,r.s);
 // A job nobody acks is delivered again by the flow-jobs Queue's check (JOBS_ACK_DELAY_SECONDS=2 here).
 r=await api(Bo.token,'POST',SP,{name:'unanswered',delivery:'wake',consumer:botAcct,filter:{types:['chat.message.created'],channelId:gen.id},action:{kind:'wake',prompt:'Again: {{type}}'}});const WS2=r.j.subscription;
 r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'nobody answers this'});
 jobs=await jobsAfter(e=>e.type==='agent.job'&&e.data?.subscriptionId===WS2?.id,3000);const J2=jobs[0],t2=Date.now();
 t('a second wake subscription files a job',!!J2&&J2.data.prompt==='Again: chat.message.created',JSON.stringify(J2?.data??null).slice(0,120));
 const again=await jobsAfter(e=>e.type==='agent.job'&&e.data?.jobId===J2?.data?.jobId&&e.id!==J2.id,8000);
 t('not acked, it is delivered again: a second agent.job for the same job within ~5 s',again.length>=1&&Date.now()-t2<6500,(Date.now()-t2)+'ms '+again.length);
 r=await api(Bo.token,'GET',`/v1/events/jobs?subscription=${WS2.id}&workspace=${W}`);t('the job says one more attempt',r.j.jobs?.[0]?.attempts===1&&r.j.jobs[0].state==='delivered',JSON.stringify(r.j.jobs?.[0]??r.j).slice(0,160));
 r=await api(BOT,'POST',JB(J2.data.jobId,'ack'));t('and the agent can still take it',r.j.job?.state==='running',r.s);
 await api(Bo.token,'DELETE',`/v1/events/subscriptions/${WS2.id}?workspace=${W}`);
 // A post subscription posts as its owner when it matches.
 r=await api(Bo.token,'POST',SP,{name:'reaction echo',delivery:'post',filter:{types:['chat.reaction.added'],channelId:gen.id},action:{kind:'post',channelId:gen.id,body:'Someone reacted with {{type}}'}});const PS=r.j.subscription;
 t('Bob makes a post subscription',r.s===201&&PS?.delivery==='post',r.s+' '+JSON.stringify(r.j).slice(0,120));
 r=await api(A.token,'PUT',`/v1/messages/${MW.id}/reactions/${encodeURIComponent('🎉')}`);
 let posted=null;for(let i=0;i<15&&!posted;i++){await sleep(200);r=await api(A.token,'GET',`/v1/channels/${gen.id}/messages?limit=10`);posted=r.j.messages?.find(m=>m.body==='Someone reacted with chat.reaction.added')}
 t('a match posts into the channel as Bob',posted?.userId===Bo.user.id,JSON.stringify(posted??r.j.messages?.map(m=>m.body)).slice(0,140));
 await api(Bo.token,'DELETE',`/v1/events/subscriptions/${PS.id}?workspace=${W}`);
 // With includeSelf, a post automation fires on its creator's own message too.
 r=await api(Bo.token,'POST',SP,{name:'own echo',delivery:'post',filter:{types:['chat.message.created'],channelId:gen.id,text:'echo me'},action:{kind:'post',channelId:gen.id,body:'Echoed own post',includeSelf:true}});const PO=r.j.subscription;
 await api(Bo.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'please echo me'});
 posted=null;for(let i=0;i<15&&!posted;i++){await sleep(200);r=await api(Bo.token,'GET',`/v1/channels/${gen.id}/messages?limit=10`);posted=r.j.messages?.find(m=>m.body==='Echoed own post')}
 t('an includeSelf post automation fires on its creator\'s own message',PO&&posted?.userId===Bo.user.id,JSON.stringify(posted??r.j.messages?.map(m=>m.body)).slice(0,140));
 await api(Bo.token,'DELETE',`/v1/events/subscriptions/${PO?.id}?workspace=${W}`);
 // A schedule: the filter is forced to its own ticks, and its first is within the hour (the tick itself is unit-tested).
 r=await api(Bo.token,'POST',SP,{name:'hourly digest',delivery:'wake',consumer:botAcct,filter:{types:['chat.*']},action:{kind:'wake',prompt:'Digest'},schedule:{every:'hourly',timezone:'UTC'}});const SC=r.j.subscription;
 const left=SC?.schedule&&Date.parse(SC.schedule.nextAt)-Date.now();
 t('an hourly schedule forces the filter to its ticks',r.s===201&&SC.filter?.types?.[0]==='schedule.tick'&&SC.filter.types.length===1&&SC.filter.ref?.kind==='schedule'&&SC.filter.ref.id===SC.schedule.id&&SC.filter.ref.organizationId===W,r.s+' '+JSON.stringify(r.j).slice(0,180));
 t('with next_at within the hour',left>0&&left<=3_600_000,left);
 r=await api(Bo.token,'POST',SP,{name:'bad',filter:{},schedule:{every:'every 5 minutes'}});t('a bad schedule is refused',r.s===400,r.s);
 await api(Bo.token,'DELETE',`/v1/events/subscriptions/${SC.id}?workspace=${W}`);}
const sbot=await sock(BOT);const botClosed=new Promise((res)=>{sbot.ws.onclose=e=>res(e);setTimeout(()=>res(null),6000)});
r=await api(A.token,'DELETE',`/v1/workspaces/${W}/members/${Bo.user.id}`);t('Ann removes Bob',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,90));
const bc=await botClosed;t('his agent\'s socket closes with him',bc?.code===4003,bc&&bc.code+' '+bc.reason);
// Bob's agent belonged to this organization only, so its credentials end with its account here.
r=await api(BOT,'GET',`/v1/workspaces/${W}/channels`);t('his agent follows him out',r.s===401||(r.s===403&&r.j.error?.code==='account_inactive'),r.s+' '+JSON.stringify(r.j).slice(0,90));
r=await api(A.token,'GET',`/v1/workspaces/${W}/members`);t('and is off the member list',!(r.j.members??[]).some(m=>m.displayName==='Bobbot'),JSON.stringify((r.j.members??[]).map(m=>m.displayName)));
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/channels`);t('a removed account is refused',r.s===403&&r.j.error?.code==='account_inactive',r.s+' '+JSON.stringify(r.j).slice(0,90));
const closed=await new Promise((res)=>{const ws=new WebSocket(`${WS}/v1/ws?workspace=${W}`);ws.onopen=()=>ws.send(JSON.stringify({op:'auth',token:Bo.token}));ws.onclose=e=>res(e);setTimeout(()=>res(null),6000)});
t('a removed account\'s socket is closed',closed?.code===4003&&closed.reason==='account inactive',closed&&closed.code+' '+closed.reason);
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail ? 1 : 0);
