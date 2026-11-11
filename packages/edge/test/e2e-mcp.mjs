// End-to-end check of Docs' MCP endpoint on the suite's host (routes/mcp.ts): OAuth in the directory with the choice of
// organization, then /mcp in that organization's Docs object. Against a local `wrangler dev` of its own:
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars; mkdir -p public; rm -rf .wrangler/state
//   npx wrangler dev --port 18799 --inspector-port 19299 --local --enable-containers=false --local-upstream localhost:18799 \
//     --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 \
//     --var WEB_URL_BASE:http://localhost:18799 --var FLOW_WEB_URL:http://localhost:18799 > /tmp/edge-mcp.log 2>&1 &
//   node test/e2e-mcp.mjs /tmp/edge-mcp.log
// It reads signup links from the Worker's log, because local mail goes there. --local-upstream keeps the request's own
// origin (http://localhost:18799), which is the OAuth issuer and resource.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { APP_MANIFESTS } from '@flow/shared/manifests';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18799';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const api=async(tok,m,p,b,type,extra={})=>{const r=await fetch(B+p,{method:m,redirect:'manual',headers:{...extra,...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':type??'application/json'}:{})},body:b===undefined?undefined:(type?b:JSON.stringify(b))});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const form=(o)=>new URLSearchParams(o).toString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);

// --- People and organizations: Olga owns Acme and Charlie; Uma owns Bravo and joins Acme -------------------------------------
const O=await signup(`olga-${tag}@example.com`,'Olga'),U=await signup(`uma-${tag}@example.com`,'Uma');
let r=await api(O.token,'POST','/v1/workspaces',{name:`Acme ${tag}`,slug:`acme-${tag}`});const A=r.j.id;
r=await api(U.token,'POST','/v1/workspaces',{name:`Bravo ${tag}`,slug:`bravo-${tag}`});const Bo=r.j.id;
r=await api(O.token,'POST','/v1/workspaces',{name:`Charlie ${tag}`,slug:`charlie-${tag}`});const Ch=r.j.id;
t('three organizations',A&&Bo&&Ch,JSON.stringify([A,Bo,Ch]));
r=await api(O.token,'POST',`/v1/workspaces/${A}/invites`,{email:`uma-${tag}@example.com`});const inv=(r.j.inviteUrl??'').split('/').pop();
r=await api(U.token,'POST','/v1/invites/accept',{token:inv});t('Uma joins Acme',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,100));

// --- Files: a spreadsheet in Acme's Organization files, and one in Bravo's ------------------------------------------------
r=await api(O.token,'POST',`/api/sheets?workspace=${A}&shared=1`,{title:`Acme Budget ${tag}`});const S=r.j.sheet?.id;t('a spreadsheet in Acme’s Organization files',r.s===200&&S,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(O.token,'GET',`/api/sheets/${S}`);const wb=r.j.sheet?.workbook??r.j.workbook;wb.tabs[0].cells={A1:{v:'Revenue'},B1:{v:'1200'}};
r=await api(O.token,'PUT',`/api/sheets/${S}`,{workbook:wb,base:r.j.sheet?.updatedAt??r.j.updatedAt});t('with some cells',r.s<300,r.s);
r=await api(U.token,'POST',`/api/sheets?workspace=${Bo}&shared=1`,{title:`Bravo Plans ${tag}`});const SB=r.j.sheet?.id;t('a spreadsheet in Bravo’s',r.s===200&&SB,r.s);

// --- Discovery and the challenge ------------------------------------------------------------------------------------------
r=await api(null,'GET','/.well-known/oauth-protected-resource/mcp');t('protected resource metadata names this origin',r.j.resource===`${B}/mcp`&&r.j.authorization_servers?.[0]===B,JSON.stringify(r.j));
r=await api(null,'GET','/.well-known/oauth-authorization-server');t('authorization server metadata',r.j.issuer===B&&r.j.registration_endpoint===`${B}/oauth/register`&&r.j.code_challenge_methods_supported?.includes('S256'),JSON.stringify(r.j).slice(0,140));
r=await api(null,'POST','/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'});t('no token: 401 pointing at the metadata',r.s===401&&r.h.get('www-authenticate')===`Bearer resource_metadata="${B}/.well-known/oauth-protected-resource/mcp"`,r.s+' '+r.h.get('www-authenticate'));
r=await api('nonsense','POST','/mcp',{jsonrpc:'2.0',id:1,method:'tools/list'});t('a bad token: invalid_token',r.s===401&&/error="invalid_token"/.test(r.h.get('www-authenticate')),r.h.get('www-authenticate'));

