// End-to-end check of provisioning (platform.md §3.4, phase 5.3: src/provisioning) through the Worker, the directory, the
// `flow-provisioning` Queue and the account's Mail and Calendar objects, with the fake mail provider against a GreenMail
// whose REST API is reachable (the fake makes each mailbox a GreenMail user). The shared `flow-greenmail` publishes no API
// port, so this uses a second one:
//   docker run -d --name flow-greenmail-api -p 3026:3025 -p 3144:3143 -p 8081:8080 \
//     -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled" greenmail/standalone:2.1.3
// and a local `wrangler dev` as test/e2e.mjs says (.dev.vars with EDGE_ORIGIN_SECRET=x and FLOW_DATA_KEY), on port 18797:
//   npx wrangler dev --port 18797 --local --enable-containers=false --var PORTED_HOSTS:edge.freeflow.im,localhost \
//     --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18797 \
//     --var MAIL_ALLOW_INSECURE:1 --var MAIL_PROVIDER:fake --var GREENMAIL_API_URL:http://127.0.0.1:8081 \
//     --var GREENMAIL_IMAP_PORT:3144 --var GREENMAIL_SMTP_PORT:3026 > /tmp/edge-prov.log 2>&1 &
//   node test/e2e-provisioning.mjs /tmp/edge-prov.log
// (B=http://localhost:<port> for another port, GM=http://127.0.0.1:<port> for another GreenMail API, SECRET= for another
// EDGE_ORIGIN_SECRET.) It reads signup links from the Worker's log, because local mail goes there.
import fs from 'node:fs';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18797', GM=process.env.GM??'http://127.0.0.1:8081', SECRET=process.env.SECRET??'x';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const api=async(tok,m,p,b,h={})=>{const r=await fetch(B+p,{method:m,headers:{...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':'application/json'}:{}),...h},body:b===undefined?undefined:JSON.stringify(b)});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
/** The caller's account in the organization, polled until `until` holds or `ms` pass; with the states seen on the way. */
async function accountUntil(tok,org,until,ms){const seen=[];const end=Date.now()+ms;let a;for(;;){a=(await api(tok,'GET','/v1/me/accounts')).j.accounts?.find(x=>x.organizationId===org);if(a&&seen.at(-1)!==a.state)seen.push(a.state);if((a&&until(a))||Date.now()>end)return{a,seen};await sleep(250);}}
const providerLog=async()=>(await api(null,'GET','/v1/admin/mailprovider/log',undefined,{'x-edge-secret':SECRET})).j.calls??[];
const tag=Date.now().toString(36);

r0: {
const cfg=(await api(null,'GET','/v1/config')).j;t('config says hosted mail is on',cfg.hostedMail===true,JSON.stringify(cfg));
const A=await signup(`prov-ann-${tag}@example.com`,'Ann'),Bo=await signup(`prov-bob-${tag}@example.com`,'Bob');t('sign up Ann and Bob',A.token&&Bo.token);
let r=await api(A.token,'POST','/v1/workspaces',{name:`Prov ${tag}`,slug:`prov-${tag}`});const W=r.j.id;t('Ann creates an organization',r.s===201,r.s);
let t0=Date.now();let {a:ann,seen}=await accountUntil(A.token,W,(a)=>a.state==='active',15000);
t('Ann\'s account reaches active within 15 s',ann?.state==='active',`${Date.now()-t0} ms, states ${seen.join(' → ')}`);
t('her address is on the platform subdomain',ann?.address===`ann@prov-${tag}.freeflow.im`,ann?.address);
r=await api(A.token,'GET','/v1/mail/accounts');const annBox=r.j.accounts?.[0];
t('Mail lists one hosted account at her address',r.s===200&&r.j.accounts?.length===1&&annBox?.kind==='hosted'&&annBox.email===ann?.address&&annBox.imap?.port===3144&&annBox.smtp?.port===3026,r.s+' '+JSON.stringify(r.j).slice(0,170));
t('the password is never shown',!JSON.stringify(r.j).includes('password'));
r=await api(A.token,'PATCH',`/v1/mail/accounts/${annBox?.id}`,{password:'mine-now'});t('she cannot change its password',r.s===403&&r.j.error?.code==='hosted_account',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'DELETE',`/v1/mail/accounts/${annBox?.id}`);t('nor remove it',r.s===403&&r.j.error?.code==='hosted_account',r.s);
r=await api(A.token,'GET',`/v1/mail/accounts/${annBox?.id}/folders`);t('its folders come from GreenMail',r.s===200&&r.j.folders?.[0]?.path==='INBOX',r.s+' '+JSON.stringify(r.j).slice(0,120));
const users=await fetch(GM+'/api/user').then(x=>x.json()).catch(e=>String(e));t('GreenMail has her as a user, made through its API',Array.isArray(users)&&users.some(u=>u.email===ann?.address),JSON.stringify(users).slice(0,160));

// Bob by invitation, an agent by its code: the same path.
r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{email:`prov-bob-${tag}@example.com`});const inv=(r.j.inviteUrl??'').split('/').pop();
r=await api(Bo.token,'POST','/v1/invites/accept',{token:inv});t('Bob accepts an invitation',r.s<300,r.s);
r=await api(A.token,'POST',`/v1/workspaces/${W}/agent-invites`,{});r=await api(null,'POST','/v1/agents/redeem',{code:r.j.code,username:`provbot${tag}`,key:'a-long-agent-key-for-provisioning',name:'Provbot'});const AGT=r.j.agentToken;t('an agent joins',r.s===201&&!!AGT,r.s);
t0=Date.now();const [bob,bot]=await Promise.all([accountUntil(Bo.token,W,(a)=>a.state==='active',15000),accountUntil(AGT,W,(a)=>a.state==='active',15000)]);
t('Bob reaches active',bob.a?.state==='active',`${Date.now()-t0} ms, ${bob.seen.join(' → ')}`);
t('the agent reaches active at its own address',bot.a?.state==='active'&&bot.a.address===`provbot${tag}@prov-${tag}.freeflow.im`,`${bot.seen.join(' → ')} ${bot.a?.address}`);
r=await api(AGT,'GET','/v1/mail/accounts');t('the agent has a hosted mail account',r.j.accounts?.length===1&&r.j.accounts[0].kind==='hosted'&&r.j.accounts[0].email===bot.a?.address,JSON.stringify(r.j).slice(0,140));
r=await api(Bo.token,'GET','/v1/mail/accounts');const bobBox=r.j.accounts?.[0];t('so has Bob',bobBox?.kind==='hosted'&&bobBox.email===bob.a?.address,JSON.stringify(r.j).slice(0,140));

