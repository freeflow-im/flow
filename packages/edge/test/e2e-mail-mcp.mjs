// End-to-end check of the Mail tools on the suite's MCP endpoint (/mcp, src/imap/mailTools.ts, docs/specs/web-mcp.md):
// OAuth consent with the mail scopes as checkboxes, then search, read, organise, draft, send and save to Docs, against the
// GreenMail server in Docker (`flow-greenmail`: SMTP 127.0.0.1:3025, IMAP 127.0.0.1:3143, any password logs in) and a
// local `wrangler dev` of its own, with mail's insecure dev mode on:
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars; mkdir -p public
//   npx wrangler dev --port 18805 --inspector-port 19305 --local --enable-containers=false --local-upstream localhost:18805 \
//     --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 \
//     --var WEB_URL_BASE:http://localhost:18805 --var FLOW_WEB_URL:http://localhost:18805 --var MAIL_ALLOW_INSECURE:1 > /tmp/edge-mail-mcp.log 2>&1 &
//   node test/e2e-mail-mcp.mjs /tmp/edge-mail-mcp.log
// (B=http://localhost:<port> points it at another port; CONSENT_HTML=<file> keeps the consent page.) It reads signup links
// from the Worker's log, because local mail goes there. Each run uses a GreenMail mailbox of its own.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18805';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,200):''));};
const api=async(tok,m,p,b,type,extra={})=>{const r=await fetch(B+p,{method:m,redirect:'manual',headers:{...extra,...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':type??'application/json'}:{})},body:b===undefined?undefined:(type?b:JSON.stringify(b))});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const form=(o)=>new URLSearchParams(o).toString();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const MAIL_USER=`mcp-${tag}@test.local`, BO_MAIL=`bo-${tag}@test.local`;
const imapDirect=async(user,fn)=>{const c=new ImapFlow({host:'127.0.0.1',port:3143,secure:false,doSTARTTLS:false,auth:{user,pass:'x'},logger:false});await c.connect();try{return await fn(c)}finally{await c.logout()}};
const smtp=nodemailer.createTransport({host:'127.0.0.1',port:3025,secure:false,ignoreTLS:true});

// --- Ann, with an organization and a GreenMail account; Bo, with his own ------------------------------------------------
const A=await signup(`ann-${tag}@example.com`,'Ann'),Bo=await signup(`bo-${tag}@example.com`,'Bo');
let r=await api(A.token,'POST','/v1/workspaces',{name:`Acme ${tag}`,slug:`acme-${tag}`});const ORG=r.j.id;
r=await api(Bo.token,'POST','/v1/workspaces',{name:`Bravo ${tag}`,slug:`bravo-${tag}`});const ORG_B=r.j.id;
t('two people, each with an organization',ORG&&ORG_B,JSON.stringify([ORG,ORG_B]));
const server=(port)=>({host:'127.0.0.1',port,security:'none'});
const PROJECTS=`Projects-${tag}`;
await imapDirect(MAIL_USER,async(c)=>{for(const f of ['Trash','Archive',PROJECTS])await c.mailboxCreate(f).catch(()=>{});});
r=await api(A.token,'POST','/v1/mail/accounts',{email:MAIL_USER,displayName:'Ann',password:'x',imap:server(3143),smtp:server(3025)});const ACC=r.j.account?.id;
t('Ann connects her GreenMail account',r.s===201&&ACC,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(Bo.token,'POST','/v1/mail/accounts',{email:BO_MAIL,displayName:'Bo',password:'x',imap:server(3143),smtp:server(3025)});const ACC_B=r.j.account?.id;
t('Bo connects his',r.s===201&&ACC_B,r.s);

// Mail arrives for Ann: three messages from Bo, one with a CSV attachment.
const subj=(n)=>`${n} ${tag}`;
await smtp.sendMail({from:`Bo <${BO_MAIL}>`,to:MAIL_USER,subject:subj('Lunch plans'),text:`Shall we have lunch on Friday? ${tag}`,html:`<p>Shall we have <b>lunch</b> on Friday? See <a href="https://menu.test/today">the menu</a>. ${tag}</p>`,messageId:`<lunch-${tag}@test.local>`});
await smtp.sendMail({from:`Bo <${BO_MAIL}>`,to:MAIL_USER,cc:'cy@test.local',subject:subj('Quarterly numbers'),text:`The numbers are attached. ${tag}`,attachments:[{filename:'numbers.csv',content:`quarter,revenue\nQ3,${1200}\nQ4,1500\n`,contentType:'text/csv'}]});
await smtp.sendMail({from:`Newsletter <news@test.local>`,to:MAIL_USER,subject:subj('Weekly digest'),text:`Lots of news ${tag}`});
await sleep(800);

// --- OAuth: the consent page offers the scopes as checkboxes -----------------------------------------------------------------
r=await api(null,'POST','/oauth/register',{client_name:'Mail Agent',redirect_uris:['http://localhost/callback']});const CLIENT=r.j.client_id;
const cookie=(u)=>({cookie:`sid=${u.token}`});
const pkce=()=>{const v=randomBytes(32).toString('base64url');return{v,c:createHash('sha256').update(v).digest('base64url')}};
const authorizeUrl=(c,extra={})=>'/oauth/authorize?'+form({response_type:'code',client_id:CLIENT,redirect_uri:'http://localhost:51234/callback',code_challenge:c,code_challenge_method:'S256',state:'s',resource:`${B}/mcp`,...extra});
const consentOf=(html)=>({p:/name="p" value="([^"]+)"/.exec(html)?.[1],csrf:/name="csrf" value="([^"]+)"/.exec(html)?.[1],grants:[...html.matchAll(/name="grant_(\w+)" value="on"( checked)?/g)].map((m)=>({id:m[1],checked:!!m[2]}))});
/** The whole flow, ticking `grants` (the page's defaults when not given). */
async function connect(u,org,grants,extra={}){const {v,c}=pkce();let x=await api(null,'GET',authorizeUrl(c,extra),undefined,undefined,cookie(u));const page=await api(null,'GET',x.h.get('location'),undefined,undefined,cookie(u));const f=consentOf(page.j);
  const ticked=grants??f.grants.filter((g)=>g.checked).map((g)=>g.id);
  x=await api(null,'POST','/oauth/decision',form({p:f.p,csrf:f.csrf,org,allow:'yes',scopes_form:'1',...Object.fromEntries(ticked.map((g)=>[`grant_${g}`,'on']))}),'application/x-www-form-urlencoded',{...cookie(u),origin:B});
  if(x.s!==302)return{error:x.s,page:x.j};
  const code=new URL(x.h.get('location')).searchParams.get('code');
  return (await api(null,'POST','/oauth/token',form({grant_type:'authorization_code',code,code_verifier:v,client_id:CLIENT,redirect_uri:'http://localhost:51234/callback'}),'application/x-www-form-urlencoded')).j;}

{const {c}=pkce();const x=await api(null,'GET',authorizeUrl(c),undefined,undefined,cookie(A));const page=await api(null,'GET',x.h.get('location'),undefined,undefined,cookie(A));const f=consentOf(page.j);
 if(process.env.CONSENT_HTML)fs.writeFileSync(process.env.CONSENT_HTML,page.j);
 t('consent offers Docs, Mail, sending and Calendar as checkboxes',JSON.stringify(f.grants)===JSON.stringify([{id:'docs',checked:true},{id:'mail',checked:true},{id:'send',checked:false},{id:'calendar',checked:true}]),JSON.stringify(f.grants));
 t('with a warning on sending',page.j.includes('Send email as you')&&page.j.includes('without asking you first'),'');
 const none=await api(null,'POST','/oauth/decision',form({p:f.p,csrf:f.csrf,org:ORG,allow:'yes',scopes_form:'1'}),'application/x-www-form-urlencoded',{...cookie(A),origin:B});
 t('nothing ticked is refused, on the page again',none.s===403&&none.j.includes('Choose at least one'),none.s);}
const {c:fc}=pkce();r=await api(null,'GET',authorizeUrl(fc,{scope:'files:read files:write'}),undefined,undefined,cookie(A));r=await api(null,'GET',r.h.get('location'),undefined,undefined,cookie(A));
t('a client asking for files alone is offered no mail',JSON.stringify(consentOf(r.j).grants.map((g)=>g.id))==='["docs"]',JSON.stringify(consentOf(r.j).grants));

let rpcId=0;
async function mcp(tok,method,params={}){return api(tok,'POST','/mcp',{jsonrpc:'2.0',id:++rpcId,method,params},undefined,{accept:'application/json, text/event-stream'});}
const list=async(tok)=>((await mcp(tok,'tools/list')).j.result?.tools??[]).map((x)=>x.name);
const call=async(tok,name,args)=>{const x=await mcp(tok,'tools/call',{name,arguments:args});const text=x.j?.result?.content?.[0]?.text;let v;try{v=JSON.parse(text)}catch{v=text}return{...x,v,isError:!!x.j?.result?.isError||!!x.j?.error,text:text??x.j?.error?.message}};
const MAIL_TOOLS=['list_mail_accounts','list_mail_folders','search_mail','read_mail','save_mail_attachment_to_docs','mark_mail','move_mail','archive_mail','move_mail_to_tab','trash_mail','create_mail_draft'];

const DOCS=await connect(A,ORG,['docs']);
t('Docs alone: files:read files:write',DOCS.scope==='files:read files:write',JSON.stringify(DOCS).slice(0,100));
let names=await list(DOCS.access_token);t('and no Mail tools listed',names.includes('write_range')&&!names.some((n)=>/mail/.test(n)),names.filter((n)=>/mail/.test(n)).join(','));
r=await call(DOCS.access_token,'search_mail',{});t('nor callable',r.isError,r.text);
const TOK=await connect(A,ORG);
t('the defaults: Docs, Mail and Calendar, not sending',TOK.scope==='files:read files:write mail:read mail:write calendar:read calendar:write',TOK.scope);
names=await list(TOK.access_token);
t('one list: Docs and Mail tools',MAIL_TOOLS.every((n)=>names.includes(n))&&names.includes('read_range'),names.filter((n)=>/mail/.test(n)).join(','));
t('send_mail is absent without mail:send',!names.includes('send_mail'));
r=await call(TOK.access_token,'send_mail',{to:[BO_MAIL],body:'hi'});t('and refused if called anyway',r.isError,r.text);
r=await mcp(TOK.access_token,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'e2e',version:'1'}});
t('the instructions speak of Mail',/Mail:/.test(r.j.result?.instructions??''),'');

// --- Accounts, folders, search ------------------------------------------------------------------------------------------
r=await call(TOK.access_token,'list_mail_accounts',{});t('list_mail_accounts',r.v.accounts?.length===1&&r.v.accounts[0].id===ACC&&r.v.accounts[0].email===MAIL_USER,JSON.stringify(r.v));
r=await call(TOK.access_token,'list_mail_folders',{account:MAIL_USER});const folders=r.v.folders??[];
t('list_mail_folders, with roles and counts',folders.some((f)=>f.path==='INBOX'&&f.role==='inbox'&&f.total>=3)&&folders.some((f)=>f.path==='Archive'&&f.role==='archive')&&folders.some((f)=>f.path==='Trash'&&f.role==='trash'),JSON.stringify(folders).slice(0,200));
r=await call(TOK.access_token,'search_mail',{});const newest=r.v.messages??[];
t('search_mail with no query: the newest, newest first',newest.length===3&&newest[0].subject===subj('Weekly digest'),newest.map((m)=>m.subject).join(' | '));
t('summaries carry opaque ids and their fields',newest.every((m)=>m.id.startsWith(`${ACC}:INBOX:`)&&m.unread===true&&typeof m.snippet==='string'&&m.date)&&newest.find((m)=>m.subject===subj('Quarterly numbers'))?.has_attachments===true,JSON.stringify(newest[1]).slice(0,200));
const id=(s)=>newest.find((m)=>m.subject===subj(s))?.id;
r=await call(TOK.access_token,'search_mail',{query:'lunch'});t('search_mail with a query',r.v.messages?.length===1&&r.v.messages[0].id===id('Lunch plans'),JSON.stringify(r.v).slice(0,160));
r=await call(TOK.access_token,'search_mail',{limit:2});t('limit and next',r.v.messages?.length===2&&typeof r.v.next==='number',JSON.stringify({n:r.v.messages?.length,next:r.v.next}));
r=await call(TOK.access_token,'search_mail',{limit:2,before:r.v.next});t('before: the next page',r.v.messages?.length===1&&r.v.messages[0].subject===subj('Lunch plans'),JSON.stringify(r.v).slice(0,160));
r=await call(TOK.access_token,'search_mail',{tab:'promotions'});t('a tab where the inbox has none is refused',r.isError&&/tabs/.test(r.text),r.text);

// --- Reading -----------------------------------------------------------------------------------------------------------------
r=await call(TOK.access_token,'read_mail',{ids:[id('Lunch plans'),id('Quarterly numbers')]});const read=r.v.messages??[];
t('read_mail reads several',read.length===2,JSON.stringify(r.v).slice(0,200));
t('the HTML body as text, links kept',read[0]?.body?.includes('Shall we have lunch on Friday? See the menu (https://menu.test/today).'),read[0]?.body);
t('headers and attachments',read[1]?.from===`Bo <${BO_MAIL}>`&&read[1]?.cc?.[0]==='cy@test.local'&&read[1]?.attachments?.[0]?.filename==='numbers.csv'&&read[1]?.attachments[0].index===0,JSON.stringify(read[1]).slice(0,200));
r=await call(TOK.access_token,'search_mail',{unread_only:true});t('reading did not mark them read',r.v.messages?.length===3,r.v.messages?.length);
r=await call(TOK.access_token,'read_mail',{ids:['not-an-id']});t('a malformed id is refused',r.isError&&/not a message id/.test(r.text),r.text);

// --- Organising ----------------------------------------------------------------------------------------------------------------
r=await call(TOK.access_token,'mark_mail',{ids:[id('Lunch plans')],read:true,starred:true});t('mark_mail',r.v.marked===1,JSON.stringify(r.v));
r=await call(TOK.access_token,'search_mail',{unread_only:true});t('now two unread',r.v.messages?.length===2&&!r.v.messages.some((m)=>m.id===id('Lunch plans')),r.v.messages?.length);
r=await call(TOK.access_token,'search_mail',{query:'lunch'});t('and it is starred',r.v.messages?.[0]?.starred===true&&r.v.messages[0].unread===false,JSON.stringify(r.v.messages?.[0]).slice(0,120));
r=await call(TOK.access_token,'move_mail',{ids:[id('Weekly digest')],to_folder:PROJECTS});t('move_mail',r.v.moved===1,JSON.stringify(r.v));
r=await call(TOK.access_token,'search_mail',{folder:PROJECTS});t('it is in the other folder',r.v.messages?.length===1&&r.v.messages[0].subject===subj('Weekly digest'),JSON.stringify(r.v).slice(0,140));
const digest=r.v.messages?.[0]?.id;
r=await call(TOK.access_token,'archive_mail',{ids:[id('Lunch plans')]});t('archive_mail',r.v.archived===1&&r.v.to_folder==='Archive',JSON.stringify(r.v));
r=await call(TOK.access_token,'trash_mail',{ids:[digest]});t('trash_mail',r.v.trashed===1,JSON.stringify(r.v));
const boxes=await imapDirect(MAIL_USER,async(c)=>{const n={};for(const f of ['INBOX','Archive','Trash',PROJECTS]){const s=await c.status(f,{messages:true});n[f]=s.messages;}return n;});
t('IMAP agrees: one in INBOX, one in Archive, one in Trash, none left in the other folder',boxes.INBOX===1&&boxes.Archive===1&&boxes.Trash===1&&boxes[PROJECTS]===0,JSON.stringify(boxes));
r=await call(TOK.access_token,'search_mail',{folder:'Trash'});const inTrash=r.v.messages?.[0]?.id;
r=await call(TOK.access_token,'trash_mail',{ids:[inTrash]});t('trash_mail never deletes what is already in Trash',r.isError&&/already in Trash/.test(r.text),r.text);
r=await call(TOK.access_token,'search_mail',{folder:'Trash'});t('it is still there',r.v.messages?.length===1,r.v.messages?.length);
r=await call(TOK.access_token,'move_mail_to_tab',{ids:[id('Quarterly numbers')],tab:'updates'});t('move_mail_to_tab needs inbox tabs',r.isError&&/tabs/.test(r.text),r.text);

// --- Drafts ------------------------------------------------------------------------------------------------------------------
r=await call(TOK.access_token,'create_mail_draft',{to:[`Bo <${BO_MAIL}>`],bcc:['boss@test.local'],subject:subj('Budget'),body:'Hi Bo,\n\nThe **budget** is [here](https://x.test/b).'});const draft=r.v;
t('create_mail_draft',draft.saved&&draft.draft_id?.startsWith(`${ACC}:Drafts:`)&&draft.link?.startsWith(`${B}/mail/?account=${ACC}&folder=Drafts&uid=`),JSON.stringify(draft).slice(0,200));
const raw=async(folder,uid)=>imapDirect(MAIL_USER,async(c)=>{const lock=await c.getMailboxLock(folder);try{const m=await c.fetchOne(String(uid),{flags:true,source:true},{uid:true});return m?{flags:[...m.flags],source:m.source.toString()}:null}finally{lock.release()}});
let d=await raw('Drafts',draft.draft_id?.split(':').pop());
t('it is in Drafts with \\Draft',d?.flags.includes('\\Draft'),JSON.stringify(d?.flags));
t('its MIME: Bcc kept, both bodies',/^Bcc: boss@test\.local/m.test(d?.source??'')&&/text\/html/.test(d?.source??'')&&/text\/plain/.test(d?.source??'')&&/<strong>budget<\/strong>/.test(d?.source??''),(d?.source??'').slice(0,200));
r=await call(TOK.access_token,'read_mail',{ids:[draft.draft_id]});t('read_mail reads it back',r.v.messages?.[0]?.subject===subj('Budget')&&r.v.messages[0].bcc?.[0]==='boss@test.local',JSON.stringify(r.v).slice(0,160));
r=await call(TOK.access_token,'create_mail_draft',{body:'Friday works.',reply_to_id:id('Quarterly numbers'),reply_all:true});const reply=r.v;
t('a reply draft: to the sender, Cc the rest, Re:',reply.saved&&reply.to?.[0]===`Bo <${BO_MAIL}>`&&reply.subject===`Re: ${subj('Quarterly numbers')}`,JSON.stringify(reply).slice(0,200));
d=await raw('Drafts',reply.draft_id?.split(':').pop());
const origId=await imapDirect(MAIL_USER,async(c)=>{const lock=await c.getMailboxLock('INBOX');try{const m=await c.fetchOne('*',{envelope:true});return m.envelope.messageId}finally{lock.release()}});
t('threaded and quoted',new RegExp(`^In-Reply-To: ${origId.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`,'m').test(d?.source??'')&&/^Cc: cy@test\.local/m.test(d?.source??'')&&/wrote:/.test(d?.source??''),(d?.source??'').split('\n').filter((l)=>/^(In-Reply-To|Cc|References)/.test(l)).join(' / '));
r=await call(TOK.access_token,'create_mail_draft',{to:[BO_MAIL],body:'FYI',forward_id:id('Quarterly numbers')});d=await raw('Drafts',r.v.draft_id?.split(':').pop());
t('a forward draft carries the attachment',r.v.subject===`Fwd: ${subj('Quarterly numbers')}`&&/numbers\.csv/.test(d?.source??''),r.v.subject);

// --- Sending, with mail:send ---------------------------------------------------------------------------------------------------
const SEND=await connect(A,ORG,['docs','mail','send']);
t('ticking Send email as you grants mail:send',SEND.scope==='files:read files:write mail:read mail:write mail:send',SEND.scope);
names=await list(SEND.access_token);t('send_mail is listed then',names.includes('send_mail'),'');
r=await call(SEND.access_token,'send_mail',{to:[`Bo <${BO_MAIL}>`],subject:subj('Sent by the agent'),body:'Hello from **the agent**.'});
t('send_mail sends',r.v.sent&&/^<.+>$/.test(r.v.message_id),JSON.stringify(r.v).slice(0,140));
await sleep(800);
const sent=await imapDirect(MAIL_USER,async(c)=>{const lock=await c.getMailboxLock('Sent').catch(()=>null);if(!lock)return[];try{const out=[];for await(const m of c.fetch('1:*',{envelope:true}))out.push(m.envelope.subject);return out}finally{lock.release()}});
t('a copy is in Sent',sent.includes(subj('Sent by the agent')),JSON.stringify(sent));
const boGot=await imapDirect(BO_MAIL,async(c)=>{const lock=await c.getMailboxLock('INBOX');try{const out=[];for await(const m of c.fetch('1:*',{envelope:true}))out.push(m.envelope.subject);return out}finally{lock.release()}});
t('and Bo got it',boGot.includes(subj('Sent by the agent')),JSON.stringify(boGot));
r=await call(SEND.access_token,'send_mail',{draft_id:draft.draft_id});t('send_mail sends a saved draft',r.v.sent===true,JSON.stringify(r.v).slice(0,140));
await sleep(800);
d=await raw('Drafts',draft.draft_id?.split(':').pop());t('which leaves Drafts',d===null,JSON.stringify(d?.flags));
const boGot2=await imapDirect(BO_MAIL,async(c)=>{const lock=await c.getMailboxLock('INBOX');try{const out=[];for await(const m of c.fetch('1:*',{envelope:true}))out.push(m.envelope.subject);return out}finally{lock.release()}});
t('and Bo got the draft',boGot2.includes(subj('Budget')),JSON.stringify(boGot2));

// --- Saving an attachment to Docs ----------------------------------------------------------------------------------------------
r=await call(TOK.access_token,'save_mail_attachment_to_docs',{id:id('Quarterly numbers'),index:0});const saved=r.v.file;
t('save_mail_attachment_to_docs makes a spreadsheet in My files',saved?.kind==='sheet'&&saved.root==='My files'&&saved.url===`${B}/workspace/s/${saved.id}`,JSON.stringify(r.v).slice(0,200));
r=await call(TOK.access_token,'read_range',{sheet_id:saved?.id,range:'A1:B3'});t('read_range reads it',JSON.stringify(r.v).includes('revenue')&&JSON.stringify(r.v).includes('1200'),JSON.stringify(r.v).slice(0,160));
r=await api(A.token,'GET',`/api/sheets?workspace=${ORG}`);t('Docs lists it in Ann’s files',JSON.stringify(r.j).includes(saved?.id),r.s);
r=await call(TOK.access_token,'save_mail_attachment_to_docs',{id:id('Quarterly numbers'),index:5});t('a wrong index is refused',r.isError,r.text);
const RO=await connect(A,ORG,['mail']);names=await list(RO.access_token);
t('without files:write there is no saving to Docs, and no Docs tools',!names.includes('save_mail_attachment_to_docs')&&!names.includes('read_range')&&names.includes('search_mail'),names.join(','));

// --- Another person's mail -------------------------------------------------------------------------------------------------------
const BOTOK=await connect(Bo,ORG_B);
r=await call(BOTOK.access_token,'read_mail',{ids:[id('Quarterly numbers')]});t('Bo cannot read Ann’s message by its id',r.isError&&/Not found/.test(r.text),r.text);
r=await call(BOTOK.access_token,'trash_mail',{ids:[id('Quarterly numbers')]});t('nor trash it',r.isError,r.text);
r=await call(BOTOK.access_token,'create_mail_draft',{body:'x',reply_to_id:id('Quarterly numbers')});t('nor reply to it',r.isError,r.text);
r=await call(BOTOK.access_token,'list_mail_accounts',{});t('he sees only his own account',r.v.accounts?.length===1&&r.v.accounts[0].id===ACC_B,JSON.stringify(r.v).slice(0,120));
const still=await imapDirect(MAIL_USER,async(c)=>(await c.status('INBOX',{messages:true})).messages);t('Ann’s inbox is untouched',still===1,still);

console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
