// End-to-end check of FreeFlow Contacts (phase 6.5), the fifth app, added by its manifest: its routes and object, its share
// grant, its tools at /mcp, a reference to a contact and its page, all through the Worker. Against a local `wrangler dev` of
// its own, with the clients assembled (node scripts/assemble.mjs) so /contacts/ has its page:
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars
//   npx wrangler dev --port 18797 --local --enable-containers=false --local-upstream localhost:18797 \
//     --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 \
//     --var WEB_URL_BASE:http://localhost:18797 --var FLOW_WEB_URL:http://localhost:18797 > /tmp/edge-contacts.log 2>&1 &
//   B=http://localhost:18797 node test/e2e-contacts.mjs /tmp/edge-contacts.log
// It reads signup links from the Worker's log. The Mail source (people written to) is unit-tested (src/contacts); here the
// people are Ann's own contacts and the organization's members.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18797';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,200):''));};
const api=async(tok,m,p,b,type,extra={})=>{const r=await fetch(B+p,{method:m,redirect:'manual',headers:{...extra,...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':type??'application/json'}:{})},body:b===undefined?undefined:(type?b:JSON.stringify(b))});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const form=(o)=>new URLSearchParams(o).toString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const enc=encodeURIComponent;

// --- Ann and Bob in one organization ---------------------------------------------------------------------------------------
const A=await signup(`ann-${tag}@example.com`,'Ann'),Bo=await signup(`bob-${tag}@example.com`,'Bob');
let r=await api(A.token,'POST','/v1/workspaces',{name:`Acme ${tag}`,slug:`acme-${tag}`});const W=r.j.id;
r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{email:`bob-${tag}@example.com`});const inv=(r.j.inviteUrl??'').split('/').pop();
r=await api(Bo.token,'POST','/v1/invites/accept',{token:inv});t('Ann and Bob in one organization',W&&r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,100));
const q=(p)=>`${p}${p.includes('?')?'&':'?'}workspace=${W}`;

// --- Own contacts, members, and the share ------------------------------------------------------------------------------------
r=await api(null,'GET',q('/v1/contacts'));t('no session: 401',r.s===401,r.s);
r=await api(A.token,'POST',q('/v1/contacts'),{name:`Zed Quill ${tag}`,emails:[`zed-${tag}@quill.test`],orgName:'Quill & Co'});
const ZED=r.j.contact;t('Ann adds a contact',r.s===201&&ZED?.source==='own'&&ZED.id?.includes(':'),r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET',q(`/v1/contacts/search?q=${enc('zed quill')}`));t('Ann finds it by searching',r.s===200&&r.j.contacts?.length===1&&r.j.contacts[0].id===ZED?.id,JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET',q('/v1/contacts'));const annBob=r.j.contacts?.find((c)=>c.source==='member');
t('Ann’s list has Bob as a member, with his address, and not herself',r.j.contacts?.filter((c)=>c.source==='member').length===1&&annBob?.name==='Bob'&&/@/.test(annBob.emails?.[0]??'')&&annBob.userId,JSON.stringify(r.j.contacts).slice(0,200));
r=await api(Bo.token,'GET',q(`/v1/contacts/search?q=${enc('zed quill')}`));t('Bob does not see Ann’s contact',r.s===200&&r.j.contacts?.length===0,JSON.stringify(r.j).slice(0,120));
const REF=`${W}/contacts/contact/${ZED?.id}`;
r=await api(Bo.token,'GET',`/v1/references?workspace=${W}&refs=${enc(REF)}`);t('Bob’s reference to it is denied before the share',r.s===200&&r.j.references?.[0]?.denied===true,JSON.stringify(r.j));
r=await api(A.token,'GET',`/v1/references?workspace=${W}&refs=${enc(REF)}`);const RA=r.j.references?.[0];
t('Ann’s resolves: the contact’s name, its chip and its page',RA?.title===`Zed Quill ${tag}`&&RA.role==='owner'&&RA.icon==='👤'&&RA.url===`/contacts/?contact=${enc(ZED?.id)}`,JSON.stringify(r.j));
r=await api(A.token,'GET',q('/v1/contacts/share'));t('not shared yet',r.j.org===false,JSON.stringify(r.j));
r=await api(A.token,'PUT',q('/v1/contacts/share'),{org:true});t('Ann shares her contacts with the organization',r.s===200&&r.j.org===true,r.s+' '+JSON.stringify(r.j));
r=await api(Bo.token,'GET',q(`/v1/contacts/search?q=${enc('zed quill')}`));const SH=r.j.contacts?.[0];
t('Bob now sees it, as shared, with Ann’s name',r.j.contacts?.length===1&&SH.source==='shared'&&SH.owner?.name==='Ann'&&SH.id===ZED?.id,JSON.stringify(r.j).slice(0,200));
r=await api(Bo.token,'GET',`/v1/references?workspace=${W}&refs=${enc(REF)}`);t('and his reference resolves, as viewer',r.j.references?.[0]?.title===`Zed Quill ${tag}`&&r.j.references[0].role==='viewer',JSON.stringify(r.j));
r=await api(Bo.token,'PATCH',q(`/v1/contacts/${enc(ZED?.id)}`),{name:'Nope'});t('Bob cannot change it (it is not in his own object)',r.s===404,r.s);

// --- /mcp: the consent page offers Contacts, and a contacts:read token finds it -----------------------------------------------
r=await api(null,'POST','/oauth/register',{client_name:'Contacts E2E',redirect_uris:['http://localhost/callback']});const CLIENT=r.j.client_id;
const cookie=(u)=>({cookie:`sid=${u.token}`});
const pkce=()=>{const v=randomBytes(32).toString('base64url');return{v,c:createHash('sha256').update(v).digest('base64url')}};
const authorizeUrl=(c,extra={})=>'/oauth/authorize?'+form({response_type:'code',client_id:CLIENT,redirect_uri:'http://localhost:51234/callback',code_challenge:c,code_challenge_method:'S256',state:'xyz',resource:`${B}/mcp`,...extra});
const consentOf=(html)=>({p:/name="p" value="([^"]+)"/.exec(html)?.[1],csrf:/name="csrf" value="([^"]+)"/.exec(html)?.[1]});
async function connect(u,extra={}){const {v,c}=pkce();let x=await api(null,'GET',authorizeUrl(c,extra),undefined,undefined,cookie(u));const page=await api(null,'GET',x.h.get('location'),undefined,undefined,cookie(u));const f=consentOf(page.j);
  x=await api(null,'POST','/oauth/decision',form({p:f.p,csrf:f.csrf,org:W,allow:'yes'}),'application/x-www-form-urlencoded',{...cookie(u),origin:B});const code=new URL(x.h.get('location')).searchParams.get('code');
  return {page:page.j,token:(await api(null,'POST','/oauth/token',form({grant_type:'authorization_code',code,code_verifier:v,client_id:CLIENT,redirect_uri:'http://localhost:51234/callback'}),'application/x-www-form-urlencoded')).j};}
let rpcId=0;
const mcp=async(tok,method,params={})=>api(tok,'POST','/mcp',{jsonrpc:'2.0',id:++rpcId,method,params},undefined,{accept:'application/json, text/event-stream'});
const call=async(tok,name,args)=>{const x=await mcp(tok,'tools/call',{name,arguments:args});const text=x.j?.result?.content?.[0]?.text;let v;try{v=JSON.parse(text)}catch{v=text}return{...x,v,isError:x.j?.result?.isError}};
const ALL=await connect(A);
t('the consent page offers Contacts, ticked',/name="grant_contacts" value="on" checked/.test(ALL.page)&&ALL.page.includes('Contacts: see and add contacts'),/grant_contacts[^>]*/.exec(ALL.page)?.[0]);
t('and the token has the contacts scopes',ALL.token.scope?.split(' ').includes('contacts:read')&&ALL.token.scope.split(' ').includes('contacts:write'),ALL.token.scope);
const RO=await connect(A,{scope:'contacts:read'});
t('asked for contacts:read only, the page says so',RO.page.includes('Contacts: see your contacts')&&RO.token.scope==='contacts:read',RO.token.scope);
r=await mcp(RO.token.access_token,'tools/list');const names=(r.j.result?.tools??[]).map((x)=>x.name);
t('a contacts:read token lists list_contacts and find_contact, not add_contact, nor anything else',JSON.stringify(names.sort())===JSON.stringify(['find_contact','list_contacts']),names.join(','));
r=await call(RO.token.access_token,'find_contact',{q:`quill ${tag}`});t('find_contact finds Ann’s contact',!r.isError&&r.v?.contacts?.[0]?.id===ZED?.id&&r.v.contacts[0].source==='own',JSON.stringify(r.v??r.j).slice(0,200));
r=await call(RO.token.access_token,'find_contact',{q:'bob'});t('and a member, by name',r.v?.contacts?.some((c)=>c.source==='member'&&c.name==='Bob'),JSON.stringify(r.v).slice(0,160));
r=await call(RO.token.access_token,'add_contact',{name:'X'});t('add_contact is not there without contacts:write',r.isError===true||!!r.j.error,JSON.stringify(r.j).slice(0,120));
r=await call(ALL.token.access_token,'add_contact',{name:`Yan ${tag}`,emails:[`yan-${tag}@far.test`]});t('add_contact with contacts:write',!r.isError&&r.v?.added?.source==='own'&&r.v.url?.includes('/contacts/?contact='),JSON.stringify(r.v??r.j).slice(0,160));
r=await api(Bo.token,'GET',q(`/v1/contacts/search?q=${enc(`yan ${tag}`)}`));t('Bob sees the agent’s addition too, as the list is shared',r.j.contacts?.[0]?.source==='shared',JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'PUT',q('/v1/contacts/share'),{org:false});
r=await api(Bo.token,'GET',q(`/v1/contacts/search?q=${enc('zed quill')}`));t('Ann stops sharing: Bob sees nothing again',r.j.contacts?.length===0,JSON.stringify(r.j).slice(0,120));

// --- The page -------------------------------------------------------------------------------------------------------------
r=await api(null,'GET','/contacts/',undefined,undefined,cookie(A));t('/contacts/ is served to a signed-in person (the page route)',r.s===200&&r.h.get('content-type')?.startsWith('text/html')&&String(r.j).includes('<title>FreeFlow Contacts</title>'),r.s+' '+String(r.j).slice(0,80));
r=await api(null,'GET','/contacts/?contact=x');t('a stranger is sent to sign in',r.s===302&&r.h.get('location')===`/?next=${enc('/contacts/?contact=x')}`,r.s+' '+r.h.get('location'));
r=await api(null,'GET','/contacts/assets/nope.js',undefined,undefined,cookie(A));t('a file under it is not the page (it falls through to the built files, then the origin)',r.s!==200&&!String(r.j).includes('FreeFlow Contacts'),r.s);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