// Mail between two provisioned mailboxes.
const SUBJECT=`Hello from Bob ${tag}`;
r=await api(Bo.token,'POST',`/v1/mail/accounts/${bobBox?.id}/send`,{to:[{name:'Ann',address:ann?.address}],subject:SUBJECT,text:'Our first mail at the organization\'s address.'});
t('Bob sends a mail to Ann from his mailbox',r.s===200&&r.j.ok,r.s+' '+JSON.stringify(r.j).slice(0,140));
t0=Date.now();let got;while(!got&&Date.now()-t0<20000){r=await api(A.token,'GET',`/v1/mail/accounts/${annBox?.id}/messages?folder=INBOX&limit=20`);got=r.j.messages?.find(m=>m.subject===SUBJECT);if(!got)await sleep(500);}
t('Ann\'s inbox lists it within 20 s',!!got&&got.from?.address===bob.a?.address,`${Date.now()-t0} ms ${JSON.stringify(got??r.j).slice(0,140)}`);

// Agent mailboxes (phase 5.4): the agent reads its mailbox as the bridge does (?workspace=), is told of new mail on its
// own account, and replies as send_mail does.
r=await api(AGT,'GET',`/v1/mail/accounts?workspace=${W}`);const botBox=r.j.accounts?.find(a=>a.kind==='hosted');
t('the agent lists its hosted account, as the bridge asks',r.s===200&&botBox?.email===bot.a?.address,r.s+' '+JSON.stringify(r.j).slice(0,140));
const BP=`/v1/mail/accounts/${botBox?.id}`;
r=await api(AGT,'POST',`/v1/events/subscriptions?workspace=${W}`,{name:`mail-${tag}`,filter:{types:['mail.received'],self:true},delivery:'pull'});const SUB=r.j.subscription?.id;
t('the agent subscribes to mail.received on its own account',r.s===201&&!!SUB,r.s+' '+JSON.stringify(r.j).slice(0,120));
// One sync of the empty mailbox (the alarm, which the bridge's look at its accounts keeps running): what comes after is new mail.
r=await api(AGT,'GET',`${BP}/messages?folder=INBOX&limit=5&workspace=${W}`,undefined,{'x-mail-test-alarm':'1'});t('its inbox starts empty',r.s===200&&r.j.messages?.length===0,r.s+' '+JSON.stringify(r.j).slice(0,120));
const ASK=`For the agent ${tag}`;
r=await api(A.token,'POST',`/v1/mail/accounts/${annBox?.id}/send`,{to:[{name:'Provbot',address:bot.a?.address}],subject:ASK,text:'Can you send me the report?'});
t('Ann mails the agent from her mailbox',r.s===200&&r.j.ok,r.s+' '+JSON.stringify(r.j).slice(0,140));
t0=Date.now();let ev;while(!ev&&Date.now()-t0<20000){await api(AGT,'GET',`${BP}/messages?folder=INBOX&limit=5&workspace=${W}`,undefined,{'x-mail-test-alarm':'1'});r=await api(AGT,'GET',`/v1/events?workspace=${W}&since=0&limit=100&types=mail.received`);ev=r.j.events?.find(e=>e.data?.subject===ASK);if(!ev)await sleep(500);}
t('within 20 s the agent\'s one-shot read shows mail.received, naming the message',!!ev&&ev.data.accountId===botBox?.id&&ev.ref?.id===`${botBox?.id}:INBOX:${ev.data.uid}`&&ev.data.from?.address===ann?.address,`${Date.now()-t0} ms ${JSON.stringify(ev??r.j).slice(0,140)}`);
r=await api(AGT,'GET',`/v1/events/subscriptions/${SUB}?workspace=${W}&wait=0`);t('its account is the audience: the event is in its self subscription',r.s===200&&r.j.events?.some(e=>e.data?.subject===ASK),r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET',`/v1/events?workspace=${W}&since=0&limit=100&types=mail.received`);t('and not in Ann\'s read',r.s===200&&!r.j.events?.some(e=>e.data?.subject===ASK),JSON.stringify(r.j).slice(0,120));
r=await api(AGT,'GET',`${BP}/messages?folder=INBOX&limit=10&workspace=${W}`);const asked=r.j.messages?.find(m=>m.subject===ASK);
t('the agent\'s inbox lists Ann\'s mail',!!asked&&asked.from?.address===ann?.address&&ev?.data.uid===asked.uid,JSON.stringify(r.j).slice(0,140));
r=await api(AGT,'GET',`${BP}/messages/${asked?.uid}?folder=INBOX&workspace=${W}`);const askedId=r.j.message?.messageId;
r=await api(AGT,'POST',`${BP}/send?workspace=${W}`,{to:[{name:'Ann',address:ann?.address}],subject:`Re: ${ASK}`,html:'<p>Here it is.</p>',text:'Here it is.',...(askedId?{inReplyTo:askedId,references:[askedId]}:{})});
t('the agent replies from its mailbox',r.s===200&&r.j.ok&&!!askedId,r.s+' '+JSON.stringify(r.j).slice(0,140));
t0=Date.now();got=null;while(!got&&Date.now()-t0<20000){r=await api(A.token,'GET',`/v1/mail/accounts/${annBox?.id}/messages?folder=INBOX&limit=20`);got=r.j.messages?.find(m=>m.subject===`Re: ${ASK}`);if(!got)await sleep(500);}
t('Ann\'s inbox lists the agent\'s reply',!!got&&got.from?.address===bot.a?.address,`${Date.now()-t0} ms ${JSON.stringify(got??r.j).slice(0,140)}`);

