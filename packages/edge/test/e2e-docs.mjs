// Against the rehearsal host instead: B=https://edge.freeflow.im, with LOG unused (sign-up mail is real there).
// End-to-end check of Docs through the Worker and an organization's Docs object, against a local `wrangler dev` started as
// test/e2e.mjs says (same port and log). It reads signup links from the Worker's log, because local mail goes there.
import fs from 'node:fs';
const log=process.argv[2]; const B='http://localhost:18796';
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
// PDF to Markdown, with pdf.js on the Worker (src/docs/runtime/pdfText.ts).
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
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
