// End-to-end check of a person's several private agents (docs/specs/agents.md §1.3): Ann makes Scout beside her assistant;
// Scout is hers alone (Bob cannot read its definition or use it from the panel); a DM with Scout and a mention of Scout reach
// Scout, not her assistant; five is the most; her assistant cannot be removed and Scout can. Against a local `wrangler dev`
// on port 18797 started as in e2e-assistant-chat.mjs. With OPENAI_API_KEY set, the organization's model is set to OpenAI
// with that key; otherwise the Worker's built-in Anthropic key is used.
//   node test/e2e-personal-agents.mjs /tmp/edge-agents.log
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
const thread=async(tok,id)=>((await api(tok,'GET',`/v1/messages/${id}/thread?limit=50`)).j.messages??[]);
const tag=Date.now().toString(36);

const A=await signup(`pa-ann-${tag}@example.com`,'Ann');
let r=await api(A.token,'POST','/v1/workspaces',{name:`Pa ${tag}`,slug:`pa-${tag}`});const W=r.j.id;t('Ann creates an organization',r.s===201,r.s);
if(process.env.OPENAI_API_KEY){r=await api(A.token,'PUT',`/api/settings/assistant?workspace=${W}`,{provider:'openai',openaiKey:process.env.OPENAI_API_KEY});t('the organization runs on OpenAI',r.s===200,JSON.stringify(r.j).slice(0,160));}
const asst=await until(async()=>((await api(A.token,'GET',`/v1/workspaces/${W}/members`)).j.members??[]).find(m=>m.kind==='personal_agent'),(m)=>!!m,20000);
t('Ann has her assistant',!!asst?.userId,'');
const Bo=await signup(`pa-bob-${tag}@example.com`,'Bob');
r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{emails:[Bo.user.email]});const bobTok=(r.j.results?.[0]?.inviteUrl??'').split('/').pop();
r=await api(Bo.token,'POST','/v1/invites/accept',{token:bobTok});
const bobIn=await until(async()=>((await api(A.token,'GET',`/v1/workspaces/${W}/members`)).j.members??[]).some(m=>m.userId===Bo.user.id),(x)=>x,15000);
t('Bob joins',bobIn,JSON.stringify(r.j).slice(0,160));

