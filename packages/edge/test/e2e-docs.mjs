// Against the rehearsal host instead: B=https://edge.freeflow.im, with LOG unused (sign-up mail is real there).
// End-to-end check of Docs through the Worker and an organization's Docs object, against a local `wrangler dev` started as
// test/e2e.mjs says (same port and log). It reads signup links from the Worker's log, because local mail goes there.
// B=http://localhost:<port> points it at another port. With FAKE_MODEL_PORT=<port> it checks the assistant (the Assistant
// object, platform.md §5.5) against a scripted Anthropic API this script serves there: start the Worker with
// --var ANTHROPIC_BASE_URL:http://127.0.0.1:<port> --var ANTHROPIC_API_KEY:fake.
import fs from 'node:fs';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18796';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const api=async(tok,m,p,b,type,extra={})=>{const r=await fetch(B+p,{method:m,headers:{...extra,...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':type??'application/json'}:{})},body:b===undefined?undefined:(type?b:JSON.stringify(b))});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const A=await signup(`dana-${tag}@example.com`,'Dana'),Bo=await signup(`eli-${tag}@example.com`,'Eli');
let r=await api(A.token,'POST','/v1/workspaces',{name:'Docs Org',slug:`docs-${tag}`});const W=r.j.id;
r=await api(Bo.token,'POST','/v1/workspaces',{name:'Other Org',slug:`other-${tag}`});const W2=r.j.id;
r=await api(A.token,'GET','/api/auth/me');t('Docs knows who is calling',r.s===200&&r.j.user?.id===A.user.id,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST',`/api/sheets?workspace=${W}&shared=1`,{title:'Budget'});t('create a spreadsheet in the organization',r.s===200&&r.j.sheet?.id,r.s+' '+JSON.stringify(r.j).slice(0,140));const S=r.j.sheet?.id;
r=await api(A.token,'GET',`/api/sheets?workspace=${W}&shared=1`);t('list it',JSON.stringify(r.j).includes(S),r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET',`/api/sheets/${S}`);t('read it by id alone',r.s===200&&JSON.stringify(r.j).includes('Budget'),r.s+' '+JSON.stringify(r.j).slice(0,120));
const wb=r.j.sheet?.workbook??r.j.workbook;
if(wb){const tab=wb.tabs[0];tab.cells={...(tab.cells??{}),A1:{v:'42'},B1:{v:'=A1*2'}};r=await api(A.token,'PUT',`/api/sheets/${S}`,{workbook:wb,base:r.j.sheet?.updatedAt??r.j.updatedAt});t('save it',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,140));
 r=await api(A.token,'GET',`/api/sheets/${S}`);t('the body came back from R2',JSON.stringify(r.j).includes('=A1*2'),JSON.stringify(r.j).slice(0,140));}
r=await api(Bo.token,'GET',`/api/sheets/${S}`);t('a stranger cannot read it',r.s===404||r.s===403,r.s);
r=await api(A.token,'POST','/api/recents',{kind:'sheet',id:S});t('record it as opened',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'GET',`/api/recents?workspace=${W}`);t('Recents lists it',r.s===200&&r.j.files?.[0]?.id===S,r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'POST',`/api/docs?workspace=${W}&shared=1`,{title:'Notes'});t('create a document',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));const DOC=r.j.doc?.id;
r=await api(A.token,'POST',`/api/markdown?workspace=${W}&shared=1`,{title:'Readme'});t('create Markdown',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'POST',`/api/files?workspace=${W}&shared=1`,'hello from R2','text/plain',{'x-filename':'hello.txt'});t('upload a file',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,130));const F=r.j.file?.id??r.j.id;
if(F){let d=await fetch(B+`/api/files/${F}`,{headers:{authorization:'Bearer '+A.token}});const x=await d.text();t('download it',d.status===200&&x==='hello from R2',d.status+' '+x.slice(0,80));}
const ctl=new AbortController();const ev=await fetch(B+`/api/revisions/${S}`,{headers:{authorization:'Bearer '+A.token},signal:ctl.signal}).catch(e=>({status:0,e}));
if(ev.status===200){const rd=ev.body.getReader();const first=await Promise.race([rd.read(),sleep(4000).then(()=>null)]);t('revision feed streams',!!first&&new TextDecoder().decode(first.value).startsWith('data:'),first?new TextDecoder().decode(first.value).slice(0,60):'nothing in 4s');ctl.abort();}else t('revision feed streams',false,ev.status);
// Opt in with PDF=1: it needs Browser Rendering, which has not yet worked under local `wrangler dev` (it hung downloading a browser).
if(process.env.PDF){const pdf=await fetch(B+`/api/files/${DOC}/export?format=pdf`,{headers:{authorization:'Bearer '+A.token},signal:AbortSignal.timeout(90_000)});const pb=Buffer.from(await pdf.arrayBuffer());
t('a document as a PDF, printed by the browser binding',pdf.status===200&&pb.subarray(0,5).toString()==='%PDF-',pdf.status+' '+pb.subarray(0,120).toString().replace(/\s+/g,' '));}
// PDF to Markdown, with pdf.js on the Worker (packages/docs server/runtime/workerd/pdfText.ts).
const fixture=n=>fs.readFileSync(new URL(`./fixtures/${n}`,import.meta.url));
r=await api(A.token,'POST',`/api/import/pdf?workspace=${W}&shared=1&filename=${encodeURIComponent('Q3 Report.pdf')}`,fixture('report.pdf'),'application/octet-stream');t('upload a PDF',r.s===200&&r.j.file?.id,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST',`/api/files/${r.j.file?.id}/markdown`);t('turn it into Markdown',r.s===200&&r.j.doc?.kind==='markdown'&&r.j.doc?.title==='Q3 Report'&&r.j.pages===2,r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET',`/api/markdown/${r.j.doc?.id}`);t('the Markdown has its text and headings',/^# Quarterly Report\n\nThe office filed every expense/.test(r.j.doc?.text??'')&&(r.j.doc?.text??'').includes('## Next Steps'),JSON.stringify(r.j.doc?.text??r.j).slice(0,160));
r=await api(A.token,'POST',`/api/import/pdf?workspace=${W}&shared=1&filename=scan.pdf`,fixture('scan.pdf'),'application/octet-stream');
// With OCR=1, wrangler dev runs the PdfOcr container (Docker) and the scan is read; without it, the scan is refused, saying why.
r=await api(A.token,'POST',`/api/files/${r.j.file?.id}/markdown`);
if(process.env.OCR){const md=r.s===200?(await api(A.token,'GET',`/api/markdown/${r.j.doc?.id}`)).j.doc?.text??'':'';t('a scan is read with OCR in the container',r.s===200&&JSON.stringify(r.j.ocrPages)==='[1]'&&/Scanned Receipt/.test(md),r.s+' '+JSON.stringify(r.j).slice(0,160)+' '+md.slice(0,80));}
else t('a scan says it needs OCR',r.s===400&&/OCR/.test(r.j.error),r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(Bo.token,'GET',`/api/sheets?workspace=${W2}&shared=1`);t('the other organization is separate',!JSON.stringify(r.j).includes(S),JSON.stringify(r.j).slice(0,100));
r=await api(null,'GET','/api/sheets');t('no session refused',r.s===401,r.s);
// Sharing on grants (platform phase 3.2, docs/server/access.ts): Eli joins Dana's organization, which gives him nothing of hers until she shares it.
r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{email:`eli-${tag}@example.com`});r=await api(Bo.token,'POST','/v1/invites/accept',{token:(r.j.inviteUrl??'').split('/').pop()});t('Eli joins the organization',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'GET',`/v1/workspaces/${W}/members`);const eliAcct=(r.j.members??[]).find(m=>m.userId===Bo.user.id)?.accountId;t('the members list carries Eli\'s account',!!eliAcct,JSON.stringify(r.j).slice(0,140));
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/channels`);const general=(r.j.channels??[]).find(c=>c.name==='general')??(r.j.channels??[])[0];if(general&&!general.isMember)await api(Bo.token,'POST',`/v1/channels/${general.id}/join`);
// A new file is private wherever it is made (platform phase 3.5): one naming no scope, its organization only in the body as
// the client sends it, is in My files and not Organization files; Eli's first organization is his own, so it also has to reach W's object.
r=await api(Bo.token,'POST','/api/sheets',{title:'No scope sheet',workspace:W});const NS=r.j.sheet?.id;
{const org=(await api(Bo.token,'GET',`/api/library?workspace=${W}&shared=1`)).j,me=(await api(Bo.token,'GET',`/api/library?workspace=${W}`)).j;
 t('a sheet made with no scope is private: in My files, not Organization files',r.s===200&&!r.j.sheet?.shared&&r.j.sheet?.workspaceId===W&&(me.docs??[]).some(d=>d.id===NS)&&!(org.docs??[]).some(d=>d.id===NS),r.s+' '+JSON.stringify(r.j).slice(0,120));}
r=await api(A.token,'POST',`/api/sheets?workspace=${W}`,{title:'Private budget'});const P=r.j.sheet?.id;t('Dana makes a private spreadsheet',r.s===200&&!r.j.sheet?.shared,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(Bo.token,'GET',`/api/sheets/${P}`);t('Eli cannot open it',r.s===404||r.s===403,r.s);
r=await api(A.token,'PUT',`/api/grants/sheet/${P}?workspace=${W}`,{principal:`account:${eliAcct}`,role:'viewer'});t('Dana shares it with Eli as a viewer',r.s===200&&r.j.grants?.[0]?.role==='viewer',r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(Bo.token,'GET',`/api/sheets/${P}`);const pwb=r.j.workbook;t('Eli opens it, as a viewer',r.s===200&&r.j.sheet?.role==='viewer',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(Bo.token,'GET',`/api/library?workspace=${W}&scope=shared`);t('it is under Shared with me',(r.j.docs??[]).some(d=>d.id===P),r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(Bo.token,'PUT',`/api/sheets/${P}`,{workbook:pwb});t('Eli cannot change it',r.s===403,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'PUT',`/api/grants/sheet/${P}?workspace=${W}`,{principal:`account:${eliAcct}`,role:'editor'});t('Dana makes Eli an editor',r.s===200,r.s);
r=await api(Bo.token,'PUT',`/api/sheets/${P}`,{workbook:pwb});t('Eli changes it',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'POST','/api/folders',{workspace:W,name:'Shared Q4'});r=await api(A.token,'GET',`/api/library?workspace=${W}`);const FD=(r.j.folders??[]).find(f=>f.name==='Shared Q4');t('a folder has an object id',!!FD?.id,JSON.stringify(r.j.folders));
r=await api(A.token,'POST',`/api/docs?workspace=${W}&folder=${encodeURIComponent('Shared Q4')}`,{title:'Inside notes'});const IN=r.j.doc?.id;
r=await api(Bo.token,'GET',`/api/docs/${IN}`);t('a file in a private folder is not Eli\'s',r.s===404||r.s===403,r.s);
r=await api(A.token,'PUT',`/api/grants/folder/${encodeURIComponent(FD?.id??'')}?workspace=${W}`,{principal:`channel:${general?.id}`,role:'viewer'});t('Dana shares the folder with #general',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(Bo.token,'GET',`/api/docs/${IN}`);t('Eli opens the file inside, by inheritance',r.s===200&&r.j.meta?.role==='viewer',r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'POST',`/api/decks?workspace=${W}`,{title:'Pitch'});const DK=r.j.deck?.id;
r=await api(A.token,'POST',`/api/grants/sheet/${DK}/link?workspace=${W}`);const LINK=r.j.url??'';const TOK=LINK.split('/p/')[1];t('Dana makes a link',r.s===200&&!!TOK,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(null,'GET',`/api/public/${TOK}`);t('anyone opens it, not signed in',r.s===200&&r.j.kind==='deck'&&r.j.title==='Pitch',r.s+' '+JSON.stringify(r.j).slice(0,120));
{const pg=await fetch(B+new URL(LINK).pathname,{redirect:'manual'});t('its /p/ address answers',pg.status===200||pg.status===301,pg.status);}
r=await api(A.token,'DELETE',`/api/grants/sheet/${DK}/${encodeURIComponent('link:'+TOK)}?workspace=${W}`);t('Dana removes the link',r.s===200&&!r.j.link,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(null,'GET',`/api/public/${TOK}`);t('the link stops working',r.s===404,r.s);
r=await api(A.token,'PUT',`/api/grants/sheet/${P}?workspace=${W}`,{principal:'org',role:'editor'});t('the organization toggle on',r.s===200&&(r.j.grants??[]).some(g=>g.principal==='org'),r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(Bo.token,'GET',`/api/library?workspace=${W}&shared=1`);const inOrg=(r.j.docs??[]).some(d=>d.id===P);r=await api(A.token,'GET',`/api/library?workspace=${W}`);t('it moved to Organization files',inOrg&&!(r.j.docs??[]).some(d=>d.id===P),inOrg);
r=await api(A.token,'DELETE',`/api/grants/sheet/${P}/org?workspace=${W}`);r=await api(A.token,'GET',`/api/library?workspace=${W}`);const back=(r.j.docs??[]).some(d=>d.id===P);r=await api(Bo.token,'GET',`/api/library?workspace=${W}&shared=1`);t('and back to My files',back&&!(r.j.docs??[]).some(d=>d.id===P),back);
// The share index (platform phase 3.3): Docs reports each grant to the Org object, which keeps `shares`, publishes
// sharing.granted / sharing.revoked, notifies the person or posts the card in the channel; a save is docs.file.changed
// for whoever the file is shared with, read from the index. Fay is a member it is not shared with.
const Fy=await signup(`fay-${tag}@example.com`,'Fay');r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{email:`fay-${tag}@example.com`});await api(Fy.token,'POST','/v1/invites/accept',{token:(r.j.inviteUrl??'').split('/').pop()});
const evs=async(tok,since,types)=>(await api(tok,'GET',`/v1/events?workspace=${W}&since=${since}&types=${types}`)).j.events??[];
const since0=0;
r=await api(A.token,'POST',`/api/sheets?workspace=${W}`,{title:'Q4 plan'});const Q=r.j.sheet?.id;const QREF=`${W}/docs/sheet/${Q}`;
r=await api(A.token,'PUT',`/api/grants/sheet/${Q}?workspace=${W}`,{principal:`account:${eliAcct}`,role:'viewer'});t('Dana shares Q4 plan with Eli',r.s===200,r.s);
await sleep(1500);
r=await api(Bo.token,'GET',`/v1/me/notifications?workspace=${W}`);t('Eli has a notification naming the file',(r.j.notifications??[]).some(n=>/Dana shared Q4 plan with you/.test(n.message?.body??'')&&(n.message?.body??'').includes(`/docs/s/${Q}`)),r.s+' '+JSON.stringify(r.j).slice(0,160));
let es=await evs(Bo.token,since0,'sharing.granted');t('sharing.granted is in Eli\'s read, with the reference',es.some(e=>e.data?.ref===QREF&&e.ref?.id===Q&&e.data?.url===`/docs/s/${Q}`),JSON.stringify(es).slice(0,160));
es=await evs(Fy.token,since0,'sharing.granted');t('and not in Fay\'s',!es.some(e=>e.data?.ref===QREF),JSON.stringify(es).slice(0,120));
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/shared-with-me`);t('shared-with-me lists it for Eli',r.s===200&&(r.j.shares??[]).some(x=>x.ref===QREF&&x.title==='Q4 plan'&&x.role==='viewer'&&x.kind==='sheet'),r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(Fy.token,'GET',`/v1/workspaces/${W}/shared-with-me`);t('and not for Fay',r.s===200&&!(r.j.shares??[]).some(x=>x.ref===QREF),r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(Bo.token,'GET',`/v1/channels/${general?.id}/messages`);t('the folder shared with #general left a card with its address',(r.j.messages??[]).some(m=>m.systemKind==='file_shared'&&/Dana shared Shared Q4 with this channel\n\S*\/docs\/\?withme=1&in=/.test(m.body)),JSON.stringify((r.j.messages??[]).slice(0,2)).slice(0,170));
r=await api(A.token,'GET',`/api/sheets/${Q}`);const qwb=r.j.workbook;qwb.tabs[0].cells={A1:{v:'7'}};r=await api(A.token,'PUT',`/api/sheets/${Q}`,{workbook:qwb});t('Dana saves a change',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,100));
await sleep(1500);
es=await evs(Bo.token,since0,'docs.file.changed');t('Eli\'s read shows docs.file.changed',es.some(e=>e.data?.ref===QREF&&e.data?.kind==='sheet'&&e.data?.title==='Q4 plan'&&!!e.data?.ownerAccountId),JSON.stringify(es).slice(0,160));
es=await evs(Fy.token,since0,'docs.file.changed');t('a non-grantee\'s does not',!es.some(e=>e.data?.ref===QREF),JSON.stringify(es).slice(0,120));
es=await evs(A.token,since0,'docs.file.changed');t('its owner\'s does',es.some(e=>e.data?.ref===QREF),JSON.stringify(es).slice(0,120));
r=await api(A.token,'DELETE',`/api/grants/sheet/${Q}/${encodeURIComponent('account:'+eliAcct)}?workspace=${W}`);t('Dana stops sharing it',r.s===200,r.s);
await sleep(1500);
es=await evs(Bo.token,since0,'sharing.revoked');t('sharing.revoked is in Eli\'s read',es.some(e=>e.data?.ref===QREF),JSON.stringify(es).slice(0,140));
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/shared-with-me`);t('shared-with-me no longer lists it',r.s===200&&!(r.j.shares??[]).some(x=>x.ref===QREF),JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'GET',`/api/sheets/${Q}`);const qwb2=r.j.workbook;qwb2.tabs[0].cells={A1:{v:'8'}};await api(A.token,'PUT',`/api/sheets/${Q}`,{workbook:qwb2});await sleep(1000);
es=await evs(Bo.token,since0,'docs.file.changed');t('docs.file.changed is no longer visible to Eli',!es.some(e=>e.data?.ref===QREF),JSON.stringify(es).slice(0,140));
// A moved folder re-keys the share index (platform phase 3.4): its object id changes with its root, and Eli's
// shared-with-me follows.
const FOLD=`${W}/docs/folder/${FD?.id}`;
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/shared-with-me`);t('shared-with-me has the folder shared with #general',(r.j.shares??[]).some(x=>x.ref===FOLD),JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'POST','/api/folders/scope',{path:'Shared Q4',from:{workspace:W},workspace:W,shared:true});t('Dana moves the shared folder to the organization root',r.s===200,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET',`/api/library?workspace=${W}&shared=1`);const FNEW=(r.j.folders??[]).find(f=>f.name==='Shared Q4')?.id;const FREF=`${W}/docs/folder/${FNEW}`;
await sleep(1500);
r=await api(Bo.token,'GET',`/v1/workspaces/${W}/shared-with-me`);t('Eli\'s shared-with-me lists the new reference and not the old',!!FNEW&&FNEW!==FD?.id&&(r.j.shares??[]).some(x=>x.ref===FREF&&x.kind==='folder')&&!(r.j.shares??[]).some(x=>x.ref===FOLD),FNEW+' '+JSON.stringify(r.j).slice(0,200));
r=await api(Bo.token,'GET',`/v1/channels/${general?.id}/messages`);t('the move posts no second card',(r.j.messages??[]).filter(m=>m.systemKind==='file_shared'&&/Shared Q4/.test(m.body)).length===1,JSON.stringify((r.j.messages??[]).filter(m=>m.systemKind==='file_shared').map(m=>m.body)).slice(0,170));

// The assistant, one object per account (platform phase 6.3), on a scripted model: this script answers the Worker's
// Anthropic calls. A turn from Docs (its workspace in the body, as Docs' client sends it) lists Dana's documents through the
// Docs object; its chat is listed afterwards, from Docs and from Mail's panel (?workspace=); a Mail chat sits beside it;
// a browser tool pauses the turn and its result resumes it; Eli's assistant is his own.
if(process.env.FAKE_MODEL_PORT){
  const http=await import('node:http');
  const sse=(res,events)=>{res.writeHead(200,{'content-type':'text/event-stream'});for(const e of events)res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);res.end();};
  const reply=(blocks,stop)=>[{type:'message_start',message:{id:'msg_e2e',type:'message',role:'assistant',model:'scripted',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}},
    ...blocks.flatMap((b,i)=>b.type==='text'?[{type:'content_block_start',index:i,content_block:{type:'text',text:''}},{type:'content_block_delta',index:i,delta:{type:'text_delta',text:b.text}},{type:'content_block_stop',index:i}]
      :[{type:'content_block_start',index:i,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}},{type:'content_block_delta',index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}},{type:'content_block_stop',index:i}]),
    {type:'message_delta',delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:5}},{type:'message_stop'}];
  const asked=[];
  const fakeModel=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;const p=JSON.parse(b);asked.push({tools:(p.tools??[]).map(t=>t.name)});
    const last=p.messages.at(-1)?.content??[];const result=Array.isArray(last)&&last.find(x=>x.type==='tool_result');
    if(result)return sse(res,reply([{type:'text',text:`Found: ${typeof result.content==='string'?result.content:JSON.stringify(result.content)}`}],'end_turn'));
    const said=Array.isArray(last)?last.filter(x=>x.type==='text').map(x=>x.text).join(' '):String(last);
    const tool=/my docs/.test(said)?'list_docs':/my files/.test(said)?'list_files':null;
    sse(res,tool?reply([{type:'tool_use',id:'tu_'+tool+'_'+asked.length,name:tool,input:{}}],'tool_use'):reply([{type:'text',text:'Hello.'}],'end_turn'));});
  await new Promise(r=>fakeModel.listen(Number(process.env.FAKE_MODEL_PORT),'127.0.0.1',r));
  const turn=async(tok,body,q='')=>{const res=await fetch(B+'/api/agent/turn'+q,{method:'POST',headers:{authorization:'Bearer '+tok,'content-type':'application/json'},body:JSON.stringify(body)});const x=await res.text();return{s:res.status,ev:x.split('\n\n').filter(c=>c.startsWith('data: ')).map(c=>JSON.parse(c.slice(6))),x};};
  const AN=`Assistant notes ${tag}`;await api(A.token,'POST',`/api/docs?workspace=${W}`,{title:AN});
  let tr=await turn(A.token,{message:'What are my docs?',context:{page:'home'},workspace:W});
  t('a turn from Docs runs list_docs on the Docs object and reads the result back',tr.s===200&&tr.ev.some(e=>e.type==='tool_start'&&e.name==='list_docs')&&tr.ev.some(e=>e.type==='tool_end'&&e.ok)&&tr.ev.some(e=>e.type==='text'&&e.text.includes(AN))&&tr.ev.at(-1)?.type==='done',tr.s+' '+tr.x.slice(0,200));
  t('the model was offered Docs\' browser tools and every server tool, not Mail\'s',asked[0]?.tools.includes('list_files')&&asked[0].tools.includes('search_mail')&&!asked[0].tools.includes('open_mail_message'),JSON.stringify(asked[0]?.tools?.length));
  r=await api(A.token,'GET','/api/agent?scope=home');const items=r.j.items??[];
  t('the chat is listed afterwards under GET /api/agent?scope=',r.s===200&&items.some(i=>i.kind==='tool'&&i.name==='list_docs'&&i.status==='ok')&&items.some(i=>i.kind==='assistant'&&i.text.includes(AN)),r.s+' '+JSON.stringify(r.j).slice(0,160));
  r=await api(A.token,'GET',`/api/agent?scope=home&workspace=${W}`);t('the same chat from Mail\'s panel, with ?workspace= (one assistant per account)',r.s===200&&JSON.stringify(r.j.items)===JSON.stringify(items),r.s+' '+JSON.stringify(r.j).slice(0,120));
  tr=await turn(A.token,{message:'Hi from Mail',context:{page:'mail',accountId:'none',account:'dana@example.com',folder:'INBOX'},scope:'mail',workspace:W},`?workspace=${W}`);
  t('a Mail turn offers Mail\'s browser tools',tr.ev.at(-1)?.type==='done'&&asked.at(-1)?.tools.includes('open_mail_message')&&!asked.at(-1).tools.includes('list_files'),tr.x.slice(0,160));
  r=await api(A.token,'GET','/api/agent?scope=mail');t('Mail\'s chat is in the same assistant, beside Docs\'',(r.j.items??[])[0]?.text==='Hi from Mail',JSON.stringify(r.j).slice(0,140));
  tr=await turn(A.token,{message:'List my files',context:{page:'home'},workspace:W});const call=tr.ev.find(e=>e.type==='client_tools')?.calls?.[0];
  t('a browser tool pauses the turn',call?.name==='list_files'&&!tr.ev.some(e=>e.type==='done'),tr.x.slice(0,160));
  tr=await turn(A.token,{context:{page:'home'},workspace:W,toolResults:[{id:call?.id,content:'[{"filename":"hello.txt"}]'}]});
  t('and its result resumes it',tr.ev.some(e=>e.type==='text'&&e.text.includes('hello.txt'))&&tr.ev.at(-1)?.type==='done',tr.x.slice(0,160));
  r=await api(A.token,'GET','/api/settings/assistant');t('the assistant settings are the Assistant object\'s',r.s===200&&r.j.settings?.provider==='default',r.s+' '+JSON.stringify(r.j).slice(0,100));
  r=await api(Bo.token,'GET',`/api/agent?scope=home&workspace=${W}`);t('Eli\'s assistant in the organization is his own',r.s===200&&(r.j.items??[]).length===0,r.s+' '+JSON.stringify(r.j).slice(0,100));
  r=await api(A.token,'POST','/api/agent/jobs',{});t('the rest of /api/agent (the retired jobs) still goes to Docs, not the Assistant object',r.s!==404||r.j.error!=='Not found',r.s+' '+JSON.stringify(r.j).slice(0,100));
  fakeModel.close();
}
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