r=await api(Bo.token,'POST',`/v1/workspaces/${W}/provision`,{});t('a member cannot send everyone to be provisioned',r.s===403,r.s);
r=await api(A.token,'POST',`/v1/workspaces/${W}/provision`,{});t('everyone has a mailbox: provision queues 0',r.s===200&&r.j.queued===0,r.s+' '+JSON.stringify(r.j));

// Removal suspends the mailbox at the provider; a rejoin resumes it.
const bobAddr=bob.a?.address;
r=await api(null,'GET','/v1/admin/mailprovider/log');t('the provider log wants the secret',r.s===403,r.s);
let calls=await providerLog();t('the provider made the domain once and three mailboxes',calls.filter(c=>c.method==='createDomain'&&c.args[0]===`prov-${tag}.freeflow.im`).length===1&&[ann?.address,bobAddr,bot.a?.address].every(x=>calls.some(c=>c.method==='createMailbox'&&c.args[0]?.address===x)),JSON.stringify(calls.map(c=>c.method)).slice(0,160));
t('no password reaches the log',!JSON.stringify(calls).includes('"password":"')||JSON.stringify(calls).match(/"password":"([^"]*)"/g).every(x=>x==='"password":"[redacted]"'));
r=await api(A.token,'DELETE',`/v1/workspaces/${W}/members/${Bo.user.id}`);t('Ann removes Bob',r.s===200,r.s);
t0=Date.now();let suspended;while(!suspended&&Date.now()-t0<10000){calls=await providerLog();suspended=calls.find(c=>c.method==='setMailboxState'&&c.args[0]===bobAddr&&c.args[1]==='suspended');if(!suspended)await sleep(250);}
t('the provider suspends Bob\'s mailbox',!!suspended,`${Date.now()-t0} ms`);
r=await api(Bo.token,'GET','/v1/me/accounts');t('his account is removed, its address kept',r.j.accounts?.find(a=>a.organizationId===W)?.state==='removed'&&r.j.accounts.find(a=>a.organizationId===W).address===bobAddr,JSON.stringify(r.j.accounts).slice(0,140));
r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{email:`prov-bob-${tag}@example.com`});r=await api(Bo.token,'POST','/v1/invites/accept',{token:(r.j.inviteUrl??'').split('/').pop()});
t0=Date.now();let resumed;while(!resumed&&Date.now()-t0<10000){calls=await providerLog();resumed=calls.find(c=>c.method==='setMailboxState'&&c.args[0]===bobAddr&&c.args[1]==='enabled');if(!resumed)await sleep(250);}
t('Bob rejoins: his mailbox is resumed, not made again',!!resumed&&calls.filter(c=>c.method==='createMailbox'&&c.args[0]?.address===bobAddr).length===1,`${Date.now()-t0} ms`);
r=await api(Bo.token,'GET','/v1/me/accounts');t('and his account is active again',r.j.accounts?.find(a=>a.organizationId===W)?.state==='active',JSON.stringify(r.j.accounts).slice(0,140));
}
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