// 1. Making Scout.
r=await api(A.token,'GET',`/v1/workspaces/${W}/agents/mine`);
t('her own agents: the assistant alone, the default, limit five',r.s===200&&r.j.agents.length===1&&r.j.agents[0].self&&r.j.limit===5,JSON.stringify(r.j).slice(0,200));
r=await api(A.token,'POST',`/v1/workspaces/${W}/agents/personal`,{name:'Scout',instructions:'You are Scout. Begin every reply with the word SCOUT in capitals.'});
const scout=r.j.agent;t('Ann makes Scout',r.s===201&&scout?.mode==='personal'&&!scout.self,JSON.stringify(r.j).slice(0,200));
const members=(await api(A.token,'GET',`/v1/workspaces/${W}/members`)).j.members??[];
t('Scout is on the member list beside Ann',members.some(m=>m.userId===scout.id&&m.kind==='personal_agent'&&m.sponsorId===A.user.id),'');
r=await api(A.token,'GET',`/v1/workspaces/${W}/agents/${scout.id}/definition`);
t('Ann reads its instructions',r.s===200&&r.j.definition.instructions.includes('SCOUT')&&r.j.mayEdit,JSON.stringify(r.j).slice(0,160));
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/agents/${scout.id}/definition`);t('Bob cannot',r.s===404,r.s);
r=await api(Bo.token,'GET',`/api/agent/agents?workspace=${W}`);t('nor use it from the panel',r.s===200&&!r.j.agents.some(a=>a.id===scout.id),JSON.stringify(r.j).slice(0,200));
r=await api(A.token,'GET',`/api/agent/agents?workspace=${W}`);
t('Ann’s panel lists it after her assistant, as hers alone',r.j.agents?.[0]?.self&&r.j.agents.some(a=>a.id===scout.id&&a.mode==='personal'&&!a.self),JSON.stringify(r.j).slice(0,200));

// 2. A DM with Scout reaches Scout, not the assistant.
r=await api(A.token,'POST',`/v1/workspaces/${W}/dms`,{userIds:[scout.id]});const DM=r.j.id;t('Ann opens a DM with Scout',r.s===201,r.s);
await say(A.token,DM,'Say hello in one short sentence.');
let dm=await until(()=>msgs(A.token,DM),(l)=>l.some(m=>m.userId===scout.id),120000);
const hello=dm.find(m=>m.userId===scout.id);
t('Scout answers in the DM, following its own instructions',!!hello&&/SCOUT/.test(hello.body),hello?.body);
t('her assistant does not',!dm.some(m=>m.userId===asst.userId),'');

// 3. A mention of Scout in #general reaches Scout, in a thread.
const general=((await api(A.token,'GET',`/v1/workspaces/${W}/channels`)).j.channels??[]).find(c=>c.name==='general');
r=await say(A.token,general.id,`<@${scout.id}> name one primary colour, one word.`);const ask=r.j.message?.id??r.j.id;
const th=await until(()=>thread(A.token,ask),(l)=>l.some(m=>m.userId===scout.id),120000);
t('Scout answers the mention in the thread',th.some(m=>m.userId===scout.id),JSON.stringify(th.map(m=>m.body)).slice(0,200));
t('and her assistant stays out of it',!th.some(m=>m.userId===asst.userId),'');
// Bob's mention of Scout asks nothing.
const before=th.filter(m=>m.userId===scout.id).length;
r=await say(Bo.token,general.id,`<@${scout.id}> what is 2 + 2?`);const bobAsk=r.j.message?.id??r.j.id;await sleep(15000);
const all=await msgs(A.token,general.id);
const bobThread=await thread(A.token,bobAsk);
t('a mention of Scout by Bob gets nothing',!bobThread.some(m=>m.userId===scout.id)&&all.filter(m=>m.userId===scout.id&&!m.threadRootId&&!m.systemKind).length===0,JSON.stringify(all.filter(m=>m.userId===scout.id).map(m=>[m.threadRootId,m.body])).slice(0,200));
t('and Scout has still answered only Ann',(await thread(A.token,ask)).filter(m=>m.userId===scout.id).length===before,'');

// 4. The limit, and removing.
for(const n of ['Two','Three','Four']){r=await api(A.token,'POST',`/v1/workspaces/${W}/agents/personal`,{name:n});}
t('five in all',(await api(A.token,'GET',`/v1/workspaces/${W}/agents/mine`)).j.agents.length===5,'');
r=await api(A.token,'POST',`/v1/workspaces/${W}/agents/personal`,{name:'Six'});t('a sixth is refused',r.s===409&&r.j.error?.code==='agent_limit',JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'DELETE',`/v1/workspaces/${W}/agents/personal/${asst.userId}`);t('her assistant cannot be removed',r.s===409,r.s);
r=await api(Bo.token,'DELETE',`/v1/workspaces/${W}/agents/personal/${scout.id}`);t('Bob cannot remove Scout',r.s===404,r.s);
r=await api(A.token,'DELETE',`/v1/workspaces/${W}/agents/personal/${scout.id}`);t('Ann removes Scout',r.s===200,r.s);
t('it leaves the member list',!((await api(A.token,'GET',`/v1/workspaces/${W}/members`)).j.members??[]).some(m=>m.userId===scout.id),'');
r=await api(A.token,'POST',`/v1/workspaces/${W}/agents/personal`,{name:'Five'});t('which makes room for another',r.s===201,r.s);

// 5. A hosted shared agent answers members in Chat (agents.md §1), and keeps what each tells it in their own `you` folder.
r=await api(A.token,'POST',`/v1/workspaces/${W}/agents/hosted`,{name:'Omni',instructions:'You are the team helper. Keep answers short.'});
const omni=r.j.agent;t('Ann makes Omni, a shared agent',r.s===201&&omni?.mode==='shared',r.s);
r=await api(Bo.token,'POST',`/v1/workspaces/${W}/dms`,{userIds:[omni.id]});const ODM=r.j.id;t('Bob opens a DM with Omni',r.s===201,r.s);
await say(Bo.token,ODM,'Please remember that my favourite colour is green.');
let od=await until(()=>msgs(Bo.token,ODM),(l)=>l.some(m=>m.userId===omni.id&&!m.systemKind),120000);
t('Omni answers Bob in the DM',od.some(m=>m.userId===omni.id&&!m.systemKind),JSON.stringify(od.map(m=>m.body)).slice(0,200));
const bobMem=(await api(Bo.token,'GET',`/v1/workspaces/${W}/agents/${omni.id}/memory`)).j.files??[];
t('it keeps that in Bob’s own you folder',bobMem.some(f=>f.path.startsWith('/memories/you/')&&/green/i.test(f.body))&&!bobMem.some(f=>f.path.startsWith('/memories/team/')&&/green/i.test(f.body)),JSON.stringify(bobMem.map(f=>f.path)));
const annMem=(await api(A.token,'GET',`/v1/workspaces/${W}/agents/${omni.id}/memory`)).j.files??[];
t('which Ann, its sponsor, does not see',!annMem.some(f=>/green/i.test(f.body)),JSON.stringify(annMem.map(f=>f.path)));
r=await api(A.token,'POST',`/v1/workspaces/${W}/dms`,{userIds:[omni.id]});const ADM=r.j.id;
await say(A.token,ADM,'What is Bob’s favourite colour? If you do not know, say you do not know.');
const ad=await until(()=>msgs(A.token,ADM),(l)=>l.some(m=>m.userId===omni.id&&!m.systemKind),120000);
const reply=ad.find(m=>m.userId===omni.id&&!m.systemKind)?.body??'';
t('and Omni does not tell Ann',!!reply&&!/green/i.test(reply),reply);

console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
