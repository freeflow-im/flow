// End-to-end check of a person's assistant posting elsewhere in Chat (docs/specs/agents.md §1, §1.1): Ann asks her
// assistant in their DM to post in #general; it joins #general and posts there as itself at once, with no card to approve
// (operator ruling 2026-11-17, R-C); asked by a mention in another channel, it posts too. Against a local `wrangler dev`
// with a real model key (ANTHROPIC_API_KEY in .dev.vars, beside EDGE_ORIGIN_SECRET and FLOW_DATA_KEY), on port 18797:
//   npx wrangler dev --port 18797 --local --enable-containers=false --var PORTED_HOSTS:edge.freeflow.im,localhost \
//     --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18797 \
//     --var MAIL_PROVIDER:fake > /tmp/edge-chat.log 2>&1 &
//   node test/e2e-assistant-chat.mjs /tmp/edge-chat.log
// It reads signup links from the Worker's log, because local mail goes there.
import fs from 'node:fs';
import crypto from 'node:crypto';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18797';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,200):''));};
const api=async(tok,m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':'application/json'}:{})},body:b===undefined?undefined:JSON.stringify(b)});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const until=async(get,ok,ms)=>{const t0=Date.now();for(;;){const v=await get();if(ok(v)||Date.now()-t0>ms)return v;await sleep(1500);}};
const say=(tok,ch,body)=>api(tok,'POST',`/v1/channels/${ch}/messages`,{clientMsgId:crypto.randomUUID(),body});
const msgs=async(tok,ch)=>((await api(tok,'GET',`/v1/channels/${ch}/messages?limit=50`)).j.messages??[]);
const tag=Date.now().toString(36);

const A=await signup(`ac-ann-${tag}@example.com`,'Ann');
let r=await api(A.token,'POST','/v1/workspaces',{name:`Ac ${tag}`,slug:`ac-${tag}`});const W=r.j.id;t('Ann creates an organization',r.s===201,r.s);
const asst=await until(async()=>((await api(A.token,'GET',`/v1/workspaces/${W}/members`)).j.members??[]).find(m=>m.kind==='personal_agent'),(m)=>!!m,20000);
t('Ann has an assistant in Chat',!!asst?.userId,JSON.stringify(asst).slice(0,160));
const general=((await api(A.token,'GET',`/v1/workspaces/${W}/channels`)).j.channels??[]).find(c=>c.name==='general');
r=await api(A.token,'POST',`/v1/workspaces/${W}/dms`,{userIds:[asst.userId]});const DM=r.j.id;t('Ann opens a DM with it',r.s===201,r.s);
const fromAsst=(list)=>list.filter(m=>m.userId===asst.userId);
// 1. Ask; it posts in #general at once, as itself, and leaves no card.
await say(A.token,DM,'Please post exactly this in #general: "Lunch order closes at noon." Nothing else.');
const gen=await until(()=>msgs(A.token,general.id),(l)=>fromAsst(l).length>0,120000);
t('it joins #general and posts the text there as itself, at once',fromAsst(gen).some(m=>m.body.includes('Lunch order closes at noon')),JSON.stringify(gen.map(m=>[m.userId===asst.userId?'asst':'other',m.systemKind,m.body])).slice(0,300));
let dm=await until(()=>msgs(A.token,DM),(l)=>fromAsst(l).length>0,60000);
t('and tells Ann in the DM, with no card to approve',fromAsst(dm).length>0&&!fromAsst(dm).some(m=>/React ✅|Post in #general\?/.test(m.body)),JSON.stringify(fromAsst(dm).map(m=>m.body)).slice(0,200));

// 2. Reading a channel Ann is in.
let n=fromAsst(await msgs(A.token,DM)).length;
await say(A.token,DM,'What is the newest message in #general? Quote it.');
dm=await until(()=>msgs(A.token,DM),(l)=>fromAsst(l).length>n,90000);
t('it reads #general for Ann',/Lunch order closes at noon/.test(fromAsst(dm)[0]?.body??''),fromAsst(dm)[0]?.body);
// 3. Asked where others read (a mention in a channel), it posts too.
const Bo=await signup(`ac-bob-${tag}@example.com`,'Bob');
r=await api(A.token,'POST',`/v1/workspaces/${W}/channels`,{name:`team-${tag}`});const team=r.j.id;
const before=fromAsst(await msgs(A.token,general.id)).length;
await say(A.token,team,`<@${asst.userId}> please post "hello from the team" in #general`);
const gen2=await until(()=>msgs(A.token,general.id),(l)=>fromAsst(l).length>before,120000);
t('mentioned in a channel, it posts in #general at once',fromAsst(gen2).some(m=>/hello from the team/i.test(m.body)),JSON.stringify(fromAsst(gen2).map(m=>m.body)).slice(0,240));
// 7. Leaving: #general too (it holds every person, but no assistant need stay), when Ann asks in the DM.
const memberIds=async(ch)=>((await api(A.token,'GET',`/v1/channels/${ch}/members`)).j.userIds??[]);
n=fromAsst(await msgs(A.token,DM)).length;
await say(A.token,DM,'Please leave #general.');
await until(()=>msgs(A.token,DM),(l)=>fromAsst(l).length>n,90000);
let ids=await memberIds(general.id);
t('it leaves #general when Ann asks',ids.length>0&&!ids.includes(asst.userId),JSON.stringify(ids));
// 8. Ann takes it out of a channel herself (not an admin's power: it is hers), and another member cannot.
const team2=(await api(A.token,'POST',`/v1/workspaces/${W}/channels`,{name:`team2-${tag}`})).j.id;
r=await api(A.token,'POST',`/v1/channels/${team2}/members`,{userId:asst.userId});t('Ann brings it into a channel',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(Bo.token,'DELETE',`/v1/channels/${team2}/members/${asst.userId}`);t('someone outside the organization cannot take it out',r.s>=400,r.s);
r=await api(A.token,'DELETE',`/v1/channels/${team2}/members/${asst.userId}`);ids=await memberIds(team2);
t('Ann takes it out herself',r.s===200&&!ids.includes(asst.userId),r.s+' '+JSON.stringify(ids));
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
