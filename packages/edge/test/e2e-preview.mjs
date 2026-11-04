// End-to-end check of Mail's attachment previews in Docs (routes/previews.ts, docs/server/previews.ts) through the Worker,
// a person's Mail object and their organization's Docs object, against the GreenMail server in Docker (`flow-greenmail`:
// SMTP 127.0.0.1:3025, IMAP 127.0.0.1:3143, any password logs in) and a local `wrangler dev` with the clients assembled
// (scripts/assemble.mjs, after building packages/web, packages/docs with BASE_PATH=/workspace/ and packages/mail):
//   npx wrangler dev --port 18804 --local --enable-containers=false --var PORTED_HOSTS:edge.freeflow.im,localhost \
//     --var ASSET_HOSTS:localhost --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18804 \
//     --var FLOW_WEB_URL:http://localhost:18804 --var MAIL_ALLOW_INSECURE:1 > /tmp/edge-preview.log 2>&1 &
//   node test/e2e-preview.mjs /tmp/edge-preview.log
// It sends one message with a Word, Excel, PowerPoint, PDF, CSV, PNG and text attachment (made here), previews each Office
// and PDF one, saves one to Docs, and checks that another member of the organization cannot see the preview.
// It prints the sign-in token and the message, for the screenshots (B= for another port).
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import nodemailer from 'nodemailer';
import PptxGenJS from 'pptxgenjs';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18804';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const api=async(tok,m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':'application/json'}:{})},body:b===undefined?undefined:JSON.stringify(b)});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const MAIL_USER=process.env.MAIL_USER??`preview-${tag}@test.local`;

