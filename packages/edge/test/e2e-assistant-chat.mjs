// End-to-end check of a person's assistant posting elsewhere in Chat (docs/specs/agents.md §1, §1.1): Ann asks her
// assistant in their DM to post in #general; it leaves a card in the DM and posts nothing; her ❌ posts nothing; her ✅
// brings it into #general and posts there as itself; another member's ✅ counts for nothing. Against a local `wrangler dev`
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
const react=(tok,id,emoji)=>api(tok,'PUT',`/v1/messages/${id}/reactions/${encodeURIComponent(emoji)}`);
const tag=Date.now().toString(36);

const A=await signup(`ac-ann-${tag}@example.com`,'Ann');
let r=await api(A.token,'POST','/v1/workspaces',{name:`Ac ${tag}`,slug:`ac-${tag}`});const W=r.j.id;t('Ann creates an organization',r.s===201,r.s);
const asst=await until(async()=>((await api(A.token,'GET',`/v1/workspaces/${W}/members`)).j.members??[]).find(m=>m.kind==='personal_agent'),(m)=>!!m,20000);
t('Ann has an assistant in Chat',!!asst?.userId,JSON.stringify(asst).slice(0,160));
const general=((await api(A.token,'GET',`/v1/workspaces/${W}/channels`)).j.channels??[]).find(c=>c.name==='general');
r=await api(A.token,'POST',`/v1/workspaces/${W}/dms`,{userIds:[asst.userId]});const DM=r.j.id;t('Ann opens a DM with it',r.s===201,r.s);
const fromAsst=(list)=>list.filter(m=>m.userId===asst.userId);
const card=(list)=>fromAsst(list).find(m=>/Post in #general\?/.test(m.body));

// 1. Ask; a card, and nothing in #general.
await say(A.token,DM,'Please post exactly this in #general: "Lunch order closes at noon." Nothing else.');
let dm=await until(()=>msgs(A.token,DM),(l)=>!!card(l),120000);
let c1=card(dm);
t('it leaves a card in the DM, quoting the post',!!c1&&c1.body.includes('Lunch order closes at noon')&&c1.body.includes('React ✅'),JSON.stringify(fromAsst(dm).map(m=>m.body)).slice(0,300));
t('and posts nothing in #general yet',!fromAsst(await msgs(A.token,general.id)).length,'');

// 2. Bob's ✅ counts for nothing (he cannot even see the DM, so he cannot react there).
const Bo=await signup(`ac-bob-${tag}@example.com`,'Bob');
r=await api(Bo.token,'PUT',`/v1/messages/${c1.id}/reactions/${encodeURIComponent('✅')}`);t('Bob cannot react on Ann’s card',r.s>=400,r.s);

// 3. ❌: nothing posted, and the assistant says so.
const shown=fromAsst(dm).length;
r=await react(A.token,c1.id,'❌');t('Ann reacts ❌',r.s<300,r.s);
dm=await until(()=>msgs(A.token,DM),(l)=>fromAsst(l).length>shown,90000);
t('nothing is posted in #general',!fromAsst(await msgs(A.token,general.id)).length,'');
t('and it answers in the DM',fromAsst(dm).length>shown,JSON.stringify(fromAsst(dm).map(m=>m.body).slice(0,2)).slice(0,200));

// 4. Ask again; ✅ this time.
const before=fromAsst(dm).length;
await say(A.token,DM,'OK, post it now please: "Lunch order closes at noon."');
dm=await until(()=>msgs(A.token,DM),(l)=>fromAsst(l).filter(m=>/Post in #general\?/.test(m.body)).length>1,120000);
const c2=fromAsst(dm).filter(m=>/Post in #general\?/.test(m.body))[0];
t('a second card',!!c2&&c2.id!==c1.id,'');
r=await react(A.token,c2.id,'✅');t('Ann reacts ✅',r.s<300,r.s);
const gen=await until(()=>msgs(A.token,general.id),(l)=>fromAsst(l).length>0,90000);
t('it joins #general and posts the text there as itself',fromAsst(gen).some(m=>m.body.includes('Lunch order closes at noon')),JSON.stringify(gen.map(m=>[m.userId===asst.userId?'asst':'other',m.systemKind,m.body])).slice(0,300));
dm=await until(()=>msgs(A.token,DM),(l)=>fromAsst(l).length>before+2,60000);
t('and tells Ann in the DM',fromAsst(dm).length>before+1,'');
// A second ✅ on the same card posts nothing more.
await react(A.token,c2.id,'✔️');await sleep(8000);
t('a second approval of the same card posts nothing more',fromAsst(await msgs(A.token,general.id)).length===fromAsst(gen).length,'');

// 5. Reading a channel Ann is in, and leaving it when she asks.
let n=fromAsst(await msgs(A.token,DM)).length;
await say(A.token,DM,'What is the newest message in #general? Quote it.');
dm=await until(()=>msgs(A.token,DM),(l)=>fromAsst(l).length>n,90000);
t('it reads #general for Ann',/Lunch order closes at noon/.test(fromAsst(dm)[0]?.body??''),fromAsst(dm)[0]?.body);
// 6. Asked where others read (a mention in a channel), it leaves no card: the card would show the post to everyone there.
r=await api(A.token,'POST',`/v1/workspaces/${W}/channels`,{name:`team-${tag}`});const team=r.j.id;
await say(A.token,team,`<@${asst.userId}> please post "hello" in #general`);
await sleep(30000);
const teamMsgs=await msgs(A.token,team);
const thread=teamMsgs.find(m=>m.replyCount>0);
const replies=thread?((await api(A.token,'GET',`/v1/messages/${thread.id}/thread`)).j.messages??[]):[];
t('mentioned in a channel, it leaves no card there',![...teamMsgs,...replies].some(m=>m.userId===asst.userId&&/Post in #/.test(m.body)),JSON.stringify(replies.map(m=>m.body)).slice(0,240));
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
