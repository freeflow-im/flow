// The web-to-app sign-in handoff (/v1/auth/handoff/*) and the built-in help (/v1/help/*), against a local `wrangler dev`
// started as test/e2e.mjs says, with the handoff's return URLs for this address:
//   ... --local-upstream localhost:18796 --var FLOW_HANDOFF_RETURN_URLS:flow://signin,http://localhost:18796/ > /tmp/edge.log 2>&1 &
// (--local-upstream: otherwise wrangler rewrites the Origin header to the first route's host, edge.freeflow.im.)
//   node test/e2e-native.mjs /tmp/edge.log
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
const log=process.argv[2]; const B='http://localhost:18796';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const api=async(m,p,b,h={})=>{const r=await fetch(B+p,{method:m,headers:{...(b?{'content-type':'application/json'}:{}),...h},body:b?JSON.stringify(b):undefined});return {s:r.status,h:r.headers,j:await r.json().catch(()=>null)};};
const opaque=()=>randomBytes(32).toString('base64url');
const challengeOf=v=>createHash('sha256').update(v).digest('base64url');

// ---- help
let r=await api('GET','/v1/help/topics');const topics=r.j?.topics??[];
t('help topics',r.s===200&&topics.length>3&&topics.every(x=>x.slug&&x.title&&typeof x.order==='number'),JSON.stringify(topics).slice(0,160));
t('topics in order',topics.every((x,i)=>i===0||topics[i-1].order<x.order||(topics[i-1].order===x.order&&topics[i-1].slug<x.slug)));
t('What\'s New is a topic',topics.some(x=>x.slug==='whats-new'&&x.title==="What's New"&&x.order===90));
const home=fs.readFileSync(new URL('../../../docs/help/home.md',import.meta.url),'utf8');
r=await api('GET','/v1/help/pages/home');
t('a page is its file without front-matter',r.s===200&&r.j.slug==='home'&&r.j.markdown===home.replace(/^---\n[\s\S]*?\n---\n?/,'').trim()+'\n',JSON.stringify(r.j).slice(0,120));
let all=true;for(const x of topics){const p=await api('GET','/v1/help/pages/'+x.slug);if(p.s!==200||p.j.title!==x.title||!p.j.markdown.endsWith('\n'))all=false;}t('every topic has its page',all);
r=await api('GET','/v1/help/pages/whats-new');t('What\'s New from the changelog',r.s===200&&r.j.markdown.startsWith("# What's new in Flow"),r.j?.markdown?.slice(0,60));
r=await api('GET','/v1/help/pages/no-such-page');t('unknown page 404',r.s===404&&r.j?.error?.code==='not_found',r.s+' '+JSON.stringify(r.j));
r=await api('GET','/v1/help/pages/..%2Fhome');t('unsafe slug 404',r.s===404,r.s);

// ---- handoff
r=await api('GET','/v1/client-info');t('client-info offers the handoff',r.j?.capabilities?.authHandoff===true,JSON.stringify(r.j?.capabilities));
const email=`native-${Date.now().toString(36)}@example.com`;
await api('POST','/v1/auth/register',{email});await sleep(400);
const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);
const {j:{token,user}}=await api('POST','/v1/auth/register/complete',{token:m[1],displayName:'Nat',password:'correct-horse-battery'});
t('signed up',!!token);