// ---- The attachments ------------------------------------------------------------------------------------------------
const W_NS='xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
async function docx(){const z=new JSZip();
  z.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  const p=(text,style)=>`<w:p>${style?`<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`:''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  z.file('word/document.xml',`<?xml version="1.0"?><w:document ${W_NS}><w:body>${p('Project Harbor plan','Title')}${p('Goals','Heading1')}${p('Ship the attachment preview to every FreeFlow Mail user this quarter.')}${p('Open Word, Excel and PowerPoint files without leaving the inbox.')}${p('Timeline','Heading1')}${p('Design in week one, build in weeks two and three, and roll out in week four.')}</w:body></w:document>`);
  z.file('word/styles.xml',`<?xml version="1.0"?><w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`);
  return z.generateAsync({type:'nodebuffer'});}
async function xlsx(){const wb=new ExcelJS.Workbook();const ws=wb.addWorksheet('Q3 Sales');ws.addRow(['Region','July','August','September','Total']);
  for(const [r,a,b,c] of [['North',1200,1350,1490],['South',980,1010,1200],['East',1500,1420,1610],['West',2010,2200,2390]]){const row=ws.addRow([r,a,b,c]);row.getCell(5).value={formula:`SUM(B${row.number}:D${row.number})`,result:a+b+c};}
  ws.getRow(1).font={bold:true};ws.columns.forEach(c=>c.width=14);wb.addWorksheet('Notes').addRow(['Figures in USD']);return Buffer.from(await wb.xlsx.writeBuffer());}
async function pptx(){const p=new PptxGenJS();let s=p.addSlide();s.addText('Harbor launch review',{x:0.5,y:1.5,w:9,h:1.2,fontSize:40,bold:true,color:'1A73E8'});s.addText('FreeFlow Mail · November 2026',{x:0.5,y:2.8,w:9,h:0.6,fontSize:20,color:'5F6368'});
  s=p.addSlide();s.addText('What ships',{x:0.5,y:0.4,w:9,h:0.8,fontSize:30,bold:true});s.addText([{text:'Attachment previews',options:{bullet:true}},{text:'Save to Docs',options:{bullet:true}},{text:'Read-only Office views',options:{bullet:true}}],{x:0.7,y:1.4,w:8.5,h:3,fontSize:22});
  return Buffer.from(await p.write({outputType:'nodebuffer'}));}
const pdf=fs.readFileSync(new URL('./fixtures/report.pdf',import.meta.url));
const csv=Buffer.from('name,team,score\nAnn,Harbor,92\nBo,Juniper,88\nCy,Harbor,95\n');
// A 120×80 PNG, a blue panel with a lighter band: made by hand (zlib from node).
import zlib from 'node:zlib';
function png(w=240,h=160){const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;for(let x=0;x<w;x++){const o=y*(w*4+1)+1+x*4;const band=y>h*0.4&&y<h*0.6;raw[o]=band?138:26;raw[o+1]=band?180:115;raw[o+2]=band?248:232;raw[o+3]=255;}}
  const crc=(buf)=>{let c,crcTable=[];for(let n=0;n<256;n++){c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcTable[n]=c>>>0;}let x=0xffffffff;for(const b of buf)x=crcTable[(x^b)&0xff]^(x>>>8);return (x^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([len,td,c]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;ihdr[10]=0;ihdr[11]=0;ihdr[12]=0;
  return Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const txt=Buffer.from('Meeting notes\n=============\n\n- Previews open in an overlay\n- Esc closes it\n- Arrow keys step through the attachments\n');
const FILES=[
  {filename:'Harbor plan.docx',content:await docx(),contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'},
  {filename:'Q3 sales.xlsx',content:await xlsx(),contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
  {filename:'Launch review.pptx',content:await pptx(),contentType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'},
  {filename:'Quarterly report.pdf',content:pdf,contentType:'application/pdf'},
  {filename:'scores.csv',content:csv,contentType:'text/csv'},
  {filename:'banner.png',content:png(),contentType:'image/png'},
  {filename:'notes.txt',content:txt,contentType:'text/plain'},
];

// ---- People, organization, mail account -----------------------------------------------------------------------------
const A=await signup(`ann-${tag}@example.com`,'Ann'),Bo=await signup(`bo-${tag}@example.com`,'Bo');
t('sign up',A.token&&Bo.token);
let r=await api(A.token,'POST','/v1/workspaces',{name:'Harbor',slug:`harbor-${tag}`});const W=r.j.id;t('an organization',!!W,JSON.stringify(r.j).slice(0,100));
r=await api(A.token,'POST',`/v1/workspaces/${W}/invites`,{email:`bo-${tag}@example.com`});const tok=(r.j.inviteUrl??'').split('/').pop();
r=await api(Bo.token,'POST','/v1/invites/accept',{token:tok});t('Bo joins it',r.s<300,r.s+' '+JSON.stringify(r.j).slice(0,100));
const server=(port)=>({host:'127.0.0.1',port,security:'none'});
r=await api(A.token,'POST','/v1/mail/accounts',{email:MAIL_USER,displayName:'Ann',password:'x',imap:server(3143),smtp:server(3025)});
const ACC=r.j.account?.id;t('add the GreenMail account',r.s===201&&!!ACC,r.s+' '+JSON.stringify(r.j).slice(0,120));

const SUBJECT=`Harbor launch files ${tag}`;
await nodemailer.createTransport({host:'127.0.0.1',port:3025,secure:false,ignoreTLS:true,auth:{user:MAIL_USER,pass:'x'}}).sendMail({
  from:'"Priya Shah" <priya@harbor.test>',to:MAIL_USER,subject:SUBJECT,text:'Hi Ann,\n\nHere are the files for the Harbor launch review: the plan, the Q3 numbers, the deck, the report, the scores, the banner and my notes.\n\nPriya',
  attachments:FILES.map(f=>({filename:f.filename,content:f.content,contentType:f.contentType})),
});
let mine;for(let i=0;i<30&&!mine;i++){r=await api(A.token,'GET',`/v1/mail/accounts/${ACC}/messages?folder=INBOX&limit=20`);mine=r.j.messages?.find(m=>m.subject===SUBJECT);if(!mine)await sleep(300);}
t('the message arrives',!!mine,JSON.stringify(r.j).slice(0,140));
const UID=mine?.uid;
r=await api(A.token,'GET',`/v1/mail/accounts/${ACC}/messages/${UID}?folder=INBOX`);
const atts=r.j.message?.attachments??[];
t('with its seven attachments',atts.length===7&&FILES.every((f,i)=>atts[i]?.filename===f.filename),JSON.stringify(atts.map(a=>a.filename)));
const indexOf=(name)=>atts.find(a=>a.filename===name)?.index;

// ---- Previews -----------------------------------------------------------------------------------------------------
const preview=(tok,name,extra={})=>api(tok,'POST','/api/previews/mail',{account:ACC,folder:'INBOX',uid:UID,index:indexOf(name),workspace:W,...extra});
const made={};
for(const [name,kind] of [['Harbor plan.docx','doc'],['Q3 sales.xlsx','sheet'],['Launch review.pptx','deck'],['Quarterly report.pdf','pdf'],['scores.csv','sheet']]){
  r=await preview(A.token,name);made[name]=r.j.preview?.id;
  t(`preview ${name}`,r.s===200&&r.j.preview?.kind===kind&&r.j.workspace===W&&r.j.preview.filename===name,r.s+' '+JSON.stringify(r.j).slice(0,160));
}
r=await preview(A.token,'Harbor plan.docx');t('the same attachment again reuses its preview',r.j.preview?.id===made['Harbor plan.docx'],JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST','/api/previews/mail',{account:ACC,folder:'INBOX',uid:UID,index:indexOf('Harbor plan.docx')});
t('with no organization named, the first one is used',r.s===200&&r.j.workspace===W&&r.j.preview?.id===made['Harbor plan.docx'],JSON.stringify(r.j).slice(0,140));

const view=async(name)=>(await api(A.token,'GET',`/api/previews/${made[name]}?workspace=${W}`));
r=await view('Harbor plan.docx');t('the document converted, read-only',r.s===200&&r.j.view?.kind==='doc'&&JSON.stringify(r.j.view.doc).includes('Ship the attachment preview')&&r.h.get('cache-control')==='no-store',r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await view('Q3 sales.xlsx');t('the workbook, with both tabs',r.j.view?.kind==='sheet'&&r.j.view.workbook.tabs.map(x=>x.name).join()==='Q3 Sales,Notes'&&r.j.view.workbook.tabs[0].cells.A2?.v==='North',JSON.stringify(r.j.view?.workbook?.tabs?.map(x=>x.name)));
r=await view('Launch review.pptx');t('the presentation, with both slides',r.j.view?.kind==='deck'&&r.j.view.deck.slides.length===2&&JSON.stringify(r.j.view.deck).includes('Harbor launch review'),JSON.stringify(r.j).slice(0,140));
r=await view('scores.csv');t('the CSV as a sheet',r.j.view?.kind==='sheet'&&r.j.view.workbook.tabs[0].cells.A2?.v==='Ann',JSON.stringify(r.j).slice(0,140));
r=await view('Quarterly report.pdf');t('the PDF, for pdf.js',r.j.view?.kind==='pdf'&&r.j.view.url===`/api/previews/${made['Quarterly report.pdf']}/file`,JSON.stringify(r.j).slice(0,140));
let res=await fetch(`${B}${r.j.view?.url}?workspace=${W}`,{headers:{authorization:'Bearer '+A.token}});let bytes=Buffer.from(await res.arrayBuffer());
t('its bytes, as a download that runs nothing',res.status===200&&bytes.equals(pdf)&&res.headers.get('content-type')==='application/pdf'&&res.headers.get('content-security-policy')?.includes('sandbox')&&res.headers.get('x-content-type-options')==='nosniff',res.status+' '+res.headers.get('content-type'));
res=await fetch(`${B}/workspace/preview/${made['Harbor plan.docx']}?workspace=${W}`,{headers:{authorization:'Bearer '+A.token}});const page=await res.text();
t('the preview page is Docs’ page, framed only by the suite',res.status===200&&page.includes('<div id="root">')&&res.headers.get('x-frame-options')==='SAMEORIGIN'&&res.headers.get('content-security-policy')==="frame-ancestors 'self'",res.status+' '+res.headers.get('x-frame-options'));

// ---- Owner only -----------------------------------------------------------------------------------------------------
for(const name of ['Harbor plan.docx','Quarterly report.pdf']){
  r=await api(Bo.token,'GET',`/api/previews/${made[name]}?workspace=${W}`);t(`another member gets 404 for ${name}`,r.s===404,r.s+' '+JSON.stringify(r.j).slice(0,100));
}
res=await fetch(`${B}/api/previews/${made['Quarterly report.pdf']}/file?workspace=${W}`,{headers:{authorization:'Bearer '+Bo.token}});t('and for its bytes',res.status===404,res.status);
r=await api(Bo.token,'POST',`/api/previews/${made['Harbor plan.docx']}/save?workspace=${W}`);t('and cannot save it',r.s===404,r.s);
r=await api(Bo.token,'POST','/api/previews/mail',{account:ACC,folder:'INBOX',uid:UID,index:0,workspace:W});t('nor preview Ann’s mail',r.s===404,r.s+' '+JSON.stringify(r.j).slice(0,100));
r=await api(null,'GET',`/api/previews/${made['Harbor plan.docx']}?workspace=${W}`);t('nor can a stranger',r.s===401,r.s);
r=await api(A.token,'GET',`/api/library?workspace=${W}`);t('previews are not in the library',r.s===200&&!JSON.stringify(r.j).includes('Harbor plan'),JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'GET',`/api/recents?workspace=${W}`);t('nor in Recents',r.s===200&&!JSON.stringify(r.j).includes('Harbor plan'),JSON.stringify(r.j).slice(0,140));

// ---- Save to Docs ---------------------------------------------------------------------------------------------------
r=await api(A.token,'POST',`/api/previews/${made['Q3 sales.xlsx']}/save?workspace=${W}`);const saved=r.j.saved;
t('save the workbook to Docs',r.s===200&&saved?.kind==='sheet'&&saved.url===`/workspace/s/${saved.id}`&&saved.title==='Q3 sales',r.s+' '+JSON.stringify(r.j).slice(0,160));
r=await api(A.token,'GET',`/api/library?workspace=${W}`);const sheet=r.j.docs?.find(s=>s.id===saved?.id);
t('it is at the top of My files',!!sheet&&!sheet.folder&&!sheet.shared,JSON.stringify(r.j.docs?.map(s=>[s.title,s.folder??'',s.shared??false])));
r=await api(A.token,'GET',`/api/sheets/${saved?.id}`);t('and opens as a spreadsheet',r.s===200&&r.j.workbook?.tabs?.[0]?.name==='Q3 Sales',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST',`/api/previews/${made['Q3 sales.xlsx']}/save?workspace=${W}`);t('saving again gives the same file',r.j.saved?.id===saved?.id,JSON.stringify(r.j).slice(0,120));
r=await preview(A.token,'Q3 sales.xlsx');t('and the preview says it was saved',r.j.preview?.saved?.id===saved?.id,JSON.stringify(r.j).slice(0,160));
r=await api(Bo.token,'GET',`/api/sheets/${saved?.id}`);t('the saved file is private to Ann',r.s===404||r.s===403,r.s);

// ---- Refusals ------------------------------------------------------------------------------------------------------
r=await preview(A.token,'banner.png');t('a picture makes a preview only to be saved',r.s===200&&r.j.preview?.kind==='file',JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST',`/api/previews/${r.j.preview?.id}/save?workspace=${W}`);t('and saves as a stored file',r.s===200&&r.j.saved?.kind==='file'&&r.j.saved.url.startsWith('/workspace/f/'),JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'POST','/api/previews/mail',{account:ACC,folder:'INBOX',uid:UID,index:42,workspace:W});t('a missing attachment is a 404 with a reason',r.s===404&&typeof r.j.error==='string',r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'POST','/api/previews/mail',{account:ACC,folder:'INBOX',uid:UID,index:0,workspace:'not-mine'});t('an organization one is not in is refused',r.s===403,r.s+' '+JSON.stringify(r.j));

console.log(JSON.stringify({token:A.token,account:ACC,uid:UID,workspace:W,mailUser:MAIL_USER}));
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
