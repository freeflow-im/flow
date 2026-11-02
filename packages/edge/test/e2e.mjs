// End-to-end check of Chat through the Worker, the directory and an organization object, against a local `wrangler dev`:
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars; mkdir -p public
//   npx wrangler dev --port 18796 --local --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none \
//     --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18796 > /tmp/edge.log 2>&1 &
//   node test/e2e.mjs /tmp/edge.log
// It reads signup links from the Worker's log, because local mail goes there.
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
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail ? 1 : 0);
