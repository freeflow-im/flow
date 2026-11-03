// End-to-end check of Chat through the Worker, the directory and an organization object, against a local `wrangler dev`:
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars; mkdir -p public
//   npx wrangler dev --port 18796 --local --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none \
//     --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18796 \
//     --var LIVEKIT_API_KEY:devkey --var LIVEKIT_API_SECRET:devsecret-devsecret-devsecret-00 --var LIVEKIT_URL:wss://dev.livekit.invalid > /tmp/edge.log 2>&1 &
//   node test/e2e.mjs /tmp/edge.log
// It reads signup links and the dev push driver's lines from the Worker's log, because local mail and pushes go there.
// Without the LIVEKIT_* vars the huddle checks expect huddles to be off instead.
import fs from 'node:fs';
const log=process.argv[2]; const B='http://localhost:18796', WS='ws://localhost:18796';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const api=async(tok,m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{...(tok?{authorization:'Bearer '+tok}:{}),...(b?{'content-type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});let j;const x=await r.text();try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j}};
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
const sock=(tok)=>new Promise((res,rej)=>{const ws=new WebSocket(`${WS}/v1/ws?workspace=${W}`);const ev=[];ws.onopen=()=>ws.send(JSON.stringify({op:'auth',token:tok}));ws.onmessage=e=>{const f=JSON.parse(e.data);if(f.op==='hello')res({ws,ev,hello:f});if(f.op==='event')ev.push(f.event);if(f.op==='error')rej(new Error(f.message));};ws.onerror=()=>rej(new Error('ws'));setTimeout(()=>rej(new Error('ws timeout')),6000)});
const sa=await sock(A.token),sb=await sock(Bo.token);t('sockets hello',sa.hello.heartbeat==='client');
await sleep(200);t('presence reaches Ann',sa.ev.some(e=>e.type==='presence'&&e.data.userId===Bo.user.id));
r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'hello everyone'});t('send by channel id',r.s===201,JSON.stringify(r.j).slice(0,100));const M=r.j;
await sleep(250);t('Bob gets it live',sb.ev.some(e=>e.type==='message.created'&&e.data?.id===M.id));
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
r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'link https://example.com/'});t('message with a link',r.s===201,r.s);
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
r=await api(null,'POST','/v1/agents/redeem',{code,username:'flowbot',key:'a-long-agent-key-for-the-test',name:'Flowbot'});t('redeem',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,110));const AGT=r.j.agentToken;
r=await api(AGT,'GET','/v1/me');t('the agent token works, via the directory',r.j.isAgent===true&&r.j.displayName==='Flowbot',JSON.stringify(r.j).slice(0,90));
r=await api(AGT,'GET','/v1/me/workspaces');t('the agent sees its organization',r.j.workspaces?.[0]?.id===W);
const sag=await sock(AGT);t('the agent socket',!!sag.hello);
r=await api(A.token,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'hi @flowbot'});await sleep(250);t('the agent hears a message',sag.ev.some(e=>e.type==='message.created'&&e.data?.body==='hi @flowbot'),sag.ev.map(e=>e.type).join(','));
r=await api(AGT,'POST',`/v1/channels/${gen.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'agent reply'});t('the agent replies',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(null,'POST','/v1/agents/login',{username:'flowbot',key:'wrong-key-wrong-key-wrong-key'});t('wrong key refused',r.s===401,r.s);
r=await api(null,'POST','/v1/agents/login',{username:'flowbot',key:'a-long-agent-key-for-the-test'});t('login',r.s===201&&!!r.j.agentToken,r.s);const AGT2=r.j.agentToken;
r=await api(AGT,'GET','/v1/me');t('login ends the old token',r.s===401,r.s);r=await api(AGT2,'GET','/v1/me');t('new token works',r.s===200);
// ---- leaving
const del=await signup('cy@example.com','Cy');r=await api(del.token,'POST','/v1/workspaces',{name:'Cy co',slug:'cy-co'});
r=await api(del.token,'DELETE','/v1/me');t('delete account',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,90));r=await api(del.token,'GET','/v1/me');t('its session ended',r.s===401,r.s);
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail ? 1 : 0);