// A native app (the Mac app's ServerDiscovery): no Origin, a null client origin, flow://signin.
const native={connectionId:crypto.randomUUID(),operationId:opaque(),state:opaque(),serverOrigin:B,clientOrigin:null,returnUrl:'flow://signin'};
const verifier=opaque();
r=await api('POST','/v1/auth/handoff/start',{...native,codeChallenge:challengeOf(verifier),codeChallengeMethod:'S256'});
t('start',r.s===201&&r.j.requestId&&r.j.expiresAt&&r.h.get('cache-control')==='no-store',r.s+' '+JSON.stringify(r.j));
const bound={...native,requestId:r.j.requestId};
r=await api('POST','/v1/auth/handoff/approve',bound);t('approve needs a session',r.s===401,r.s);
r=await api('POST','/v1/auth/handoff/approve',bound,{authorization:'Bearer '+token});
const cb=r.j?.callbackUrl?new URL(r.j.callbackUrl):null;
t('approve returns to the app with a code',r.s===200&&cb?.href.startsWith('flow://signin?')&&cb.searchParams.get('state')===native.state&&cb.searchParams.get('operationId')===native.operationId,r.s+' '+JSON.stringify(r.j));
const code=cb?.searchParams.get('code');
r=await api('POST','/v1/auth/handoff/approve',bound,{authorization:'Bearer '+token});t('approved once',r.s===401,r.s);
r=await api('POST','/v1/auth/handoff/exchange',{...bound,code,codeVerifier:opaque()});t('a wrong verifier is refused',r.s===401,r.s+' '+JSON.stringify(r.j));
r=await api('POST','/v1/auth/handoff/exchange',{...bound,code,codeVerifier:verifier},{'user-agent':'Flow e2e'});
t('exchange signs in as the person',r.s===200&&r.j.token&&r.j.user?.id===user.id&&/sid=/.test(r.h.get('set-cookie')??''),r.s+' '+JSON.stringify(r.j).slice(0,100));
const session=r.j?.token;
r=await api('GET','/v1/me',null,{authorization:'Bearer '+session});t('the new session works',r.s===200&&r.j.email===email,r.s);
r=await api('POST','/v1/auth/handoff/exchange',{...bound,code,codeVerifier:verifier});t('exchanged once',r.s===401,r.s);

// The web client's popup (browserSignIn): its own origin, bound and sent as Origin.
const web={connectionId:crypto.randomUUID(),operationId:opaque(),state:opaque(),serverOrigin:B,clientOrigin:B,returnUrl:B+'/'};
const v2=opaque();
r=await api('POST','/v1/auth/handoff/start',{...web,codeChallenge:challengeOf(v2),codeChallengeMethod:'S256'});t('a browser must send the origin it binds',r.s===400&&r.j.error.code==='handoff_origin',r.s+' '+JSON.stringify(r.j));
r=await api('POST','/v1/auth/handoff/start',{...web,codeChallenge:challengeOf(v2),codeChallengeMethod:'S256'},{origin:B});t('web start',r.s===201,r.s+' '+JSON.stringify(r.j));
const wb={...web,requestId:r.j.requestId};
r=await api('POST','/v1/auth/handoff/approve',wb,{authorization:'Bearer '+token});const wcode=r.j?.callbackUrl&&new URL(r.j.callbackUrl).searchParams.get('code');
t('web approve returns to the page',r.s===200&&r.j.callbackUrl.startsWith(B+'/?code='),r.j?.callbackUrl);
r=await api('POST','/v1/auth/handoff/exchange',{...wb,code:wcode,codeVerifier:v2});t('exchange from another origin refused',r.s===400&&r.j.error.code==='handoff_origin',r.s);
r=await api('POST','/v1/auth/handoff/exchange',{...wb,code:wcode,codeVerifier:v2},{origin:B});t('web exchange',r.s===200&&r.j.user?.id===user.id,r.s+' '+JSON.stringify(r.j).slice(0,80));

// What the server refuses, the Worker refuses the same way.
r=await api('POST','/v1/auth/handoff/start',{...native,returnUrl:'flow://elsewhere',codeChallenge:challengeOf(verifier),codeChallengeMethod:'S256'});t('return URL not allowlisted',r.s===400&&r.j.error.code==='handoff_return',r.s+' '+JSON.stringify(r.j));
r=await api('POST','/v1/auth/handoff/start',{...native,serverOrigin:'https://app.freeflow.im',codeChallenge:challengeOf(verifier),codeChallengeMethod:'S256'});t('another server refused',r.s===400&&r.j.error.code==='handoff_origin',r.s);
r=await api('POST','/v1/auth/handoff/start',{...native,codeChallenge:challengeOf(verifier),codeChallengeMethod:'plain'});t('only S256',r.s===400&&r.j.error.code==='validation',r.s+' '+JSON.stringify(r.j));
r=await api('POST','/v1/auth/handoff/start',{...native,codeChallenge:challengeOf(verifier),codeChallengeMethod:'S256'},{origin:'app://flow'});t('the desktop app signs in as a native app',r.s===201,r.s+' '+JSON.stringify(r.j));
let limited=false;for(let i=0;i<30&&!limited;i++){r=await api('POST','/v1/auth/handoff/start',{...native,codeChallenge:challengeOf(verifier),codeChallengeMethod:'S256'});limited=r.s===429;}
t('starts are rate limited',limited&&r.j.error.code==='rate_limited',r.s);
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
