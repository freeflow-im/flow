// End-to-end check of what the Admin app does (docs/specs/workspace-admin.md, phase 5), through the Worker's routes: an
// own domain's five steps to working mail against a DNS-over-HTTPS stub (served here on DOH_PORT, default 18897), the
// accounts' mail state and one account's provisioning, invitations as members and as chat guests, the pending list and a
// revoke, and a guest refused by Mail, Contacts and Docs while Chat works. Against a local `wrangler dev` with the fake
// provider (.dev.vars with EDGE_ORIGIN_SECRET=x and FLOW_DATA_KEY), on port 18797:
//   npx wrangler dev --port 18797 --local --enable-containers=false --var PORTED_HOSTS:edge.freeflow.im,localhost \
//     --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18797 \
//     --var MAIL_ALLOW_INSECURE:1 --var MAIL_PROVIDER:fake --var DNS_RESOLVER_URL:http://localhost:18897/dns-query > /tmp/edge-admin.log 2>&1 &
//   node test/e2e-admin.mjs /tmp/edge-admin.log
// It reads signup links from the Worker's log, because local mail goes there.
import fs from 'node:fs';
import http from 'node:http';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18797';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const api=async(tok,m,p,b,h={})=>{const r=await fetch(B+p,{method:m,redirect:'manual',headers:{...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':'application/json'}:{}),...h},body:b===undefined?undefined:JSON.stringify(b)});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
async function accountUntil(tok,org,until,ms){const end=Date.now()+ms;let a;for(;;){a=(await api(tok,'GET','/v1/me/accounts')).j.accounts?.find(x=>x.organizationId===org);if((a&&until(a))||Date.now()>end)return a;await sleep(250);}}
const tag=Date.now().toString(36);
const enc=encodeURIComponent;

// --- The DNS stub: what the admin "publishes" at the DNS host, as Cloudflare's DoH JSON answers it. -----------------------
/** name → { TXT: string[], MX: string[] } */
const zone=new Map();
const publish=(name,type,data)=>{const z=zone.get(name)??{TXT:[],MX:[]};z[type].push(data);zone.set(name,z);};
const doh=http.createServer((q,s)=>{const u=new URL(q.url,'http://x');const name=u.searchParams.get('name'),type=u.searchParams.get('type');const z=zone.get(name);s.setHeader('content-type','application/dns-json');
  const data=z?.[type]??[];s.end(JSON.stringify(data.length?{Status:0,Answer:data.map(d=>({name,type:type==='MX'?15:16,TTL:60,data:type==='TXT'?JSON.stringify(d):d}))}:{Status:3}));});
await new Promise(res=>doh.listen(Number(process.env.DOH_PORT||18897),'127.0.0.1',res));

