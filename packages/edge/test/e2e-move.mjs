// End-to-end check of POST /v1/admin/accounts/move (routes/admin.ts, docs/move.ts): one person's Docs files and assistant
// chats from one organization to another, against a local `wrangler dev` of its own with a fresh state:
//   mkdir -p public; rm -rf /tmp/edge-move-state
//   npx wrangler dev --port 18797 --local --enable-containers=false --persist-to /tmp/edge-move-state \
//     --var EDGE_ORIGIN_SECRET:x --var FLOW_DATA_KEY:$(openssl rand -base64 32) \
//     --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 \
//     --var WEB_URL_BASE:http://localhost:18797 --var FLOW_WEB_URL:http://localhost:18797 \
//     --var ANTHROPIC_BASE_URL:http://127.0.0.1:18891 --var ANTHROPIC_API_KEY:fake > /tmp/edge-move.log 2>&1 &
//   FAKE_MODEL_PORT=18891 node test/e2e-move.mjs /tmp/edge-move.log
// It reads signup links from the Worker's log. SECRET=<value> if the Worker's EDGE_ORIGIN_SECRET is not `x`. Without
// FAKE_MODEL_PORT (and the two ANTHROPIC vars) the assistant part only checks the route answers for it.
import fs from 'node:fs';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18797'; const SECRET=process.env.SECRET??'x';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,200):''));};
const api=async(tok,m,p,b,type,extra={})=>{const r=await fetch(B+p,{method:m,headers:{...extra,...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':type??'application/json'}:{})},body:b===undefined?undefined:(type?b:JSON.stringify(b))});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const move=(body,secret=SECRET)=>api(null,'POST','/v1/admin/accounts/move',body,undefined,{'x-edge-secret':secret});
const lib=async(tok,org,q='')=>(await api(tok,'GET',`/api/library?workspace=${org}${q}`)).j;
const has=(xs,pred)=>(xs??[]).some(pred);

// --- Una is in two organizations, From and To; Vic is a member of From she shares with -------------------------------------
const U=await signup(`una-${tag}@example.com`,'Una'),V=await signup(`vic-${tag}@example.com`,'Vic');
let r=await api(U.token,'POST','/v1/workspaces',{name:`From ${tag}`,slug:`from-${tag}`});const A=r.j.id;
r=await api(U.token,'POST','/v1/workspaces',{name:`To ${tag}`,slug:`to-${tag}`});const Bo=r.j.id;
t('Una has two organizations',!!A&&!!Bo,JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'POST',`/v1/workspaces/${A}/invites`,{email:`vic-${tag}@example.com`});await api(V.token,'POST','/v1/invites/accept',{token:(r.j.inviteUrl??'').split('/').pop()});
r=await api(U.token,'GET',`/v1/workspaces/${A}/members`);const vicAcct=(r.j.members??[]).find(m=>m.userId===V.user.id)?.accountId;t('Vic joins From',!!vicAcct,JSON.stringify(r.j).slice(0,120));

// --- in From: a spreadsheet shared with the organization, a file in an organization folder, a private folder with a document
r=await api(U.token,'POST',`/api/folders?workspace=${A}`,{name:'Reports'});t('a private folder',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'POST',`/api/folders?workspace=${A}&shared=1`,{name:'Team'});t('an organization folder',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'POST',`/api/sheets?workspace=${A}&shared=1`,{title:'Budget'});const S=r.j.sheet?.id;t('a spreadsheet in Organization files',r.s===200&&r.j.sheet?.shared===true,r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(U.token,'GET',`/api/sheets/${S}?workspace=${A}`);const wb=r.j.workbook;wb.tabs[0].cells={A1:{v:'42'},B1:{v:'=A1*2'}};
r=await api(U.token,'PUT',`/api/sheets/${S}?workspace=${A}`,{workbook:wb});t('saved',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'POST',`/api/files?workspace=${A}&shared=1&folder=Team`,'hello from R2','text/plain',{'x-filename':'hello.txt'});const F=r.j.file?.id??r.j.id;t('a file uploaded into Team',r.s<300&&!!F,r.s+' '+JSON.stringify(r.j).slice(0,130));
r=await api(U.token,'POST',`/api/docs?workspace=${A}&folder=Reports`,{title:'Notes'});const D=r.j.doc?.id;t('a document in Reports',r.s===200&&!!D,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'POST',`/api/favorites?workspace=${A}`,{kind:'sheet',id:S});t('the spreadsheet is a favorite',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'POST',`/api/decks?workspace=${A}&folder=Reports`,{title:'Pitch'});const DK=r.j.deck?.id;t('a presentation in Reports',r.s===200&&!!DK,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'POST',`/api/grants/sheet/${DK}/link?workspace=${A}`);const TOK=(r.j.url??'').split('/p/')[1];t('with a link',r.s===200&&!!TOK,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(U.token,'PUT',`/api/grants/sheet/${S}?workspace=${A}`,{principal:`account:${vicAcct}`,role:'viewer'});t('and is shared with Vic',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
await sleep(1000);
r=await api(V.token,'GET',`/v1/workspaces/${A}/shared-with-me`);const REF=`${A}/docs/sheet/${S}`;t('Vic sees it shared with him',has(r.j.shares,x=>x.ref===REF),JSON.stringify(r.j).slice(0,140));

// --- an assistant chat in From, on a scripted model (FAKE_MODEL_PORT) ---------------------------------------------------
let fakeModel=null;
if(process.env.FAKE_MODEL_PORT){
  const http=await import('node:http');
  const events=[{type:'message_start',message:{id:'msg_e2e',type:'message',role:'assistant',model:'scripted',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}},
    {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Hello from From.'}},{type:'content_block_stop',index:0},
    {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}];
  fakeModel=http.createServer(async(req,res)=>{for await(const _ of req);res.writeHead(200,{'content-type':'text/event-stream'});for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end();});
  await new Promise(r=>fakeModel.listen(Number(process.env.FAKE_MODEL_PORT),'127.0.0.1',r));
  const tr=await fetch(B+`/api/agent/turn?workspace=${A}`,{method:'POST',headers:{authorization:'Bearer '+U.token,'content-type':'application/json'},body:JSON.stringify({message:'Hi',context:{page:'home'},workspace:A})});const x=await tr.text();
  t('a chat in From',tr.status===200&&x.includes('Hello from From.'),tr.status+' '+x.slice(0,120));
  // (To's assistant is not opened before the move: opening it makes an empty chat there, which would stay the current one.)
}

// --- the move ---------------------------------------------------------------------------------------------------------
r=await move({userId:U.user.id,from:A,to:Bo},'wrong');t('refused without the edge secret',r.s===403,r.s);
r=await move({userId:U.user.id,from:A,to:A});t('refused from an organization to itself',r.s===400,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await move({userId:V.user.id,from:A,to:Bo});t('refused for someone with no account in the target',r.s===400&&r.j.error==='no_account',r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await move({userId:U.user.id,from:A,to:Bo});const first=r.j;
console.log('     first move:',JSON.stringify(first));
t('the move answers',r.s===200&&!!first.docs,r.s+' '+JSON.stringify(r.j).slice(0,200));
t('it copied 3 documents, 1 file, 2 folders, the link, the favorite',first.docs?.copied?.sheets===3&&first.docs.copied.stored_files===1&&first.docs.copied.folders===2&&first.docs.copied.grants===1&&first.docs.copied.favorites===1,JSON.stringify(first.docs?.copied));
t('and 4 bodies, none missing',first.docs?.bodies?.copied===4&&first.docs.bodies.missing.length===0,JSON.stringify(first.docs?.bodies));
t('it reports the grants it dropped (the organization, Vic)',has(first.docs?.droppedGrants,g=>g.principal==='org'&&g.id===S)&&has(first.docs?.droppedGrants,g=>g.principal===`account:${vicAcct}`)&&!has(first.docs?.droppedGrants,g=>g.principal.startsWith('link:')),JSON.stringify(first.docs?.droppedGrants));
t('what was shared with From is private in To (the spreadsheet, the file, Team)',first.docs?.madePrivate===3,first.docs?.madePrivate);

let lb=await lib(U.token,Bo);
t('To lists the spreadsheet in My files, and both folders',has(lb.docs,d=>d.id===S&&!d.shared)&&has(lb.folders,f=>f.name==='Reports')&&has(lb.folders,f=>f.name==='Team'),JSON.stringify(lb).slice(0,200));
t('nothing in To\'s Organization files',!(await lib(U.token,Bo,'&shared=1')).docs?.length);
lb=await lib(U.token,Bo,'&folder=Team');t('the file is in Team',has(lb.files,f=>f.id===F),JSON.stringify(lb).slice(0,160));
lb=await lib(U.token,Bo,'&folder=Reports');t('the document is in Reports',has(lb.docs,d=>d.id===D),JSON.stringify(lb).slice(0,160));
r=await api(U.token,'GET',`/api/sheets/${S}?workspace=${Bo}`);t('the spreadsheet\'s body opens in To, private',r.s===200&&JSON.stringify(r.j.workbook).includes('=A1*2')&&!r.j.sheet?.shared,r.s+' '+JSON.stringify(r.j).slice(0,140));
{const d=await fetch(B+`/api/files/${F}?workspace=${Bo}`,{headers:{authorization:'Bearer '+U.token}});const x=await d.text();t('the file downloads from To',d.status===200&&x==='hello from R2',d.status+' '+x.slice(0,80));}
r=await api(U.token,'GET',`/api/docs/${D}?workspace=${Bo}`);t('the document opens in To',r.s===200,r.s);
r=await api(U.token,'GET',`/api/favorites?workspace=${Bo}`);t('the favorite came along',has(r.j.files,f=>f.id===S),JSON.stringify(r.j).slice(0,140));
r=await api(U.token,'GET',`/api/grants/sheet/${S}?workspace=${Bo}`);t('in To the spreadsheet has no grants',r.s===200&&(r.j.grants??[]).length===0,r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(U.token,'GET',`/api/grants/sheet/${DK}?workspace=${Bo}`);t('and the presentation keeps its link',r.s===200&&(r.j.grants??[]).length===1&&r.j.grants[0].principal===`link:${TOK}`,r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(V.token,'GET',`/api/sheets/${S}?workspace=${Bo}`);t('Vic cannot open the copy in To',r.s===403||r.s===404,r.s);
t('From still has everything (no prune)',has((await lib(U.token,A,'&shared=1')).docs,d=>d.id===S)&&has((await lib(U.token,A)).folders,f=>f.name==='Reports'));
r=await api(V.token,'GET',`/api/sheets/${S}?workspace=${A}`);t('and Vic still opens it in From',r.s===200,r.s);
if(fakeModel){
  t('the chat was copied',first.assistant?.copied?.conversations===1&&first.assistant.copied.messages>=2,JSON.stringify(first.assistant));
  r=await api(U.token,'GET',`/api/agent?scope=home&workspace=${Bo}`);t('Una\'s assistant in To shows the chat',has(r.j.items,i=>i.kind==='assistant'&&i.text.includes('Hello from From.')),JSON.stringify(r.j).slice(0,140));
}else t('the route answers for the assistant',!!first.assistant,JSON.stringify(first.assistant));

// --- again: nothing new -------------------------------------------------------------------------------------------------
r=await move({userId:U.user.id,from:A,to:Bo});const again=r.j;
t('a second run copies nothing',r.s===200&&Object.values(again.docs?.copied??{x:1}).every(n=>n===0)&&again.docs.bodies.copied===0&&again.docs.bodies.skipped===4,JSON.stringify(again.docs).slice(0,200));
t('and finds it all already there',again.docs?.already?.sheets===3&&again.docs.already.stored_files===1&&again.docs.already.folders===2,JSON.stringify(again.docs?.already));
if(fakeModel)t('the chat too',again.assistant?.copied?.conversations===0&&again.assistant.already.conversations===1,JSON.stringify(again.assistant));

// --- prune ----------------------------------------------------------------------------------------------------------------
r=await move({userId:U.user.id,from:A,to:Bo,prune:true});const pr=r.j;
console.log('     prune:',JSON.stringify(pr.docs?.deleted),JSON.stringify(pr.assistant?.deleted));
t('prune deletes what To has from From',r.s===200&&pr.docs?.deleted?.sheets===3&&pr.docs.deleted.stored_files===1&&pr.docs.deleted.folders===2&&pr.docs.deleted.favorites===1&&pr.docs.notVerified===0,JSON.stringify(pr.docs).slice(0,200));
lb=await lib(U.token,A,'&shared=1');t('From no longer lists the spreadsheet or Team',!has(lb.docs,d=>d.id===S)&&!has(lb.folders,f=>f.name==='Team'),JSON.stringify(lb).slice(0,160));
lb=await lib(U.token,A);t('nor Reports',!has(lb.folders,f=>f.name==='Reports')&&!has(lb.docs,d=>d.id===D),JSON.stringify(lb).slice(0,160));
r=await api(U.token,'GET',`/api/sheets/${S}?workspace=${A}`);t('the spreadsheet is gone from From',r.s===404,r.s);
{const d=await fetch(B+`/api/files/${F}?workspace=${A}`,{headers:{authorization:'Bearer '+U.token}});t('the file is gone from From',d.status===404,d.status);}
lb=await lib(U.token,Bo);t('To still lists them',has(lb.docs,d=>d.id===S)&&has(lb.folders,f=>f.name==='Team')&&has(lb.folders,f=>f.name==='Reports'),JSON.stringify(lb).slice(0,160));
r=await api(U.token,'GET',`/api/sheets/${S}`);t('the spreadsheet by id alone now reaches To',r.s===200&&JSON.stringify(r.j.workbook).includes('=A1*2'),r.s+' '+JSON.stringify(r.j).slice(0,120));
{const d=await fetch(B+`/api/files/${F}?workspace=${Bo}`,{headers:{authorization:'Bearer '+U.token}});const x=await d.text();t('the file still downloads from To',d.status===200&&x==='hello from R2',d.status+' '+x.slice(0,80));}
r=await api(null,'GET',`/api/public/${TOK}`);t('the link still opens the presentation, from To',r.s===200&&r.j.title==='Pitch',r.s+' '+JSON.stringify(r.j).slice(0,120));
await sleep(1000);
r=await api(V.token,'GET',`/v1/workspaces/${A}/shared-with-me`);t('From\'s share index no longer lists it for Vic',r.s===200&&!has(r.j.shares,x=>x.ref===REF),JSON.stringify(r.j).slice(0,140));
if(fakeModel){
  t('the chat is pruned from From',pr.assistant?.deleted?.conversations===1,JSON.stringify(pr.assistant));
  r=await api(U.token,'GET',`/api/agent?scope=home&workspace=${A}`);t('Una\'s assistant in From is empty',(r.j.items??[]).length===0,JSON.stringify(r.j).slice(0,100));
  r=await api(U.token,'GET',`/api/agent?scope=home&workspace=${Bo}`);t('and in To still has the chat',has(r.j.items,i=>i.kind==='assistant'&&i.text.includes('Hello from From.')),JSON.stringify(r.j).slice(0,100));
}
r=await move({userId:U.user.id,from:A,to:Bo,prune:true});t('pruning again moves and deletes nothing',r.s===200&&Object.values(r.j.docs?.copied??{x:1}).every(n=>n===0)&&Object.values(r.j.docs?.deleted??{x:1}).every(n=>n===0),JSON.stringify(r.j.docs).slice(0,200));
fakeModel?.close();
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