// --- Registration, then authorization with PKCE --------------------------------------------------------------------------
r=await api(null,'POST','/oauth/register',{client_name:'E2E Agent',redirect_uris:['http://localhost/callback']});const CLIENT=r.j.client_id;t('dynamic client registration',r.s===201&&CLIENT?.startsWith('dcr_'),r.s+' '+JSON.stringify(r.j).slice(0,100));
const cookie=(u)=>({cookie:`sid=${u.token}`});
const pkce=()=>{const v=randomBytes(32).toString('base64url');return{v,c:createHash('sha256').update(v).digest('base64url')}};
const authorizeUrl=(c,extra={})=>'/oauth/authorize?'+form({response_type:'code',client_id:CLIENT,redirect_uri:'http://localhost:51234/callback',code_challenge:c,code_challenge_method:'S256',state:'xyz',resource:`${B}/mcp`,...extra});
const consentOf=(html)=>({p:/name="p" value="([^"]+)"/.exec(html)?.[1],csrf:/name="csrf" value="([^"]+)"/.exec(html)?.[1],orgs:[...html.matchAll(/name="org" value="([^"]+)"/g)].map((m)=>m[1]),checked:/name="org" value="([^"]+)" checked/.exec(html)?.[1]});
/** The whole flow for a person and an organization, returning the token response. */
async function connect(u,org,extra={},fields={}){const {v,c}=pkce();let x=await api(null,'GET',authorizeUrl(c,extra),undefined,undefined,cookie(u));const page=await api(null,'GET',x.h.get('location'),undefined,undefined,cookie(u));const f=consentOf(page.j);connect.lastPage=page.j;
  x=await api(null,'POST','/oauth/decision',form({p:f.p,csrf:f.csrf,org,allow:'yes',...fields}),'application/x-www-form-urlencoded',{...cookie(u),origin:B});if(x.s!==302)return{error:x.s,body:x.j};const code=new URL(x.h.get('location')).searchParams.get('code');
  return (await api(null,'POST','/oauth/token',form({grant_type:'authorization_code',code,code_verifier:v,client_id:CLIENT,redirect_uri:'http://localhost:51234/callback'}),'application/x-www-form-urlencoded')).j;}

const {v:VER,c:CHAL}=pkce();
r=await api(null,'GET',authorizeUrl(CHAL));t('authorize without a session goes to FreeFlow’s sign-in, coming back to consent',r.s===302&&/^\/\?next=%2Foauth%2Fconsent%3Fp%3D/.test(r.h.get('location')),r.s+' '+r.h.get('location'));
const signInNext=decodeURIComponent(r.h.get('location').slice('/?next='.length));
r=await api(null,'GET',authorizeUrl(CHAL),undefined,undefined,cookie(U));const consentPath=r.h.get('location');t('with the session: straight to consent',r.s===302&&consentPath?.startsWith('/oauth/consent?p='),r.s+' '+consentPath);
r=await api(null,'GET',signInNext);t('the consent page without a session sends to sign-in again',r.s===302&&r.h.get('location')?.startsWith('/?next='),r.s);
r=await api(null,'GET',consentPath,undefined,undefined,cookie(U));const C=consentOf(r.j);
t('the consent page lists both of Uma’s organizations by name',r.s===200&&r.j.includes(`Acme ${tag}`)&&r.j.includes(`Bravo ${tag}`)&&C.orgs.length===2&&C.orgs.includes(A)&&C.orgs.includes(Bo),r.s+' '+JSON.stringify(C.orgs));
t('it names the client and the scopes, and one organization is preselected',r.j.includes('E2E Agent')&&r.j.includes('Organization files')&&r.j.includes('My files')&&[A,Bo].includes(C.checked),C.checked);
t('it offers the Events group, ticked',/name="grant_events" value="on" checked/.test(r.j)&&r.j.includes('Events: read the subscriptions you make'),/grant_events[^>]*/.exec(r.j)?.[0]);
t('it cannot be framed',r.h.get('x-frame-options')==='DENY'&&/frame-ancestors 'none'/.test(r.h.get('content-security-policy')??''),r.h.get('x-frame-options'));
if(process.env.CONSENT_HTML)fs.writeFileSync(process.env.CONSENT_HTML,r.j);
const decide=(fields,extra)=>api(null,'POST','/oauth/decision',form(fields),'application/x-www-form-urlencoded',extra);
r=await decide({p:C.p,csrf:C.csrf,org:Ch,allow:'yes'},{...cookie(U),origin:B});t('choosing an organization Uma is not in is refused',r.s===403&&!r.h.get('location')&&r.j.includes('Choose one of your organizations'),r.s);
r=await decide({p:C.p,csrf:'forged',org:A,allow:'yes'},{...cookie(U),origin:B});t('a forged CSRF token is refused',r.s===403,r.s);
r=await decide({p:C.p,csrf:C.csrf,org:A,allow:'yes'},{...cookie(O),origin:B});t('another person’s session is refused',r.s===403,r.s);
r=await decide({p:C.p,csrf:C.csrf,org:A,allow:'yes'},{origin:B});t('no session is refused',r.s===401,r.s);
r=await decide({p:C.p,csrf:C.csrf,org:A,allow:'yes'},{...cookie(U),origin:'https://evil.example'});t('another site’s form is refused',r.s===403,r.s);
// Refusals leave it pending; the consent page (which rebinds it to Uma) issued its token already.
r=await decide({p:C.p,csrf:C.csrf,org:A,allow:'yes'},{...cookie(U),origin:B});const back=new URL(r.h.get('location')??'http://x/');
t('allowing Acme goes back to the client with a code',r.s===302&&back.origin==='http://localhost:51234'&&back.searchParams.get('code')&&back.searchParams.get('state')==='xyz'&&back.searchParams.get('iss')===B,r.s+' '+back.href.slice(0,120));
r=await api(null,'POST','/oauth/token',form({grant_type:'authorization_code',code:back.searchParams.get('code'),code_verifier:'wrong-verifier-wrong-verifier-wrong-verifier',client_id:CLIENT}),'application/x-www-form-urlencoded');t('a wrong PKCE verifier is refused',r.s===400&&r.j.error==='invalid_grant',JSON.stringify(r.j));
r=await api(null,'POST','/oauth/token',form({grant_type:'authorization_code',code:back.searchParams.get('code'),code_verifier:VER,client_id:CLIENT,redirect_uri:'http://localhost:51234/callback'}),'application/x-www-form-urlencoded');
// Every consent group that starts ticked, from the manifests (the first four apps' and any added since); never sending.
const TICKED=APP_MANIFESTS.flatMap((m)=>m.scopes??[]).filter((g)=>g.checkedByDefault).flatMap((g)=>g.scopes).join(' ');
let TOK=r.j;t('the code exchanges for tokens',r.s===200&&TOK.access_token&&TOK.refresh_token&&TOK.scope===TICKED,r.s+' '+TOK.scope);

// --- MCP, as Uma in Acme --------------------------------------------------------------------------------------------------
let rpcId=0;
async function mcp(tok,method,params={},extra={},path='/mcp'){const x=await api(tok,'POST',path,{jsonrpc:'2.0',id:++rpcId,method,params},undefined,{accept:'application/json, text/event-stream',...extra});return x;}
const call=async(tok,name,args)=>{const x=await mcp(tok,'tools/call',{name,arguments:args});const text=x.j?.result?.content?.[0]?.text;let v;try{v=JSON.parse(text)}catch{v=text}return{...x,v,isError:x.j?.result?.isError}};
r=await mcp(TOK.access_token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'e2e',version:'1'}});t('initialize',r.s===200&&r.j.result?.serverInfo?.name==='universal-docs',r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await mcp(TOK.access_token,'tools/list');const names=(r.j.result?.tools??[]).map((x)=>x.name);
t('tools/list has the file and spreadsheet tools, and no ChatGPT app tools',['list_files','search_files','read_range','write_range','create_sheet','upload_file'].every((n)=>names.includes(n))&&!names.includes('docs_app')&&!names.includes('app_state'),names.length+' '+names.slice(0,12).join(','));
t('and the event tools, with events:read',['list_subscriptions','create_subscription','read_events','ack_events','list_jobs'].every((n)=>names.includes(n)),names.filter((n)=>/subscri|events|jobs/.test(n)).join(','));
{r=await call(TOK.access_token,'create_subscription',{name:'acme chat',filter:{types:['chat.*']}});const SUB=r.v?.subscription;t('create_subscription as Uma’s account in Acme',!r.isError&&SUB?.id&&SUB.filter?.types?.[0]==='chat.*',JSON.stringify(r.v??r.j).slice(0,160));
 r=await call(TOK.access_token,'create_subscription',{name:'bad',filter:{types:['a b']}});t('a bad filter is the agent’s error',r.isError===true,JSON.stringify(r.j).slice(0,140));
 r=await call(TOK.access_token,'list_subscriptions',{});t('list_subscriptions has it',r.v?.subscriptions?.some((x)=>x.id===SUB?.id),JSON.stringify(r.v).slice(0,140));
 r=await api(O.token,'GET',`/v1/workspaces/${A}/channels`);const ch=(r.j.channels??r.j)[0];
 const waiting=call(TOK.access_token,'read_events',{subscription_id:SUB?.id,wait:5});await sleep(400);
 r=await api(O.token,'POST',`/v1/channels/${ch.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'hello agents'});const MSG=r.j;
 r=await waiting;const ev=r.v?.events?.find((e)=>e.type==='chat.message.created'&&e.data?.id===MSG.id);t('read_events waits for Olga’s message',!r.isError&&!!ev,JSON.stringify(r.v??r.j).slice(0,160));
 r=await call(TOK.access_token,'ack_events',{subscription_id:SUB?.id,cursor:r.v?.next});t('ack_events moves the cursor',r.v?.cursor>0,JSON.stringify(r.v));
 r=await call(TOK.access_token,'read_events',{subscription_id:SUB?.id});t('then nothing is left',r.v?.events?.length===0,JSON.stringify(r.v).slice(0,120));
 r=await call(TOK.access_token,'list_jobs',{subscription_id:SUB?.id});t('list_jobs: a pull subscription has none',!r.isError&&Array.isArray(r.v?.jobs)&&r.v.jobs.length===0,JSON.stringify(r.v??r.j).slice(0,120));
 r=await call(TOK.access_token,'create_subscription',{name:'wake nobody',delivery:'wake',consumer:'acct-x',action:{kind:'wake',prompt:'p'}});t('a wake subscription for no agent is the agent’s error',r.isError===true,JSON.stringify(r.j).slice(0,140));
 r=await call(TOK.access_token,'create_subscription',{name:'tick',delivery:'post',action:{kind:'post',channelId:'c1',body:'tick'},schedule:{every:'daily@09:00',timezone:'UTC'}});t('create_subscription with a schedule forces its filter',!r.isError&&r.v?.subscription?.filter?.types?.[0]==='schedule.tick'&&!!r.v.subscription.schedule?.nextAt,JSON.stringify(r.v??r.j).slice(0,160));
 r=await call(TOK.access_token,'read_events',{subscription_id:'nope'});t('an unknown subscription is the agent’s error',r.isError===true,JSON.stringify(r.j).slice(0,120));
 r=await api(U.token,'GET',`/v1/events/subscriptions?workspace=${A}`);t('the same subscription over HTTP',r.j.subscriptions?.some((x)=>x.id===SUB?.id),JSON.stringify(r.j).slice(0,120));}
r=await call(TOK.access_token,'list_files',{});const listed=JSON.stringify(r.v);
t('list_files shows Acme’s spreadsheet and not Bravo’s',listed.includes(S)&&!listed.includes(SB),listed.slice(0,200));
t('with where it is and its page in /docs',r.v.files?.find((f)=>f.id===S)?.root==='Organization files'&&r.v.files?.find((f)=>f.id===S)?.url===`${B}/docs/s/${S}`,JSON.stringify(r.v.files?.find((f)=>f.id===S)));
r=await call(TOK.access_token,'search_files',{query:'Budget'});t('search_files finds it',JSON.stringify(r.v).includes(S),JSON.stringify(r.v).slice(0,150));
r=await call(TOK.access_token,'search_files',{query:'Bravo'});t('and not the other organization’s',!JSON.stringify(r.v).includes(SB),JSON.stringify(r.v).slice(0,150));
r=await call(TOK.access_token,'read_range',{sheet_id:S,range:'A1:B1'});t('read_range reads it',JSON.stringify(r.v).includes('Revenue')&&JSON.stringify(r.v).includes('1200'),JSON.stringify(r.v).slice(0,160));
r=await call(TOK.access_token,'write_range',{sheet_id:S,start:'A2',rows:[['Costs','=B1/2']]});t('write_range writes it',r.s===200&&!r.isError,JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'GET',`/api/sheets/${S}`);const cells=(r.j.sheet?.workbook??r.j.workbook)?.tabs?.[0]?.cells??{};
t('Olga sees the agent’s cells through /api: the same data',cells.A2?.v==='Costs'&&cells.B2?.v==='=B1/2',JSON.stringify(cells).slice(0,160));
r=await call(TOK.access_token,'read_range',{sheet_id:SB,range:'A1'});t('a file of the other organization is not there',r.isError,JSON.stringify(r.j).slice(0,140));
r=await call(TOK.access_token,'create_sheet',{title:`Agent sheet ${tag}`});const made=r.v?.file;t('a new file goes in Uma’s My files in Acme',made?.root==='My files'&&made?.url===`${B}/docs/s/${made?.id}`,JSON.stringify(made??r.j));
r=await api(U.token,'GET',`/api/sheets?workspace=${A}`);t('and Docs lists it there',JSON.stringify(r.j).includes(made?.id),JSON.stringify(r.j).slice(0,120));
r=await api(U.token,'GET',`/api/sheets/${made?.id}`);t('and opens it by its id alone',r.s===200,r.s);
r=await call(TOK.access_token,'upload_file',{file_name:'notes.md'});const up=r.v?.upload_url;t('upload_file gives an address on this host',up?.startsWith(`${B}/mcp/import/${A}?`),up);
if(up){r=await api(null,'POST',up.slice(B.length),'# Hello from the agent\n','text/markdown');t('the agent uploads to it',r.s===200&&r.j.file?.kind==='markdown',r.s+' '+JSON.stringify(r.j).slice(0,120));
  r=await api(null,'POST',up.slice(B.length),'again','text/markdown');t('the address works once',r.s===401,r.s);}
r=await api(TOK.access_token,'GET','/mcp');t('GET /mcp: no stream, 405',r.s===405,r.s);

// --- The 2026-07-28 protocol ------------------------------------------------------------------------------------------
const NEW={'mcp-protocol-version':'2026-07-28'};
r=await mcp(TOK.access_token,'server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}},NEW);t('server/discover',r.s===200&&r.j.result?.supportedVersions?.includes('2026-07-28')&&r.j.result?.resultType==='complete',JSON.stringify(r.j).slice(0,160));
r=await mcp(TOK.access_token,'tools/call',{name:'list_files',arguments:{},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}},NEW);t('a stateless tool call carries resultType',r.s===200&&r.j.result?.resultType==='complete',JSON.stringify(r.j).slice(0,120));
r=await mcp(TOK.access_token,'tools/list',{},{},'/mcp/v2');t('/mcp/v2 answers too',r.s===200&&r.j.result?.tools?.length>10,r.s);

// --- Refresh rotation --------------------------------------------------------------------------------------------------
r=await api(null,'POST','/oauth/token',form({grant_type:'refresh_token',refresh_token:TOK.refresh_token,client_id:CLIENT}),'application/x-www-form-urlencoded');const T2=r.j;
t('a refresh gives new tokens',r.s===200&&T2.access_token&&T2.refresh_token!==TOK.refresh_token,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await call(T2.access_token,'list_files',{});t('for the same organization',JSON.stringify(r.v).includes(S)&&!JSON.stringify(r.v).includes(SB),r.s);
r=await api(null,'POST','/oauth/token',form({grant_type:'refresh_token',refresh_token:TOK.refresh_token,client_id:CLIENT}),'application/x-www-form-urlencoded');t('the old refresh token used again is refused',r.s===400&&r.j.error==='invalid_grant',JSON.stringify(r.j));
r=await mcp(T2.access_token,'tools/list');t('and that ends the whole family',r.s===401,r.s);

// --- Read only ----------------------------------------------------------------------------------------------------------
const RO=await connect(U,A,{scope:'files:read'});r=await mcp(RO.access_token,'tools/list');const roNames=(r.j.result?.tools??[]).map((x)=>x.name);
t('files:read alone gets only the tools that read',RO.scope==='files:read'&&roNames.includes('read_range')&&roNames.includes('list_files')&&!roNames.includes('write_range')&&!roNames.includes('create_sheet'),roNames.join(','));

// --- Settings: the agents connected, with their organization ---------------------------------------------------------------
r=await api(U.token,'GET','/api/settings/agents');const agents=r.j.agents??[];
t('Docs’ Settings lists the agents with their organization',r.s===200&&r.j.enabled&&r.j.mcpUrl===`${B}/mcp`&&agents.length>=1&&agents.every((a)=>a.organization===`Acme ${tag}`&&a.name==='E2E Agent'),r.s+' '+JSON.stringify(r.j).slice(0,200));
r=await api(U.token,'DELETE',`/api/settings/agents/${agents[0]?.id}`);t('and disconnects one',r.s===200,r.s);
r=await mcp(RO.access_token,'tools/list');t('whose token then stops working',r.s===401,r.s);
r=await api(O.token,'DELETE',`/api/settings/agents/${agents[1]?.id??'x'}`);t('nobody else can disconnect Uma’s',r.s===404,r.s);

// --- Revoke ---------------------------------------------------------------------------------------------------------------
const T3=await connect(U,A);r=await mcp(T3.access_token,'tools/list');t('a new connection works',r.s===200,r.s);
r=await api(null,'POST','/oauth/revoke',form({token:T3.refresh_token}),'application/x-www-form-urlencoded');t('revoke',r.s===200,r.s);
r=await mcp(T3.access_token,'tools/list');t('revoking the refresh token ends its access token',r.s===401&&/invalid_token/.test(r.h.get('www-authenticate')),r.s);

// --- Leaving the organization -------------------------------------------------------------------------------------------
const T4=await connect(U,A);r=await mcp(T4.access_token,'tools/list');t('connected to Acme again',r.s===200,r.s);
const TB=await connect(U,Bo);r=await call(TB.access_token,'list_files',{});t('a connection to Bravo sees Bravo’s file, not Acme’s',JSON.stringify(r.v).includes(SB)&&!JSON.stringify(r.v).includes(S),JSON.stringify(r.v).slice(0,120));
// --- Agents as kinds (docs/specs/agents.md phase A): a connection acts through a personal agent the admin sees ---------------
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);let PA=(r.j.accounts??[]).filter(a=>a.kind==='personal_agent'&&a.sponsorId===U.user.id&&a.agentRuntime==='external');
t('Olga sees one personal agent of Uma’s in Acme: the MCP client, no address, mode personal',r.s===200&&PA.length===1&&PA[0].address===null&&PA[0].agentMode==='personal'&&PA[0].displayName==='E2E Agent'&&PA[0].state==='active',JSON.stringify(PA).slice(0,220));
r=await api(O.token,'PATCH',`/v1/workspaces/${A}/accounts/${PA[0]?.id}/kind`,{kind:'guest'});t('a personal agent’s kind never changes',r.s===409,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'DELETE',`/v1/workspaces/${A}/accounts/${PA[0]?.id}`);t('a member cannot remove it',r.s===403,r.s);
r=await api(O.token,'DELETE',`/v1/workspaces/${A}/accounts/${PA[0]?.id}`);t('Olga removes the personal agent',r.s===200&&r.j.account?.state==='removed',r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await mcp(T4.access_token,'tools/list');t('Uma’s Acme tokens stop working: revoked',r.s===401&&r.j.reason==='revoked',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(U.token,'GET','/api/settings/agents');t('and Docs’ Settings no longer lists them',!(r.j.agents??[]).some(a=>a.organizationId===A),JSON.stringify(r.j.agents).slice(0,160));
r=await mcp(TB.access_token,'tools/list');t('her Bravo token, another agent, still works',r.s===200,r.s);
const T5=await connect(U,A);r=await mcp(T5.access_token,'tools/list');t('connecting again makes a new personal agent, and works',r.s===200,r.s);
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);{const now=(r.j.accounts??[]).filter(a=>a.kind==='personal_agent'&&a.sponsorId===U.user.id&&a.agentRuntime==='external'&&a.state!=='removed');t('one active personal agent of Uma’s again: the same one, back',now.length===1&&now[0].id===PA[0]?.id,JSON.stringify(now.map(a=>a.id)));}
r=await api(O.token,'DELETE',`/v1/workspaces/${A}/members/${U.user.id}`);t('Olga removes Uma from Acme',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,100));
await sleep(300);
r=await mcp(T5.access_token,'tools/list');t('Uma’s Acme token stops working: her personal agent there went with her, its delegations revoked',r.s===401&&/invalid_token/.test(r.h.get('www-authenticate'))&&r.j.reason==='revoked',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(null,'POST','/oauth/token',form({grant_type:'refresh_token',refresh_token:T5.refresh_token,client_id:CLIENT}),'application/x-www-form-urlencoded');t('and cannot be refreshed',r.s===400,JSON.stringify(r.j));
r=await mcp(TB.access_token,'tools/list');t('her Bravo token still works',r.s===200,r.s);
{const {c}=pkce();const x=await api(null,'GET',authorizeUrl(c),undefined,undefined,cookie(U));const pg=await api(null,'GET',x.h.get('location'),undefined,undefined,cookie(U));const f=consentOf(pg.j);
 t('consent now offers Bravo alone, preselected',f.orgs.length===1&&f.orgs[0]===Bo&&f.checked===Bo,JSON.stringify(f.orgs));
 const d=await decide({p:f.p,csrf:f.csrf,org:A,allow:'yes'},{...cookie(U),origin:B});t('and refuses Acme now',d.s===403,d.s);
 const n=await decide({p:f.p,csrf:f.csrf,allow:'no'},{...cookie(U),origin:B});t('deny goes back to the client with access_denied',n.s===302&&new URL(n.h.get('location')).searchParams.get('error')==='access_denied',n.h.get('location'));}

// --- The device grant ---------------------------------------------------------------------------------------------------
r=await api(null,'POST','/oauth/device_authorization',form({client_id:CLIENT}),'application/x-www-form-urlencoded');const dev=r.j;t('device authorization',r.s===200&&/^[A-Z]{4}-[A-Z]{4}$/.test(dev.user_code??'')&&dev.verification_uri===`${B}/oauth/device`,JSON.stringify(r.j).slice(0,140));
r=await api(null,'POST','/oauth/token',form({grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:dev.device_code,client_id:CLIENT}),'application/x-www-form-urlencoded');t('polling before it is allowed: authorization_pending',r.j.error==='authorization_pending',JSON.stringify(r.j));
r=await api(null,'POST','/oauth/device',form({code:dev.user_code}),'application/x-www-form-urlencoded',{...cookie(U),origin:B});const devConsent=r.h.get('location');
r=await api(null,'GET',devConsent,undefined,undefined,cookie(U));const DC=consentOf(r.j);t('entering the code leads to consent, with the warning',r.s===200&&r.j.includes('Only allow this if you started this sign-in yourself'),r.s);
r=await decide({p:DC.p,csrf:DC.csrf,org:Bo,allow:'yes'},{...cookie(U),origin:B});t('allowed for Bravo',r.h.get('location')==='/oauth/device/done?ok=1',r.h.get('location'));
await sleep(5200);
r=await api(null,'POST','/oauth/token',form({grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:dev.device_code,client_id:CLIENT}),'application/x-www-form-urlencoded');
t('the device gets its tokens',r.s===200&&r.j.access_token,JSON.stringify(r.j).slice(0,100));
if(r.j.access_token){const x=await call(r.j.access_token,'list_files',{});t('for Bravo',JSON.stringify(x.v).includes(SB),x.s);}

// --- The tool registry's bridge door (platform phase 6.2): an agent reads the definitions its bridge lists -----------------
r=await api(O.token,'POST',`/v1/workspaces/${A}/agent-invites`,{});
r=await api(null,'POST','/v1/agents/redeem',{code:r.j.code,username:`regbot${tag}`,key:'a-long-agent-key-for-the-registry-test',name:'Registry'});const AGT=r.j.agentToken;
r=await api(AGT,'GET','/v1/tools?door=bridge');const bt=r.j.tools??[];const td=(n)=>bt.find((x)=>x.name===n);
t('GET /v1/tools?door=bridge as an agent lists send_message and respond_to_event with input schemas',r.s===200&&td('send_message')?.input?.type==='object'&&!!td('send_message').input.properties?.text&&td('respond_to_event')?.input?.properties?.response?.enum?.includes('accepted')&&bt.every((x)=>x.doors.includes('bridge')&&x.kind==='server'),r.s+' '+JSON.stringify(bt.map((x)=>x.name)).slice(0,160));
r=await api(AGT,'GET','/v1/tools?door=assistant');t('only the bridge door is served there',r.s===400,r.s);
// --- A bridge agent is a shared agent in the one organization it joined, and its turns say who asked (agents.md §1, §3) -------
r=await api(AGT,'GET','/v1/me');t('the agent is a shared agent',r.s===200&&r.j.isAgent===true&&r.j.agentMode==='shared',r.s+' '+JSON.stringify(r.j).slice(0,120));const REG=r.j.id;
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);{const a=(r.j.accounts??[]).find(x=>x.principalId===REG);t('its account is native, sponsored by Olga, mode shared',a?.kind==='native'&&a?.sponsorId===O.user.id&&a?.agentMode==='shared'&&!!a?.address,JSON.stringify(a).slice(0,200));}
r=await api(U.token,'POST',`/v1/workspaces/${Bo}/agent-invites`,{});r=await api(null,'POST','/v1/agents/redeem',{code:r.j.code,username:`regbot${tag}`,key:'a-long-agent-key-for-the-registry-test',name:'Registry'});
t('the same name and key redeemed in Bravo makes a second agent, its own principal: an agent belongs to one organization',r.s===201&&r.j.user?.id&&r.j.user.id!==REG,r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(r.j.agentToken,'GET','/v1/me/accounts');t('which holds an account in Bravo alone',r.s===200&&r.j.accounts?.length===1&&r.j.accounts[0].organizationId===Bo,JSON.stringify(r.j).slice(0,160));
r=await api(AGT,'GET','/v1/me/accounts');t('while the first keeps Acme alone',r.s===200&&r.j.accounts?.length===1&&r.j.accounts[0].organizationId===A,JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'GET',`/v1/workspaces/${A}/channels`);const GEN=(r.j.channels??r.j)[0];
// --- Connecting an agent (agents.md §1, phase B): the consent page's choice ------------------------------------------------
// --- Every person has an assistant: a hosted personal agent made with the account (agents.md §6, phase C) ---------------------
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);{const mine=(r.j.accounts??[]).filter(a=>a.kind==='personal_agent'&&a.agentRuntime==='hosted');t('Olga has an assistant in Acme, a hosted personal agent (Uma’s went with her when she was removed)',mine.length===1&&/’s assistant$/.test(mine[0].displayName)&&mine[0].sponsorId===O.user.id,JSON.stringify(mine.map(a=>[a.displayName,a.sponsorId])).slice(0,200));}
r=await api(O.token,'GET',`/api/agent/agents?workspace=${A}`);const SELF=(r.j.agents??[]).find(a=>a.self);t('the panel’s agents: Olga’s own assistant, hers alone for now',r.s===200&&r.j.agents.length===1&&SELF?.mode==='personal'&&/Olga’s assistant/.test(SELF?.displayName??''),JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'GET',`/api/agent/definition?workspace=${A}`);t('its definition starts with its name and no instructions',r.s===200&&r.j.definition?.name===SELF?.displayName&&r.j.definition?.instructions==='',JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'PUT',`/api/agent/definition?workspace=${A}`,{name:'Pip',instructions:'Answer briefly.'});t('Olga names it and gives it instructions',r.s===200&&r.j.definition?.name==='Pip'&&r.j.definition?.instructions==='Answer briefly.',JSON.stringify(r.j).slice(0,160));
// --- A hosted shared agent, made from the Admin app (agents.md §6, phase C): everyone may talk to it from the panel ----------
r=await api(O.token,'POST',`/v1/workspaces/${A}/agents/hosted`,{name:`Omni ${tag}`,instructions:'Help the team.'});const OMNIH=r.j.agent;t('Olga makes a hosted shared agent, Omni, with instructions',r.s===201&&OMNIH?.mode==='shared'&&r.j.definition?.instructions==='Help the team.',r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'GET',`/v1/workspaces/${A}/members`);t('Omni is a member, an agent sponsored by Olga',(r.j.members??[]).some(m=>m.userId===OMNIH?.id&&m.isAgent&&m.sponsorId===O.user.id));
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);t('with a native account that is hosted',(r.j.accounts??[]).some(a=>a.principalId===OMNIH?.id&&a.kind==='native'&&a.agentRuntime==='hosted'));
r=await api(O.token,'GET',`/api/agent/agents?workspace=${A}`);t('the panel’s agents: Olga’s assistant and Omni',r.s===200&&r.j.agents.length===2&&r.j.agents.some(a=>a.id===OMNIH?.id&&!a.self),JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'GET',`/v1/workspaces/${A}/agents/${OMNIH?.id}/definition`);t('its definition reads back, editable by its sponsor',r.s===200&&r.j.definition?.name===`Omni ${tag}`&&r.j.definition?.instructions==='Help the team.'&&r.j.mayEdit===true,JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'PUT',`/v1/workspaces/${A}/agents/${OMNIH?.id}/definition`,{instructions:'Help the team briefly.'});t('and is changed',r.s===200&&r.j.definition?.instructions==='Help the team briefly.',r.s);
r=await api(O.token,'GET',`/api/agent?scope=home&agent=${OMNIH?.id}&workspace=${A}`);t('Olga’s conversation with Omni starts empty, in Omni’s runtime',r.s===200&&Array.isArray(r.j.items)&&r.j.items.length===0,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(O.token,'GET',`/api/agent?scope=home&agent=00000000-0000-7000-8000-000000000bad&workspace=${A}`);t('an agent that is not hers to use is refused',r.s===404&&r.j.code==='no_agent',r.s);
// Review fixes: the definition is the Admin app's; guests are refused; the open page is gated; the name is real.
r=await api(O.token,'PUT',`/api/agent/definition?workspace=${A}&agent=${OMNIH?.id}`,{instructions:'pwned'});t('the panel route cannot set a shared agent’s definition',r.s===403&&r.j.code==='not_yours',r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(O.token,'GET',`/v1/workspaces/${A}/agents/${OMNIH?.id}/definition`);t('so it is unchanged',r.j.definition?.instructions==='Help the team briefly.',JSON.stringify(r.j).slice(0,120));
r=await api(O.token,'POST',`/api/sheets?workspace=${A}`,{title:`Olga private ${tag}`});const PRIV=r.j.sheet?.id;
r=await api(O.token,'POST','/api/agent/turn',{message:'read this',context:{page:'sheet',sheetId:PRIV,title:'x'},scope:'home',agent:OMNIH?.id,workspace:A});t('a turn whose page is a file Omni cannot see is refused, whatever the chat',r.s===403&&r.j.code==='agent_cannot_see',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(O.token,'PUT',`/v1/workspaces/${A}/agents/${OMNIH?.id}/definition`,{name:`Omni Prime ${tag}`});r=await api(O.token,'GET',`/api/agent/agents?workspace=${A}`);t('renaming it renames it in the panel',(r.j.agents??[]).some(a=>a.id===OMNIH?.id&&a.displayName===`Omni Prime ${tag}`),JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'POST',`/v1/workspaces/${A}/invites`,{emails:[`gail-${tag}@example.com`],kind:'guest'});
{const G=await signup(`gail-${tag}@example.com`,'Gail');const tok=(r.j.results?.[0]?.inviteUrl??'').split('/').pop();await api(G.token,'POST','/v1/invites/accept',{token:tok});
 r=await api(G.token,'GET',`/api/agent/agents?workspace=${A}`);const ga=r;r=await api(G.token,'GET',`/api/agent?scope=home&agent=${OMNIH?.id}&workspace=${A}`);t('a guest cannot talk to Omni',r.s===403&&r.j.code==='guest',r.s+' '+JSON.stringify(r.j).slice(0,100));
 r=await api(G.token,'POST',`/v1/workspaces/${A}/agents/hosted`,{name:'Sneaky'});t('nor make a hosted agent',r.s===403,r.s);void ga;}
r=await api(O.token,'GET',`/v1/workspaces/${A}/agents/${REG??'x'}/definition`);t('an external agent has no definition here',r.s===404,r.s);
// --- A wake job for a hosted agent goes straight to its runtime (agents.md §6, phase C) ---------------------------------------
{const SP=`/v1/events/subscriptions?workspace=${A}`;
 r=await api(O.token,'GET',`/v1/workspaces/${A}/channels`);const GENC=(r.j.channels??r.j)[0];
 r=await api(O.token,'POST',SP,{name:'omni summaries',delivery:'wake',consumer:OMNIH?.accountId,filter:{types:['chat.message.created'],channelId:GENC.id},action:{kind:'wake',prompt:'Summarize: {{data}}'}});const WOM=r.j.subscription;t('Olga makes a wake subscription for the hosted Omni',r.s===201&&WOM?.consumer===OMNIH?.accountId,r.s+' '+JSON.stringify(r.j).slice(0,140));
 r=await api(O.token,'POST',SP,{name:'my assistant',delivery:'wake',consumer:SELF?.accountId,filter:{types:['chat.message.created'],channelId:GENC.id},action:{kind:'wake',prompt:'Note: {{data}}'}});const WAS=r.j.subscription;t('and one for her own assistant, which is no member but hers',r.s===201&&WAS?.consumer===SELF?.accountId,r.s+' '+JSON.stringify(r.j).slice(0,140));
 r=await api(O.token,'POST',`/v1/channels/${GENC.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'a message for the hosted agents'});
 const jobsOf=async(sub)=>{for(let i=0;i<40;i++){const q=(await api(O.token,'GET',`/v1/events/jobs?subscription=${sub}&workspace=${A}`)).j.jobs??[];if(q.length&&q.every(j=>j.state==='done'||j.state==='failed'))return q;await sleep(250);}return (await api(O.token,'GET',`/v1/events/jobs?subscription=${sub}&workspace=${A}`)).j.jobs??[];};
 const jo=await jobsOf(WOM.id),ja=await jobsOf(WAS.id);
 // No model key on this Worker: the runtime takes the job, the turn fails, and the job says so (a failure, not a parked job).
 t('Omni’s runtime took the job and finished it (failed here: no model key), with the reason',jo.length===1&&(jo[0].state==='failed'||jo[0].state==='done')&&!!jo[0].note,JSON.stringify(jo).slice(0,200));
 t('so did Olga’s assistant’s runtime',ja.length===1&&(ja[0].state==='failed'||ja[0].state==='done')&&!!ja[0].note,JSON.stringify(ja).slice(0,200));
 await api(O.token,'DELETE',`/v1/events/subscriptions/${WOM.id}?workspace=${A}`);await api(O.token,'DELETE',`/v1/events/subscriptions/${WAS.id}?workspace=${A}`);}
r=await api(U.token,'GET',`/api/agent/definition?workspace=${Bo}`);t('Uma’s assistant in Bravo is her own, untouched',r.s===200&&r.j.definition?.name!=='Pip'&&/Uma’s assistant/.test(r.j.definition?.name??''),JSON.stringify(r.j).slice(0,120));
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);const beforePersonal=(r.j.accounts??[]).filter(a=>a.kind==='personal_agent'&&a.agentRuntime==='external'&&a.sponsorId===O.user.id&&a.state!=='removed').length;
const OP=await connect(O,A);t('Olga connects as her personal agent (the default)',!!OP.access_token,JSON.stringify(OP).slice(0,120));
t('the consent page offers her agents to reconnect, and the shared choice',/name="as" value="existing:/.test(connect.lastPage)&&/name="as" value="shared"/.test(connect.lastPage)&&/name="agent_name"/.test(connect.lastPage),'');
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);{const now=(r.j.accounts??[]).filter(a=>a.kind==='personal_agent'&&a.agentRuntime==='external'&&a.sponsorId===O.user.id&&a.state!=='removed');t('one personal agent of Olga’s in Acme',now.length===1,JSON.stringify(now.map(a=>a.displayName)));var OPA=now[0];}
const OP2=await connect(O,A,{},{as:`existing:${OPA?.principalId}`});t('reconnecting it makes no duplicate',!!OP2.access_token,JSON.stringify(OP2).slice(0,120));
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);t('still one',(r.j.accounts??[]).filter(a=>a.kind==='personal_agent'&&a.agentRuntime==='external'&&a.sponsorId===O.user.id&&a.state!=='removed').length===1);
const SH=await connect(O,A,{},{as:'shared',agent_name:`Omni ${tag}`});t('Olga connects a shared agent named Omni',!!SH.access_token,JSON.stringify(SH).slice(0,160));
r=await api(O.token,'GET',`/v1/workspaces/${A}/members`);const OMNI=(r.j.members??[]).find(m=>m.displayName===`Omni ${tag}`);t('Omni is a member of Acme, an agent sponsored by Olga',OMNI?.isAgent===true&&OMNI?.sponsorId===O.user.id,JSON.stringify(OMNI).slice(0,160));
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);{const a=(r.j.accounts??[]).find(x=>x.principalId===OMNI?.userId);t('with a native account, mode shared, and an address',a?.kind==='native'&&a?.agentMode==='shared'&&!!a?.address,JSON.stringify(a).slice(0,160));}
r=await mcp(SH.access_token,'tools/list');t('Omni’s token works on /mcp',r.s===200,r.s);
r=await api(O.token,'GET','/api/settings/agents');{const c=(r.j.agents??[]).find(a=>a.agentName===`Omni ${tag}`);t('Docs’ Settings lists the connection as the shared agent Omni',c?.mode==='shared',JSON.stringify(r.j.agents).slice(0,200));}
r=await connect(U,A,{},{as:`existing:${OMNI?.userId}`});t('someone else cannot reconnect Olga’s Omni',r.error===403,JSON.stringify(r).slice(0,120));
r=await connect(O,A,{},{as:'shared',agent_name:''});t('a shared agent needs a name',r.error===403,JSON.stringify(r).slice(0,120));
r=await api(O.token,'GET',`/v1/workspaces/${A}/accounts`);const OACC=(r.j.accounts??[]).find(x=>x.principalId===O.user.id)?.id;
r=await api(AGT,'POST',`/v1/channels/${GEN.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'asked by Olga'},undefined,{'x-flow-invoked-by':OACC});t('the agent posts, saying Olga asked',r.s===201,r.s+' '+JSON.stringify(r.j).slice(0,100));const ASKED=r.j.id;
r=await api(AGT,'POST',`/v1/channels/${GEN.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'asked by nobody known'},undefined,{'x-flow-invoked-by':'00000000-0000-7000-8000-000000000bad'});const UNKNOWN=r.j.id;
r=await api(O.token,'POST',`/v1/channels/${GEN.id}/messages`,{clientMsgId:crypto.randomUUID(),body:'a person claiming'},undefined,{'x-flow-invoked-by':OACC});const CLAIM=r.j.id;
await sleep(500);
r=await api(O.token,'GET',`/v1/events?workspace=${A}&since=0&limit=500`);{const ev=(id)=>r.j.events?.find(x=>x.type==='chat.message.created'&&x.data?.id===id);
 t('the event carries invokedBy: Olga’s account',ev(ASKED)?.invokedBy===OACC&&!!ev(ASKED)?.actor,JSON.stringify(ev(ASKED)).slice(0,200));
 t('an account that is no member is not carried',ev(UNKNOWN)&&ev(UNKNOWN).invokedBy===undefined,JSON.stringify(ev(UNKNOWN)).slice(0,160));
 t('a person’s claim is not carried',ev(CLAIM)&&ev(CLAIM).invokedBy===undefined,JSON.stringify(ev(CLAIM)).slice(0,160));}
r=await api(null,'GET','/v1/tools?door=bridge');t('and not without a token',r.s===401,r.s);

console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