try {
const cfg=(await api(null,'GET','/v1/config')).j;
t('config: hosted mail is on, with the provider\'s hosts for the Mail card',cfg.hostedMail===true&&typeof cfg.mail?.imapHost==='string'&&typeof cfg.mail?.smtpHost==='string',JSON.stringify(cfg).slice(0,160));

// --- The Admin app's page -------------------------------------------------------------------------------------------------
let r=await api(null,'GET','/admin');t('/admin sends a stranger to sign in',r.s===302&&r.h.get('location')===`/?next=${enc('/admin')}`,r.s+' '+r.h.get('location'));
r=await api(null,'GET','/admin/domains');t('so does /admin/domains, keeping the section',r.s===302&&r.h.get('location')===`/?next=${enc('/admin/domains')}`,r.s+' '+r.h.get('location'));

// --- Ann's organization -----------------------------------------------------------------------------------------------------
const A=await signup(`adm-ann-${tag}@example.com`,'Ann'),Bo=await signup(`adm-bob-${tag}@example.com`,'Bob'),G=await signup(`adm-gus-${tag}@example.com`,'Gus');
r=await api(A.token,'POST','/v1/workspaces',{name:`Adm ${tag}`,slug:`adm-${tag}`});const W=r.j.id;t('Ann creates an organization',r.s===201,r.s);
// Signed in, the page route serves the client (built and assembled into public/) rather than sending to sign in; without a
// build here the asset fetch fails, so only the redirect's absence is checked.
r=await api(null,'GET','/admin',undefined,{cookie:`sid=${A.token}`});t('/admin does not send a signed-in person to sign in',r.s!==302&&r.s!==401,r.s+' '+String(r.j).slice(0,60));
let ann=await accountUntil(A.token,W,(a)=>a.state==='active',15000);t('Ann\'s account reaches active with a hosted mailbox (the fake provider)',ann?.state==='active'&&ann.kind==='native',JSON.stringify(ann).slice(0,160));
r=await api(A.token,'GET',`/v1/workspaces/${W}/accounts`);const annAcct=r.j.accounts?.find(a=>a.principalId===A.user.id);
t('Ann’s assistant came with her account: a hosted personal agent, hers',(r.j.accounts??[]).some(a=>a.kind==='personal_agent'&&a.agentRuntime==='hosted'&&a.sponsorId===A.user.id&&a.address===null),JSON.stringify((r.j.accounts??[]).map(a=>[a.kind,a.agentRuntime])).slice(0,160));
t('the accounts list carries hosted for the Mail column',r.s===200&&annAcct?.hosted===true&&annAcct.state==='active',JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'PATCH',`/v1/workspaces/${W}`,{name:`Adm ${tag} Rockets`});t('the name can be changed; the slug stays',r.s===200&&r.j.name===`Adm ${tag} Rockets`&&r.j.slug===`adm-${tag}`,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'PATCH',`/v1/workspaces/${W}`,{policies:{defaultAccountKind:'guest'}});t('the retired default-kind policy is refused',r.s===400,r.s+' '+JSON.stringify(r.j).slice(0,100));

// --- The domain card's five steps (§4.1) ------------------------------------------------------------------------------------
const D=`/v1/workspaces/${W}/domains`;const DOM=`acme-${tag}.test`;
r=await api(A.token,'GET',D);const pd=r.j.domains?.[0];t('the platform domain is listed with atProvider (true once the first mailbox was made)',pd?.kind==='platform'&&pd.atProvider===true&&pd.primary===true,JSON.stringify(pd).slice(0,160));
r=await api(A.token,'POST',D,{domain:DOM});const added=r.j;const vt=added.records?.find(x=>x.purpose==='verification');
t('step 1: added, not verified, not at the provider, with its records and their status',r.s===201&&added.verified===false&&added.atProvider===false&&vt&&added.status?.length===added.records?.length,r.s+' '+JSON.stringify(added).slice(0,160));
r=await api(A.token,'POST',`${D}/${DOM}/verify`);t('step 2 before the TXT: not verified, nothing found',r.s===200&&r.j.verified===false&&r.j.found?.length===0,JSON.stringify(r.j));
publish(vt.name,'TXT',vt.value);
r=await api(A.token,'POST',`${D}/${DOM}/verify`);t('step 2: verified once the ownership TXT is in DNS',r.s===200&&r.j.verified===true,JSON.stringify(r.j));
// Step 3: the mail records (the fake provider wants no ownership record of its own).
for(const x of added.records.filter(x=>x.purpose==='mx'||x.purpose==='spf'||x.purpose==='dmarc'))publish(x.name,x.type,x.type==='MX'?`${x.priority} ${x.value}`:x.value);
await sleep(5200);r=await api(A.token,'GET',`${D}?refresh=1`);let d=r.j.domains?.find(x=>x.domain===DOM);
const statusOf=(p)=>d?.records.map((x,i)=>[x.purpose,d.status[i]?.record]).filter(([q])=>q===p).map(([,s])=>s);
t('step 3: the checker finds MX, SPF and DMARC',d?.verified===true&&statusOf('mx').every(s=>s==='present')&&statusOf('spf')[0]==='present'&&statusOf('dmarc')[0]==='present'&&d.records.every(x=>x.purpose!=='dkim'),JSON.stringify(d?.records.map((x,i)=>[x.purpose,d.status[i]?.record])));
r=await api(Bo.token,'POST',`${D}/${DOM}/dkim`);t('a stranger to the organization cannot turn mail on',r.s===403||r.s===404,r.s);
r=await api(A.token,'POST',`${D}/${DOM}/dkim`);const dk=r.j.record;t('step 4: Turn on mail makes the domain at the provider and returns the signing record',r.s===200&&dk?.purpose==='dkim'&&dk.name===`${r.j.selector}._domainkey.${DOM}`,r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'GET',D);d=r.j.domains?.find(x=>x.domain===DOM);t('the list says atProvider, with the signing record still missing in DNS',d?.atProvider===true&&statusOf('dkim')[0]==='missing',JSON.stringify([d?.atProvider,statusOf('dkim')]));
publish(dk.name,'TXT',dk.value);await sleep(5200);r=await api(A.token,'GET',`${D}?refresh=1`);d=r.j.domains?.find(x=>x.domain===DOM);
t('step 5: the signing record is found; every step is done',statusOf('dkim')[0]==='present'&&d.status.every(s=>s.record==='present'),JSON.stringify(d?.status));
r=await api(A.token,'PATCH',`${D}/${DOM}`,{primary:true});t('Make primary',r.s===200&&r.j.primary===true,r.s);
r=await api(A.token,'DELETE',`${D}/${DOM}`);t('a primary domain cannot be removed',r.s===409&&r.j.error?.code==='domain_primary',r.s+' '+JSON.stringify(r.j).slice(0,80));

// --- Invitations: members and chat guests, the pending list, a revoke (§3.2, §6.3, §6.5) ---------------------------------
const I=`/v1/workspaces/${W}/invites`;
r=await api(A.token,'POST',I,{emails:[`adm-bob-${tag}@example.com`]});const bobTok=(r.j.results?.[0]?.inviteUrl??'').split('/').pop();
t('Bob is invited as a member (kind native)',r.s===201&&r.j.results?.[0]?.kind==='native'&&!!bobTok,r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'POST',I,{emails:[`adm-gus-${tag}@example.com`],kind:'guest'});const gusTok=(r.j.results?.[0]?.inviteUrl??'').split('/').pop();
t('Gus is invited as a chat guest',r.s===201&&r.j.results?.[0]?.kind==='guest'&&!!gusTok,r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'POST',I,{emails:[`adm-zed-${tag}@example.com`],kind:'guest'});const zedTok=(r.j.results?.[0]?.inviteUrl??'').split('/').pop();
r=await api(A.token,'GET',I);const pending=r.j.invites??[];
t('the pending list has the three, with kinds and the inviter',r.s===200&&pending.length===3&&pending.find(i=>i.email===`adm-gus-${tag}@example.com`)?.kind==='guest'&&pending.find(i=>i.email===`adm-bob-${tag}@example.com`)?.kind==='native'&&pending.every(i=>i.invitedBy?.displayName==='Ann'),JSON.stringify(pending).slice(0,170));
r=await api(Bo.token,'GET',I);t('a stranger cannot list them',r.s===403||r.s===404,r.s);
const zed=pending.find(i=>i.email===`adm-zed-${tag}@example.com`);r=await api(A.token,'DELETE',`${I}/${zed?.id}`);t('Ann revokes Zed\'s',r.s===200,r.s);
r=await api(A.token,'GET',I);t('the list has two left',r.j.invites?.length===2&&!r.j.invites.some(i=>i.email===`adm-zed-${tag}@example.com`),JSON.stringify(r.j.invites?.map(i=>i.email)));
const Z=await signup(`adm-zed-${tag}@example.com`,'Zed');r=await api(Z.token,'POST','/v1/invites/accept',{token:zedTok});t('the revoked link no longer works',r.s===404,r.s);
r=await api(Bo.token,'POST','/v1/invites/accept',{token:bobTok});t('Bob accepts',r.s<300,r.s);
r=await api(G.token,'POST','/v1/invites/accept',{token:gusTok});t('Gus accepts',r.s<300,r.s);
r=await api(A.token,'GET',I);t('the pending list is empty',r.j.invites?.length===0,JSON.stringify(r.j));
const bob=await accountUntil(Bo.token,W,(a)=>a.state==='active',15000);
t('Bob is a native member with an address on the primary domain',bob?.kind==='native'&&bob.address===`bob@${DOM}`&&bob.state==='active',JSON.stringify(bob).slice(0,140));
const gus=await accountUntil(G.token,W,(a)=>!!a,5000);
t('Gus is a guest: no address, active at once, nothing to provision',gus?.kind==='guest'&&gus.address===null&&gus.state==='active',JSON.stringify(gus).slice(0,140));

// --- Guests use Chat only (§6.5) ----------------------------------------------------------------------------------------------
r=await api(G.token,'GET',`/v1/workspaces/${W}/members`);t('Chat: Gus lists the members',r.s===200&&r.j.members?.some(m=>m.userId===G.user.id),r.s);
r=await api(G.token,'GET',`/v1/mail/accounts?workspace=${W}`);t('Mail refuses a guest with 403 guest',r.s===403&&r.j.error?.code==='guest',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(G.token,'GET',`/v1/contacts?workspace=${W}`);t('so does Contacts',r.s===403&&r.j.error?.code==='guest',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(G.token,'GET',`/v1/calendar/accounts?workspace=${W}`);t('and Calendar',r.s===403&&r.j.error?.code==='guest',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(G.token,'GET',`/api/sheets?workspace=${W}`);t('Docs answers a guest 403 in its own error shape',r.s===403&&typeof r.j.error==='string'&&/guest/i.test(r.j.error),r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(Bo.token,'GET',`/v1/mail/accounts?workspace=${W}`);t('a member is let in',r.s===200,r.s);

// --- Accounts: kinds and one account's provisioning (§5, §6.4) --------------------------------------------------------------
r=await api(A.token,'GET',`/v1/workspaces/${W}/accounts`);const acc=r.j.accounts??[];const bobAcct=acc.find(a=>a.principalId===Bo.user.id),gusAcct=acc.find(a=>a.principalId===G.user.id);
t('the accounts list: Bob hosted, Gus a guest without a mailbox',bobAcct?.hosted===true&&gusAcct?.kind==='guest'&&gusAcct.hosted===false,JSON.stringify(acc.map(a=>[a.displayName,a.kind,a.hosted])));
r=await api(A.token,'POST',`/v1/workspaces/${W}/accounts/${gusAcct?.id}/provision`,{});t('a guest cannot be sent to be set up (409 guest)',r.s===409&&r.j.error?.code==='guest',r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'POST',`/v1/workspaces/${W}/accounts/${bobAcct?.id}/provision`,{});t('an account with a mailbox is left alone (queued false)',r.s===200&&r.j.queued===false,r.s+' '+JSON.stringify(r.j));
r=await api(Bo.token,'POST',`/v1/workspaces/${W}/accounts/${bobAcct?.id}/provision`,{});t('a member cannot',r.s===403,r.s);
r=await api(A.token,'PATCH',`/v1/workspaces/${W}/accounts/${gusAcct?.id}/kind`,{kind:'native'});t('Gus made native gets an address on the primary domain and is sent to be set up',r.s===200&&r.j.account?.kind==='native'&&r.j.account.address===`gus@${DOM}`,r.s+' '+JSON.stringify(r.j).slice(0,140));
const gusNative=await accountUntil(G.token,W,(a)=>a.hosted===true||a.state==='active',15000);
r=await api(G.token,'GET',`/v1/mail/accounts?workspace=${W}`);t('and Mail lets him in now',r.s===200,r.s+' '+JSON.stringify(gusNative).slice(0,100));
// The member list is the Org's (decision_log 2026-11-11): each native person's assistant is on it, as a personal agent.
r=await api(A.token,'GET',`/v1/workspaces/${W}/members?all=1`);{const ms=r.j.members??[];const asst=(id)=>ms.find(m=>m.kind==='personal_agent'&&m.agentRuntime==='hosted'&&m.sponsorId===id);
t('the full list holds each member’s assistant, as a personal agent with its sponsor',r.s===200&&!!asst(A.user.id)&&!!asst(Bo.user.id)&&!!asst(G.user.id),JSON.stringify(ms.map(m=>[m.displayName,m.kind,m.agentRuntime??''])));
globalThis.annAsst=asst(A.user.id);globalThis.bobAsst=asst(Bo.user.id);}
r=await api(Bo.token,'POST',`/v1/workspaces/${W}/dms`,{userIds:[annAsst?.userId]});t('Bob cannot DM Ann’s assistant',r.s===403,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST',`/v1/workspaces/${W}/dms`,{userIds:[annAsst?.userId]});t('Ann can DM her own',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST',`/v1/events/subscriptions?workspace=${W}`,{name:'poke',delivery:'wake',consumer:bobAsst?.accountId,filter:{},action:{kind:'wake',prompt:'hello'}});t('an owner cannot point an automation at Bob’s assistant',r.s===403,r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'POST',`/v1/workspaces/${W}/accounts/kind`,{kind:'guest',all:true});t('Make every member a guest: Bob and Gus',r.s===200&&r.j.changed===2,r.s+' '+JSON.stringify(r.j));
r=await api(Bo.token,'GET',`/v1/mail/accounts?workspace=${W}`);t('Bob, a guest now, is refused by Mail',r.s===403&&r.j.error?.code==='guest',r.s);
// A guest has no assistant (agents.md §6): Bob's and Gus's are set aside; Ann's stays.
r=await api(A.token,'GET',`/v1/workspaces/${W}/accounts`);{const live=(r.j.accounts??[]).filter(a=>a.kind==='personal_agent'&&a.agentRuntime==='hosted');t('the guests’ assistants are set aside, the owner’s stays',live.length===1&&live[0].sponsorId===A.user.id,JSON.stringify(live.map(a=>a.sponsorId)));}
r=await api(Bo.token,'GET',`/api/agent/agents?workspace=${W}`);t('and Bob, a guest, is refused the assistant',r.s===403,r.s);
r=await api(A.token,'GET',`/v1/workspaces/${W}/members?all=1`);{const ms=r.j.members??[];t('guests on the Org’s list, with no assistant there',ms.filter(m=>m.kind==='guest').length===2&&!ms.some(m=>m.kind==='personal_agent'&&(m.sponsorId===Bo.user.id||m.sponsorId===G.user.id)),JSON.stringify(ms.map(m=>[m.displayName,m.kind])));}
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/members`);t('Chat’s own list still answers a guest',r.s===200,r.s);
// Removing members: the directory's accounts follow the Org's list, and reconcile finds nothing left behind (outbox.ts).
r=await api(A.token,'DELETE',`/v1/workspaces/${W}/members/${Bo.user.id}`);t('Ann removes Bob',r.s===200,r.s);
r=await api(A.token,'GET',`/v1/workspaces/${W}/accounts`);t('and his account and assistant leave the directory with him',!(r.j.accounts??[]).some(a=>a.principalId===Bo.user.id||a.sponsorId===Bo.user.id),JSON.stringify((r.j.accounts??[]).map(a=>a.displayName)));
r=await api(A.token,'POST',`/v1/workspaces/${W}/accounts/reconcile`,{});t('reconcile (a dry run) finds nothing the outbox lost',r.s===200&&r.j.applied===false&&Array.isArray(r.j.removed)&&r.j.removed.length===0,r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(G.token,'POST',`/v1/workspaces/${W}/accounts/reconcile?apply=1`,{});t('a guest cannot reconcile',r.s===403,r.s);
} finally { doh.close(); }
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
