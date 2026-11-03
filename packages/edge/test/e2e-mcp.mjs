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
const consentOf=(html)=>({p:/name="p" value="([^"]+)"/.exec(html)?.[1],csrf:/name="csrf" value="([^"]+)"/.exec(html)?.[1],orgs:[...html.matchAll(/name="org" value="([^"]+)"/g)].map((m)=>m[1]),checked:/value="([^"]+)" checked/.exec(html)?.[1]});
/** The whole flow for a person and an organization, returning the token response. */
async function connect(u,org,extra={}){const {v,c}=pkce();let x=await api(null,'GET',authorizeUrl(c,extra),undefined,undefined,cookie(u));const page=await api(null,'GET',x.h.get('location'),undefined,undefined,cookie(u));const f=consentOf(page.j);
  x=await api(null,'POST','/oauth/decision',form({p:f.p,csrf:f.csrf,org,allow:'yes'}),'application/x-www-form-urlencoded',{...cookie(u),origin:B});const code=new URL(x.h.get('location')).searchParams.get('code');
  return (await api(null,'POST','/oauth/token',form({grant_type:'authorization_code',code,code_verifier:v,client_id:CLIENT,redirect_uri:'http://localhost:51234/callback'}),'application/x-www-form-urlencoded')).j;}

const {v:VER,c:CHAL}=pkce();
r=await api(null,'GET',authorizeUrl(CHAL));t('authorize without a session goes to FreeFlow’s sign-in, coming back to consent',r.s===302&&/^\/\?next=%2Foauth%2Fconsent%3Fp%3D/.test(r.h.get('location')),r.s+' '+r.h.get('location'));
const signInNext=decodeURIComponent(r.h.get('location').slice('/?next='.length));
r=await api(null,'GET',authorizeUrl(CHAL),undefined,undefined,cookie(U));const consentPath=r.h.get('location');t('with the session: straight to consent',r.s===302&&consentPath?.startsWith('/oauth/consent?p='),r.s+' '+consentPath);
r=await api(null,'GET',signInNext);t('the consent page without a session sends to sign-in again',r.s===302&&r.h.get('location')?.startsWith('/?next='),r.s);
r=await api(null,'GET',consentPath,undefined,undefined,cookie(U));const C=consentOf(r.j);
t('the consent page lists both of Uma’s organizations by name',r.s===200&&r.j.includes(`Acme ${tag}`)&&r.j.includes(`Bravo ${tag}`)&&C.orgs.length===2&&C.orgs.includes(A)&&C.orgs.includes(Bo),r.s+' '+JSON.stringify(C.orgs));
t('it names the client and the scopes, and one organization is preselected',r.j.includes('E2E Agent')&&r.j.includes('Organization files')&&r.j.includes('My files')&&[A,Bo].includes(C.checked),C.checked);
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
let TOK=r.j;t('the code exchanges for tokens',r.s===200&&TOK.access_token&&TOK.refresh_token&&TOK.scope==='files:read files:write',r.s+' '+JSON.stringify(r.j).slice(0,120));

// --- MCP, as Uma in Acme --------------------------------------------------------------------------------------------------
let rpcId=0;
async function mcp(tok,method,params={},extra={},path='/mcp'){const x=await api(tok,'POST',path,{jsonrpc:'2.0',id:++rpcId,method,params},undefined,{accept:'application/json, text/event-stream',...extra});return x;}
const call=async(tok,name,args)=>{const x=await mcp(tok,'tools/call',{name,arguments:args});const text=x.j?.result?.content?.[0]?.text;let v;try{v=JSON.parse(text)}catch{v=text}return{...x,v,isError:x.j?.result?.isError}};
r=await mcp(TOK.access_token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'e2e',version:'1'}});t('initialize',r.s===200&&r.j.result?.serverInfo?.name==='universal-docs',r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await mcp(TOK.access_token,'tools/list');const names=(r.j.result?.tools??[]).map((x)=>x.name);
t('tools/list has the file and spreadsheet tools, and no ChatGPT app tools',['list_files','search_files','read_range','write_range','create_sheet','upload_file'].every((n)=>names.includes(n))&&!names.includes('docs_app')&&!names.includes('app_state'),names.length+' '+names.slice(0,12).join(','));
r=await call(TOK.access_token,'list_files',{});const listed=JSON.stringify(r.v);
t('list_files shows Acme’s spreadsheet and not Bravo’s',listed.includes(S)&&!listed.includes(SB),listed.slice(0,200));
t('with where it is and its page in /workspace',r.v.files?.find((f)=>f.id===S)?.root==='Organization files'&&r.v.files?.find((f)=>f.id===S)?.url===`${B}/workspace/s/${S}`,JSON.stringify(r.v.files?.find((f)=>f.id===S)));
r=await call(TOK.access_token,'search_files',{query:'Budget'});t('search_files finds it',JSON.stringify(r.v).includes(S),JSON.stringify(r.v).slice(0,150));
r=await call(TOK.access_token,'search_files',{query:'Bravo'});t('and not the other organization’s',!JSON.stringify(r.v).includes(SB),JSON.stringify(r.v).slice(0,150));
r=await call(TOK.access_token,'read_range',{sheet_id:S,range:'A1:B1'});t('read_range reads it',JSON.stringify(r.v).includes('Revenue')&&JSON.stringify(r.v).includes('1200'),JSON.stringify(r.v).slice(0,160));
r=await call(TOK.access_token,'write_range',{sheet_id:S,start:'A2',rows:[['Costs','=B1/2']]});t('write_range writes it',r.s===200&&!r.isError,JSON.stringify(r.j).slice(0,160));
r=await api(O.token,'GET',`/api/sheets/${S}`);const cells=(r.j.sheet?.workbook??r.j.workbook)?.tabs?.[0]?.cells??{};
t('Olga sees the agent’s cells through /api: the same data',cells.A2?.v==='Costs'&&cells.B2?.v==='=B1/2',JSON.stringify(cells).slice(0,160));
r=await call(TOK.access_token,'read_range',{sheet_id:SB,range:'A1'});t('a file of the other organization is not there',r.isError,JSON.stringify(r.j).slice(0,140));
r=await call(TOK.access_token,'create_sheet',{title:`Agent sheet ${tag}`});const made=r.v?.file;t('a new file goes in Uma’s My files in Acme',made?.root==='My files'&&made?.url===`${B}/workspace/s/${made?.id}`,JSON.stringify(made??r.j));
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
r=await api(O.token,'DELETE',`/v1/workspaces/${A}/members/${U.user.id}`);t('Olga removes Uma from Acme',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,100));
await sleep(300);
r=await mcp(T4.access_token,'tools/list');t('Uma’s Acme token stops working',r.s===401&&/invalid_token/.test(r.h.get('www-authenticate'))&&r.j.reason==='not_a_member',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(null,'POST','/oauth/token',form({grant_type:'refresh_token',refresh_token:T4.refresh_token,client_id:CLIENT}),'application/x-www-form-urlencoded');t('and cannot be refreshed',r.s===400,JSON.stringify(r.j));
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

console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
