// End-to-end check of FreeFlow Mail (/v1/mail/*, src/imap/object.ts) through the Worker and a person's Mail object, against
// the GreenMail server in Docker (`flow-greenmail`: SMTP 127.0.0.1:3025, IMAP 127.0.0.1:3143, any password logs in) and a
// local `wrangler dev` started as test/e2e.mjs says, on port 18798 (B= for another) and with mail's insecure dev mode on:
//   npx wrangler dev --port 18798 --local --enable-containers=false --var PORTED_HOSTS:edge.freeflow.im,localhost \
//     --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18798 \
//     --var MAIL_ALLOW_INSECURE:1 > /tmp/edge-mail.log 2>&1 &
//   node test/e2e-mail.mjs /tmp/edge-mail.log
// (B=http://localhost:<port> points it at another port.) The inbox tabs part sends mail with marketing, social, GitHub,
// shipping and Google Groups headers straight to GreenMail's SMTP, as those senders would.
// It reads signup links from the Worker's log, because local mail goes there. MAIL_USER picks the GreenMail address.
import fs from 'node:fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import PostalMime from 'postal-mime';
const log=process.argv[2]; const B=process.env.B??'http://localhost:18798';
const MAIL_USER=process.env.MAIL_USER??'ann@test.local';
let pass=0,fail=0; const t=(n,ok,d='')=>{ok?pass++:fail++;console.log((ok?'ok  ':'FAIL')+' '+n+(d?': '+String(d).slice(0,170):''));};
const api=async(tok,m,p,b)=>{const r=await fetch(B+p,{method:m,headers:{...(tok?{authorization:'Bearer '+tok}:{}),...(b!==undefined?{'content-type':'application/json'}:{})},body:b===undefined?undefined:JSON.stringify(b)});const x=await r.text();let j;try{j=JSON.parse(x)}catch{j=x}return{s:r.status,j,h:r.headers}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function signup(email,name){await api(null,'POST','/v1/auth/register',{email});await sleep(400);const m=[...fs.readFileSync(log,'utf8').matchAll(new RegExp('to='+email+'.*?signup=([A-Za-z0-9_-]+)','g'))].at(-1);return (await api(null,'POST','/v1/auth/register/complete',{token:m[1],displayName:name,password:'correct-horse-battery'})).j;}
const tag=Date.now().toString(36);
const A=await signup(`mail-${tag}@example.com`,'Ann'),Bo=await signup(`other-${tag}@example.com`,'Bo');
t('sign up',A.token&&Bo.token);
const server=(port)=>({host:'127.0.0.1',port,security:'none'});
const imapDirect=async(fn)=>{const c=new ImapFlow({host:'127.0.0.1',port:3143,secure:false,doSTARTTLS:false,auth:{user:MAIL_USER,pass:'x'},logger:false});await c.connect();try{return await fn(c)}finally{await c.logout()}};

let r=await api(null,'GET','/v1/mail/accounts');t('no session refused',r.s===401,r.s);
r=await api(A.token,'GET','/v1/mail/providers?email=someone@gmail.com');t('a Gmail preset',r.s===200&&r.j?.name==='Gmail'&&r.j.imap.host==='imap.gmail.com'&&r.j.smtp.port===465&&r.j.imap.username==='someone@gmail.com',JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'GET','/v1/mail/providers?email=me@example.com');t('no preset for an unknown domain',r.s===200&&r.j===null,JSON.stringify(r.j));
r=await api(A.token,'GET','/v1/mail/accounts');t('no accounts yet',r.s===200&&r.j.accounts?.length===0,JSON.stringify(r.j));

r=await api(A.token,'POST','/v1/mail/accounts',{email:MAIL_USER,displayName:'Ann',password:'x',imap:server(3999),smtp:server(3025)});
t('an IMAP server that is not there is connect_failed, 422',r.s===422&&r.j.error?.code==='connect_failed',r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'POST','/v1/mail/accounts',{email:MAIL_USER,displayName:'Ann',password:'x',imap:server(3143)});
t('a body missing smtp is bad_request',r.s===400&&r.j.error?.code==='bad_request',r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'POST','/v1/mail/accounts',{email:MAIL_USER,displayName:'Ann',password:'s3cret-pw',imap:server(3143),smtp:server(3025)});
t('add the GreenMail account',r.s===201&&r.j.account?.id&&r.j.account.status==='ok',r.s+' '+JSON.stringify(r.j).slice(0,160));
const ACC=r.j.account?.id; const P=`/v1/mail/accounts/${ACC}`;
t('the password is never returned',!JSON.stringify(r.j).includes('s3cret-pw')&&!('password' in (r.j.account??{})));
r=await api(A.token,'GET','/v1/mail/accounts');t('list accounts',r.j.accounts?.length===1&&r.j.accounts[0].email===MAIL_USER&&r.j.accounts[0].imap.port===3143&&!JSON.stringify(r.j).includes('s3cret-pw'),JSON.stringify(r.j).slice(0,160));
r=await api(Bo.token,'GET',`${P}/folders`);t("someone else cannot use the account",r.s===404,r.s);
r=await api(Bo.token,'GET','/v1/mail/accounts');t("nor see it",r.j.accounts?.length===0,JSON.stringify(r.j));

const MOVED=`Moved-${tag}`;
await imapDirect(async(c)=>{await c.mailboxCreate(MOVED);await c.mailboxCreate('Trash').catch(()=>{});});
r=await api(A.token,'GET',`${P}/folders`);
t('folders, INBOX first',r.s===200&&r.j.folders?.[0]?.path==='INBOX'&&r.j.folders[0].specialUse==='inbox'&&typeof r.j.folders[0].unread==='number',r.s+' '+JSON.stringify(r.j).slice(0,160));
t('Trash is known as trash, and the new folder is listed',r.j.folders?.some(f=>f.path==='Trash'&&f.specialUse==='trash')&&r.j.folders?.some(f=>f.path===MOVED&&f.specialUse===null),JSON.stringify(r.j.folders?.map(f=>f.path+':'+f.specialUse)));

const SUBJECT=`Quarterly numbers ${tag}`;
const attachment=Buffer.from(`col,val\nq3,${tag}\n`);
r=await api(A.token,'POST',`${P}/send`,{to:[{name:'Ann',address:MAIL_USER}],subject:SUBJECT,html:`<p>Hello <b>Ann</b>, the numbers for ${tag} are attached.</p>`,text:`Hello Ann, the numbers for ${tag} are attached.`,attachments:[{filename:'numbers.csv',contentType:'text/csv',contentBase64:attachment.toString('base64')}]});
t('send a message to itself with an attachment',r.s===200&&r.j.ok&&/^<.+@.+>$/.test(r.j.messageId),r.s+' '+JSON.stringify(r.j).slice(0,140));
const SENT_ID=r.j.messageId;
let mine;for(let i=0;i<20&&!mine;i++){r=await api(A.token,'GET',`${P}/messages?folder=INBOX&limit=20`);mine=r.j.messages?.find(m=>m.subject===SUBJECT);if(!mine)await sleep(300);}
t('it arrives in INBOX, newest first',!!mine&&r.j.messages[0].uid>=r.j.messages.at(-1).uid,JSON.stringify(r.j).slice(0,160));
t('its summary',mine&&mine.from?.address===MAIL_USER&&mine.to?.[0]?.address===MAIL_USER&&mine.hasAttachments===true&&mine.seen===false&&mine.messageId===SENT_ID&&!isNaN(Date.parse(mine.date))&&mine.size>0,JSON.stringify(mine).slice(0,170));
t('with a snippet',mine?.snippet?.startsWith('Hello Ann, the numbers'),mine?.snippet);
const UID=mine?.uid;

r=await api(A.token,'GET',`${P}/messages?folder=INBOX&q=${encodeURIComponent(tag)}`);t('search finds it',r.s===200&&r.j.messages?.some(m=>m.uid===UID),r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&q=nothing-matches-${tag}-zzz`);t('search finds nothing for nonsense',r.s===200&&r.j.messages?.length===0&&r.j.next===null,JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&limit=1`);
if(r.j.next){const older=await api(A.token,'GET',`${P}/messages?folder=INBOX&limit=1&before=${r.j.next}`);t('pages older with before',older.s===200&&older.j.messages?.[0]?.uid<r.j.messages[0].uid,JSON.stringify(older.j).slice(0,120));}
else t('one message, no next page',r.j.messages?.length===1);

r=await api(A.token,'GET',`${P}/messages/${UID}?folder=INBOX`);const D=r.j.message;
t('read it in full',r.s===200&&D?.html?.includes('<b>Ann</b>')&&D.text?.includes('attached')&&D.attachments?.[0]?.filename==='numbers.csv'&&D.attachments[0].size===attachment.length&&D.attachments[0].inline===false,r.s+' '+JSON.stringify(r.j).slice(0,170));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&q=${encodeURIComponent(tag)}`);t('reading does not mark it seen',r.j.messages?.find(m=>m.uid===UID)?.seen===false);
let res=await fetch(B+`${P}/messages/${UID}/attachments/0?folder=INBOX`,{headers:{authorization:'Bearer '+A.token}});let bytes=Buffer.from(await res.arrayBuffer());
t('download the attachment',res.status===200&&bytes.equals(attachment)&&/^attachment;.*filename\*=UTF-8''numbers\.csv/.test(res.headers.get('content-disposition')??'')&&res.headers.get('content-type')?.startsWith('text/csv'),res.status+' '+res.headers.get('content-disposition'));
res=await fetch(B+`${P}/messages/${UID}/attachments/0?folder=INBOX&inline=1`,{headers:{authorization:'Bearer '+A.token}});
t('a non-image is never served inline',res.status===200&&res.headers.get('content-disposition')?.startsWith('attachment')&&res.headers.get('content-security-policy')?.includes('sandbox'),res.headers.get('content-disposition'));
r=await api(A.token,'GET',`${P}/messages/${UID}/attachments/5?folder=INBOX`);t('a missing attachment is not_found',r.s===404&&r.j.error?.code==='not_found',r.s);
r=await api(A.token,'GET',`${P}/messages/999999?folder=INBOX`);t('a missing message is not_found',r.s===404&&r.j.error?.code==='not_found',r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'GET',`${P}/messages?folder=${encodeURIComponent('No such '+tag)}`);t('a missing folder is not_found',r.s===404&&r.j.error?.code==='not_found',r.s+' '+JSON.stringify(r.j).slice(0,120));

r=await api(A.token,'PATCH',`${P}/messages`,{folder:'INBOX',uids:[UID],seen:true,flagged:true});t('mark seen and flagged',r.s===200&&r.j.ok,r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&q=${encodeURIComponent(tag)}`);const m2=r.j.messages?.find(m=>m.uid===UID);t('the flags stuck',m2?.seen===true&&m2?.flagged===true,JSON.stringify(m2).slice(0,120));

r=await api(A.token,'POST',`${P}/send`,{to:[{name:'Ann',address:MAIL_USER}],subject:'Re: '+SUBJECT,html:'<p>Thanks!</p>',inReplyTo:SENT_ID,references:[SENT_ID]});
t('reply to it',r.s===200&&r.j.ok,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&q=${encodeURIComponent(tag)}`);t('the original is marked answered',r.j.messages?.find(m=>m.uid===UID)?.answered===true,JSON.stringify(r.j.messages?.map(m=>[m.uid,m.answered])));
r=await api(A.token,'GET',`${P}/messages?folder=Sent&q=${encodeURIComponent(tag)}`);t('copies of both are in Sent',r.s===200&&r.j.messages?.length===2&&r.j.messages.every(m=>m.seen),r.s+' '+JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&q=${encodeURIComponent('Re: '+SUBJECT)}`);const reply=r.j.messages?.find(m=>m.subject==='Re: '+SUBJECT);
if(reply){const d=(await api(A.token,'GET',`${P}/messages/${reply.uid}?folder=INBOX`)).j.message;t('the reply carries In-Reply-To and References',d?.inReplyTo===SENT_ID&&d?.references?.includes(SENT_ID),JSON.stringify({i:d?.inReplyTo,r:d?.references}));}
else t('the reply arrived',false);

r=await api(A.token,'POST',`${P}/messages/move`,{folder:'INBOX',uids:[UID],to:MOVED});t('move it to another folder',r.s===200&&r.j.ok,r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&q=${encodeURIComponent(SUBJECT)}`);t('gone from INBOX',r.j.messages?.every(m=>m.subject!==SUBJECT),JSON.stringify(r.j.messages?.map(m=>m.subject)));
r=await api(A.token,'GET',`${P}/messages?folder=${encodeURIComponent(MOVED)}`);const moved=r.j.messages?.find(m=>m.subject===SUBJECT);t('and in the new folder, still flagged',!!moved&&moved.flagged,JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'POST',`${P}/messages/move`,{folder:MOVED,uids:[moved?.uid??1],to:`Nowhere-${tag}`});t('moving to a folder that does not exist fails',r.s===404||r.s===400,r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST',`${P}/messages/delete`,{folder:MOVED,uids:[moved?.uid]});t('delete it',r.s===200&&r.j.ok,r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'GET',`${P}/messages?folder=${encodeURIComponent(MOVED)}`);t('the folder is empty',r.s===200&&r.j.messages?.length===0,JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET',`${P}/messages?folder=Trash&q=${encodeURIComponent(SUBJECT)}`);const trashed=r.j.messages?.find(m=>m.subject===SUBJECT);t('it went to Trash',!!trashed,JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'POST',`${P}/messages/delete`,{folder:'Trash',uids:[trashed?.uid]});
r=await api(A.token,'GET',`${P}/messages?folder=Trash&q=${encodeURIComponent(SUBJECT)}`);t('deleting it in Trash removes it for good',r.s===200&&!r.j.messages?.some(m=>m.subject===SUBJECT),JSON.stringify(r.j).slice(0,120));
// Tidy the reply too, so INBOX does not grow run after run.
if(reply)await api(A.token,'POST',`${P}/messages/delete`,{folder:'INBOX',uids:[reply.uid]});

// ---- Inbox tabs ---------------------------------------------------------------------------------------------------
const smtpDirect=nodemailer.createTransport({host:'127.0.0.1',port:3025,secure:false,ignoreTLS:true,auth:{user:MAIL_USER,pass:'x'}});
const deliver=(from,subject,headers={})=>smtpDirect.sendMail({from,to:MAIL_USER,subject:`${subject} ${tag}`,text:`${subject}.`,headers});
const KINDS={
  promotions:['"The Outdoor Shop" <hello@outdoorshop.com>','20% off everything',{'List-Unsubscribe':'<https://outdoorshop.us5.list-manage.com/unsubscribe?u=abc>','List-Id':'Outdoor Shop <abc.list-id.mcsv.net>','X-MC-User':'abc123','X-Campaign':'mailchimpabc.9f8e7d','Precedence':'bulk'}],
  social:['Priya Shah via LinkedIn <invitations@linkedin.com>','Priya Shah wants to connect',{'X-LinkedIn-Class':'INVITE-GUEST','List-Unsubscribe':'<https://www.linkedin.com/e/unsub>'}],
  updates:['Chen Wei <notifications@github.com>','Re: [acme/web] Fix flaky upload test (PR #812)',{'X-GitHub-Reason':'review_requested','List-ID':'acme/web <web.acme.github.com>','Precedence':'list'}],
  updates2:['"Amazon.com" <shipment-tracking@amazon.com>','Your Amazon.com order has shipped',{'X-SES-Outgoing':'2026.11.03-54.240.8.97','Feedback-ID':'1.us-east-1.abc=:AmazonSES'}],
  forums:['Sam Rivera <sam@rivera.dev>','[rust-embedded] HAL traits for async SPI',{'List-Id':'<rust-embedded.googlegroups.com>','List-Post':'<mailto:rust-embedded@googlegroups.com>','X-Google-Group-Id':'123456789012','Precedence':'list'}],
  primary:['Bob Martin <bob@acme.test>','Lunch on Thursday?',{}],
};
for(const [from,subject,headers] of Object.values(KINDS))await deliver(from,subject,headers);
const tagged=(list)=>(list??[]).filter(m=>m.subject.endsWith(tag));
const subj=(k)=>`${KINDS[k][1]} ${tag}`;
let inbox;for(let i=0;i<20;i++){r=await api(A.token,'GET',`${P}/messages?folder=INBOX&limit=50`);inbox=tagged(r.j.messages);if(inbox.length>=6)break;await sleep(300);}
t('tabs: the six messages arrive',inbox.length>=6,inbox.length);
t('tabs: off by default, and no category on summaries',r.j.messages?.every(m=>!('category' in m)),JSON.stringify(r.j.messages?.[0]).slice(0,120));
r=await api(A.token,'PATCH',P,{tabs:['forums','promotions','social','updates','social']});
t('tabs: switch them on (stored once each, in order, without signing in again)',r.s===200&&JSON.stringify(r.j.account?.tabs)==='["promotions","social","updates","forums"]'&&r.j.account.status==='ok',JSON.stringify(r.j).slice(0,200));
r=await api(A.token,'GET','/v1/mail/accounts');t('tabs: listed with the account',JSON.stringify(r.j.accounts?.[0]?.tabs)==='["promotions","social","updates","forums"]',JSON.stringify(r.j.accounts?.[0]?.tabs));
r=await api(A.token,'PATCH',P,{tabs:['spam']});t('tabs: an unknown tab is bad_request',r.s===400&&r.j.error?.code==='bad_request',r.s);
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=nope`);t('tabs: an unknown category is bad_request',r.s===400,r.s);


const lists={};for(const cat of ['primary','promotions','social','updates','forums']){r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=${cat}&limit=50`);lists[cat]=r.j;}
const has2=(j,k)=>tagged(j?.messages).some(m=>m.subject===subj(k));
const has=(cat,k)=>tagged(lists[cat]?.messages).some(m=>m.subject===subj(k));
t('tabs: the Mailchimp newsletter is in Promotions',has('promotions','promotions')&&!has('primary','promotions'),JSON.stringify(tagged(lists.promotions?.messages).map(m=>m.subject)));
t('tabs: the LinkedIn invitation is in Social',has('social','social')&&!has('primary','social'));
t('tabs: the GitHub notification and the shipping notice are in Updates',has('updates','updates')&&has('updates','updates2'),JSON.stringify(tagged(lists.updates?.messages).map(m=>m.subject)));
t('tabs: the Google Groups thread is in Forums',has('forums','forums'));
t("tabs: a colleague's mail is in Primary, and only there",has('primary','primary')&&!['promotions','social','updates','forums'].some(c=>has(c,'primary')),JSON.stringify(tagged(lists.primary?.messages).map(m=>m.subject)));
t('tabs: a tab list says its category on each summary',['primary','promotions','social','updates','forums'].every(c=>lists[c]?.messages?.every(m=>m.category===c)));
t('tabs: each tab list is newest first',['primary','updates'].every(c=>{const u=lists[c]?.messages?.map(m=>m.uid)??[];return u.every((x,i)=>!i||u[i-1]>x);}));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&limit=50`);const byS=Object.fromEntries(tagged(r.j.messages).map(m=>[m.subject,m.category]));
t('tabs: the whole INBOX carries each message\'s tab',byS[subj('promotions')]==='promotions'&&byS[subj('social')]==='social'&&byS[subj('updates')]==='updates'&&byS[subj('forums')]==='forums'&&byS[subj('primary')]==='primary',JSON.stringify(byS).slice(0,200));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=updates&limit=1`);t('tabs: a tab pages with next',r.s===200&&r.j.messages?.length===1&&r.j.next!==null,JSON.stringify(r.j).slice(0,140));
if(r.j.next){const more=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=updates&limit=1&before=${r.j.next}`);t('tabs: and the next page is older, in the same tab',more.j.messages?.[0]?.uid<r.j.messages[0].uid&&more.j.messages[0].category==='updates',JSON.stringify(more.j).slice(0,140));}
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=promotions&q=${encodeURIComponent('Lunch on Thursday? '+tag)}`);t('tabs: a search covers the whole folder, whatever the tab',r.j.messages?.some(m=>m.subject===subj('primary')),JSON.stringify(r.j).slice(0,140));

const social=tagged(lists.social?.messages).find(m=>m.subject===subj('social'));
r=await api(A.token,'POST',`${P}/messages/category`,{folder:'INBOX',uids:[social?.uid],category:'primary'});
t('tabs: move the LinkedIn message to Primary',r.s===200&&r.j.ok&&JSON.stringify(r.j.senders)==='["invitations@linkedin.com"]'&&r.j.previous?.[0]?.category===null,r.s+' '+JSON.stringify(r.j));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=primary&limit=50`);t('tabs: it is in Primary now',tagged(r.j.messages).some(m=>m.uid===social?.uid&&m.category==='primary'));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=social&limit=50`);t('tabs: and not in Social',!tagged(r.j.messages).some(m=>m.uid===social?.uid));
await deliver(KINDS.social[0],'Priya Shah endorsed you',KINDS.social[2]);
let later;for(let i=0;i<20&&!later;i++){r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=primary&limit=50`);later=r.j.messages?.find(m=>m.subject===`Priya Shah endorsed you ${tag}`);if(!later)await sleep(300);}
t('tabs: a later message from that sender lands in Primary',!!later&&later.category==='primary',JSON.stringify(later).slice(0,140));
r=await api(A.token,'POST',`${P}/senders/category`,{senders:[{address:'invitations@linkedin.com',category:null}]});t('tabs: undo the move',r.s===200&&r.j.ok,r.s);
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=social&limit=50`);t('tabs: and both are back in Social',tagged(r.j.messages).filter(m=>/Priya Shah/.test(m.subject)).length===2,JSON.stringify(tagged(r.j.messages).map(m=>m.subject)));
r=await api(A.token,'POST',`${P}/messages/category`,{folder:'Trash',uids:[1],category:'primary'});t('tabs: moving to a tab is only for INBOX',r.s===400,r.s);
r=await api(A.token,'POST',`${P}/messages/category`,{folder:'INBOX',uids:[social?.uid],category:'spam'});t('tabs: an unknown tab is refused',r.s===400,r.s);

r=await api(A.token,'PATCH',P,{tabs:['promotions']});
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=primary&limit=50`);t('tabs: with only Promotions on, the other tabs\' mail is in Primary',has2(r.j,'social')&&has2(r.j,'forums')&&has2(r.j,'updates')&&!has2(r.j,'promotions'),JSON.stringify(tagged(r.j.messages).map(m=>m.subject)));
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=social&limit=50`);t('tabs: and a tab that is off is empty',r.s===200&&r.j.messages?.length===0&&r.j.next===null,JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'PATCH',P,{tabs:[]});t('tabs: switch them off',r.s===200&&r.j.account?.tabs?.length===0);
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&limit=50`);t('tabs: off, the INBOX list has no categories',tagged(r.j.messages).length>=7&&r.j.messages.every(m=>!('category' in m)),tagged(r.j.messages).length);
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=promotions&limit=50`);t('tabs: off, category is ignored and everything is in INBOX',tagged(r.j.messages).length>=7&&r.j.messages.every(m=>!('category' in m)),tagged(r.j.messages).length);
// ---- Opening a message by its parts ---------------------------------------------------------------------------------
// The server fetches the structure, then only the text parts (and inline pictures, small parts); each answer must be what
// postal-mime makes of the whole message, which is what it answered before.
const CRLF='\r\n';
const b64=(buf)=>Buffer.from(buf).toString('base64').replace(/(.{76})/g,'$1\r\n');
const PNG=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000'+'1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082','hex');
const PDF=Buffer.concat([Buffer.from('%PDF-1.4\n'),Buffer.alloc(40000,0x41)]);
const RAWS={
  alt:['From: Bob Martin <bob@acme.test>',`To: ${MAIL_USER}`,'Reply-To: Team <team@acme.test>','In-Reply-To: <q2@acme.test>','References: <q1@acme.test> <q2@acme.test>',`Subject: Parts alt ${tag}`,'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="mix"','',
    '--mix','Content-Type: multipart/related; boundary="rel"','','--rel','Content-Type: multipart/alternative; boundary="alt"','',
    '--alt','Content-Type: text/plain; charset=utf-8','Content-Transfer-Encoding: quoted-printable','','Caf=C3=A9 numbers for '+tag+' are attached; a long line that wraps =','softly here.','',
    '--alt','Content-Type: text/html; charset=utf-8','Content-Transfer-Encoding: base64','',b64(`<p>Café numbers for ${tag}: <img src="cid:chart-${tag}@acme"></p>`),'--alt--','',
    '--rel','Content-Type: image/png; name="chart.png"','Content-Transfer-Encoding: base64',`Content-ID: <chart-${tag}@acme>`,'Content-Disposition: inline; filename="chart.png"','',b64(PNG),'--rel--','',
    '--mix','Content-Type: application/pdf; name="q3.pdf"','Content-Transfer-Encoding: base64','Content-Disposition: attachment; filename="q3.pdf"','',b64(PDF),'--mix--',''].join(CRLF),
  plain:['From: Ann <ann@acme.test>',`Subject: Parts plain ${tag}`,'Content-Type: text/plain; charset=us-ascii','','Just text,','two lines.',''].join(CRLF),
  charsets:['From: Jens <jens@koeln.test>',`Subject: Parts charsets ${tag}`,'MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="b"','',
    '--b','Content-Type: text/plain; charset=iso-8859-1','Content-Transfer-Encoding: quoted-printable','','Gr=FC=DFe aus K=F6ln','',
    '--b','Content-Type: text/html; charset=windows-1251','Content-Transfer-Encoding: base64','',b64(Buffer.from([0x3c,0x70,0x3e,0xcf,0xf0,0xe8,0xe2,0xe5,0xf2,0x3c,0x2f,0x70,0x3e])),'--b--',''].join(CRLF),
  // An inline forwarded message: postal-mime folds its text and attachments into the message's own, so it is read whole.
  forwarded:['From: Cy <cy@acme.test>',`Subject: Parts forwarded ${tag}`,'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="f"','',
    '--f','Content-Type: text/plain; charset=utf-8','','See below.','','--f','Content-Type: message/rfc822','',
    'From: Dee <dee@acme.test>','Subject: The original','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="g"','',
    '--g','Content-Type: text/plain; charset=utf-8','','Original text.','','--g','Content-Type: text/csv; name="a.csv"','Content-Disposition: attachment; filename="a.csv"','','x,y','1,2','--g--','','--f--',''].join(CRLF),
  koi8:['From: Ivan <ivan@example.ru>',`Subject: Parts koi8 ${tag}`,'Content-Type: text/plain; charset=koi8-r','Content-Transfer-Encoding: 8bit','',Buffer.from([0xf0,0xd2,0xc9,0xd7,0xc5,0xd4]).toString('latin1'),''].join(CRLF),
};
const appendRaw=(raw,box='INBOX')=>imapDirect(async(c)=>(await c.append(box,Buffer.from(raw,'latin1'))).uid);
const UIDS={};for(const [k,raw] of Object.entries(RAWS))UIDS[k]=await appendRaw(raw);
t('parts: test messages appended',Object.values(UIDS).every(u=>Number.isInteger(u)),JSON.stringify(UIDS));
const getRaw=async(p,headers={})=>{const t0=Date.now();const res=await fetch(B+p,{headers:{authorization:'Bearer '+A.token,...headers}});const buf=Buffer.from(await res.arrayBuffer());return{s:res.status,buf,h:res.headers,ms:Date.now()-t0,j:(()=>{try{return JSON.parse(buf.toString())}catch{return null}})()};};
for(const [k,raw] of Object.entries(RAWS)){
  const want=await PostalMime.parse(Buffer.from(raw,'latin1'),{attachmentEncoding:'arraybuffer'});
  const got=(await api(A.token,'GET',`${P}/messages/${UIDS[k]}?folder=INBOX`)).j.message;
  // GreenMail leaves a part's last line break out of BODY[n] (other servers give the part's exact bytes), so the text is
  // compared without the line breaks at its end.
  const tail=(x)=>x==null?null:x.replace(/\n+$/,'');
  const same=got&&(got.html??null)===(want.html??null)&&tail(got.text)===tail(want.text)&&got.attachments.length===want.attachments.length&&
    got.attachments.every((a,i)=>a.index===i&&a.filename===(want.attachments[i].filename??`attachment-${i+1}`)&&a.mimeType===want.attachments[i].mimeType&&(a.contentId??null)===(want.attachments[i].contentId?.replace(/^<|>$/g,'')??null)&&a.size===want.attachments[i].content.byteLength);
  const diff=got?{html:[got.html,want.html??null],text:[tail(got.text),tail(want.text)],att:[got.attachments,want.attachments.map((a,i)=>({i,filename:a.filename,mimeType:a.mimeType,contentId:a.contentId,size:a.content.byteLength}))]}:null;
  t(`parts: ${k} opens as postal-mime reads the whole message`,same,JSON.stringify(diff&&Object.fromEntries(Object.entries(diff).filter(([,v])=>JSON.stringify(v[0])!==JSON.stringify(v[1])))).slice(0,600));
  for(const a of got?.attachments??[]){const res=await getRaw(`${P}/messages/${UIDS[k]}/attachments/${a.index}?folder=INBOX`);t(`parts: ${k} attachment ${a.index} downloads`,res.s===200&&res.buf.equals(Buffer.from(want.attachments[a.index].content)),res.s+' '+res.buf.length);}
}
let D2=(await api(A.token,'GET',`${P}/messages/${UIDS.alt}?folder=INBOX`)).j.message;
t('parts: replyTo, inReplyTo and references come with it',D2?.replyTo?.[0]?.address==='team@acme.test'&&D2.inReplyTo==='<q2@acme.test>'&&D2.references?.join()==='<q1@acme.test>,<q2@acme.test>',JSON.stringify([D2?.replyTo,D2?.inReplyTo,D2?.references]));
t('parts: the inline picture is marked inline with its Content-ID',D2?.attachments?.[0]?.inline===true&&D2.attachments[0].contentId===`chart-${tag}@acme`&&D2.attachments[1].inline===false,JSON.stringify(D2?.attachments));
res=await getRaw(`${P}/messages/${UIDS.alt}/attachments/0?folder=INBOX&inline=1`);t('parts: the cid: picture is served inline',res.s===200&&res.h.get('content-type')==='image/png'&&res.h.get('content-disposition')?.startsWith('inline')&&res.buf.equals(PNG),res.s+' '+res.h.get('content-type'));
D2=(await api(A.token,'GET',`${P}/messages/${UIDS.charsets}?folder=INBOX`)).j.message;t('parts: iso-8859-1 and windows-1251 are decoded',D2?.text?.includes('Grüße aus Köln')&&D2.html==='<p>Привет</p>',JSON.stringify([D2?.text,D2?.html]));
D2=(await api(A.token,'GET',`${P}/messages/${UIDS.koi8}?folder=INBOX`)).j.message;t('parts: koi8-r 8bit is decoded',D2?.text?.startsWith('Привет'),D2?.text);
r=await api(A.token,'GET',`${P}/messages/${UIDS.plain}/attachments/0?folder=INBOX`);t('parts: a message with no attachments has none to download',r.s===404,r.s);

// A message over the old 50 MB limit opens: only its text is fetched, and each attachment downloads by itself.
const HUGE=Buffer.alloc(19*1024*1024,0x5a);
const hugeRaw=['From: Bob <bob@acme.test>',`Subject: Parts huge ${tag}`,'MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="h"','','--h','Content-Type: text/plain; charset=utf-8','','The big files.','',
  ...[1,2,3].flatMap(n=>['--h','Content-Type: application/octet-stream; name="big'+n+'.bin"','Content-Transfer-Encoding: base64','Content-Disposition: attachment; filename="big'+n+'.bin"','',b64(HUGE)]),'--h--',''].join(CRLF);
UIDS.huge=await appendRaw(hugeRaw);
const sizeMB=Math.round(hugeRaw.length/1048576);
res=await getRaw(`${P}/messages/${UIDS.huge}?folder=INBOX`);
t(`parts: a ${sizeMB} MB message opens`,res.s===200&&res.j?.message?.text?.startsWith('The big files.')&&res.j.message.attachments.length===3&&res.j.message.attachments.every(a=>Math.abs(a.size-HUGE.length)<HUGE.length*0.01),res.s+' '+res.ms+'ms '+JSON.stringify(res.j?.message?.attachments??res.j).slice(0,150));
t('parts: and quickly (it does not download the attachments)',res.ms<3000,res.ms+'ms');
res=await getRaw(`${P}/messages/${UIDS.huge}/attachments/2?folder=INBOX`);t('parts: one of its attachments downloads by itself',res.s===200&&res.buf.equals(HUGE),res.s+' '+res.buf.length+' '+res.ms+'ms');

// ---- Three connections: sorting and the re-check never hold up a list, opening a message or marking it seen ------------
// x-mail-test-recheck: 1 starts the re-check now (in the background, on the sorter connection), and x-mail-test-slow-ms
// (MAIL_ALLOW_INSECURE only) pauses each of the sorter's steps inside its INBOX lock.
r=await api(A.token,'PATCH',P,{tabs:['promotions','social','updates','forums']});
await api(A.token,'GET',`${P}/messages?folder=INBOX&category=primary&limit=5`);
const SLOW=3000;
const logSize=()=>fs.statSync(log).size;
const logSince=(at)=>{const fd=fs.openSync(log,'r');try{const len=fs.fstatSync(fd).size-at;const b=Buffer.alloc(Math.max(0,len));fs.readSync(fd,b,0,b.length,at);return b.toString('utf8');}finally{fs.closeSync(fd);}};
const recheckLine=async(at,ms=20000)=>{for(const t0=Date.now();Date.now()-t0<ms;await sleep(200)){const l=logSince(at).split('\n').find(x=>/\[mail\] recheck: /.test(x));if(l)return l;}return null;};
let at=logSize();
const kick=await getRaw(`${P}/messages?folder=INBOX&category=forums&limit=5`,{'x-mail-test-recheck':'1','x-mail-test-slow-ms':String(SLOW)});
t('three connections: the list that starts the re-check does not wait for it',kick.s===200&&kick.ms<1500,kick.s+' '+kick.ms+'ms');
await sleep(200);
const [msgGet,seenPatch,listGet,pageGet]=await Promise.all([
  // plain is not among the last three opened, so this one reads from the server.
  getRaw(`${P}/messages/${UIDS.plain}?folder=INBOX`),
  (async()=>{const t0=Date.now();const x=await api(A.token,'PATCH',`${P}/messages`,{folder:'INBOX',uids:[UIDS.koi8],seen:true});return{...x,ms:Date.now()-t0};})(),
  getRaw(`${P}/messages?folder=INBOX&category=primary&limit=5`),
  getRaw(`${P}/messages?folder=INBOX&category=updates&limit=2&before=${UIDS.plain}`),
]);
const rl=await recheckLine(at);const rlMs=Number(/ (\d+)ms \(lock wait/.exec(rl??'')?.[1]);
t('three connections: the slow re-check took its time (the hook works)',rlMs>=SLOW,rl);
t('three connections: a tab list meanwhile is not held up',listGet.s===200&&listGet.j?.messages?.length>0&&listGet.ms<1500,listGet.s+' '+listGet.ms+'ms');
t('three connections: nor is a later page',pageGet.s===200&&pageGet.ms<1500,pageGet.s+' '+pageGet.ms+'ms');
t('three connections: nor is opening a message',msgGet.s===200&&msgGet.ms<1500,msgGet.s+' '+msgGet.ms+'ms');
t('three connections: nor marking one seen',seenPatch.s===200&&seenPatch.ms<1500,seenPatch.s+' '+seenPatch.ms+'ms');

// ---- The tabs' cache ------------------------------------------------------------------------------------------------
await deliver('Dana Lee <dana@acme.test>','Gone soon',{});
let gone;for(let i=0;i<20&&!gone;i++){r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=primary&limit=10`);gone=r.j.messages?.find(m=>m.subject===`Gone soon ${tag}`);if(!gone)await sleep(300);}
t('cache: new mail is sorted into its tab',!!gone&&gone.category==='primary'&&r.j.messages[0]?.uid===gone.uid,JSON.stringify(gone).slice(0,140));
const MOVED2=`Elsewhere-${tag}`;
await imapDirect(async(c)=>{await c.mailboxCreate(MOVED2);const lock=await c.getMailboxLock('INBOX');try{await c.messageMove(String(gone.uid),MOVED2,{uid:true});}finally{lock.release();}});
// The re-check (started by a list of another tab, which does not show it) forgets the message that left.
at=logSize();
r=await getRaw(`${P}/messages?folder=INBOX&category=forums&limit=5`,{'x-mail-test-recheck':'1'});
const rl2=await recheckLine(at);
t('cache: the re-check forgets a message moved away by another app',/ 1 gone, /.test(rl2??''),rl2);
r=await api(A.token,'GET',`${P}/messages?folder=INBOX&category=primary&limit=50`);t('cache: and it is not in the tab list',r.s===200&&!r.j.messages?.some(m=>m.uid===gone?.uid),JSON.stringify(tagged(r.j.messages).map(m=>m.subject)));

// A fresh account on the same mailbox, sorting one message per step: a page that comes back short says `sorting`, and asked
// again (as the client does) it fills in; together the tabs list every INBOX message once, newest first.
r=await api(A.token,'POST','/v1/mail/accounts',{email:MAIL_USER,displayName:'Ann',password:'x',imap:server(3143),smtp:server(3025)});
const P2=`/v1/mail/accounts/${r.j.account?.id}`;await api(A.token,'PATCH',P2,{tabs:['promotions','social','updates','forums']});
const inboxUids=await imapDirect(async(c)=>{const lock=await c.getMailboxLock('INBOX');try{return (await c.search({all:true},{uid:true})).sort((a,b)=>b-a);}finally{lock.release();}});
// Walks a tab as the client does: a page with `sorting` is asked for again a moment later, until it is full or done.
const walk=async(path,cat,limit,headers={})=>{const out=[];let before=null,calls=0,sorting=0,ordered=true;for(let i=0;i<600;i++){calls++;const x=await getRaw(`${path}/messages?folder=INBOX&category=${cat}&limit=${limit}${before?`&before=${before}`:''}`,headers);if(x.s!==200)return{out,calls,sorting,ordered:false,err:x.s};const ms=x.j.messages??[];if(x.j.sorting){if(ms.length>=limit||x.j.next===null)ordered=false;sorting++;await sleep(100);continue;}ms.forEach((m,j)=>{if(m.category!==cat||(j&&ms[j-1].uid<=m.uid)||(before&&m.uid>=before))ordered=false;out.push(m.uid);});if(!x.j.next)break;before=x.j.next;}return{out,calls,sorting,ordered};};
const seenUids=[];let calls=0,shortSorting=0,ordered=true;
for(const cat of ['forums','social','promotions','updates','primary']){const w=await walk(P2,cat,3,{'x-mail-test-classify-cap':'1'});seenUids.push(...w.out);calls+=w.calls;shortSorting+=w.sorting;ordered&&=w.ordered;}
t('cache: with a small budget, a short page says sorting, and asked again fills in',shortSorting>0,`${calls} calls, ${shortSorting} sorting`);
t('cache: and together the tabs list every INBOX message once, newest first in each',ordered&&seenUids.length===inboxUids.length&&new Set(seenUids).size===inboxUids.length&&inboxUids.every(u=>seenUids.includes(u)),`${seenUids.length} listed of ${inboxUids.length}`);
await api(A.token,'DELETE',P2);

// A cold cache on a larger INBOX (another GreenMail user, 320 messages: the 20 oldest a mailing list's, the rest a
// colleague's): the first Forums page answers at once, empty with `sorting`, though each sorting step is slowed, and
// fills in as the sorter goes; Primary pages through all 300.
const BULK=`bulk-${tag}@test.local`;
const bulkImap=async(fn)=>{const c=new ImapFlow({host:'127.0.0.1',port:3143,secure:false,doSTARTTLS:false,auth:{user:BULK,pass:'x'},logger:false});await c.connect();try{return await fn(c)}finally{await c.logout()}};
const raw=(i,forum)=>[`From: ${forum?'Sam Rivera <sam@rivera.dev>':'Dana Lee <dana@acme.test>'}`,`To: ${BULK}`,`Subject: ${forum?'[hikers] Trail report':'Notes'} ${i} ${tag}`,`Date: ${new Date(Date.UTC(2026,9,1)+i*60000).toUTCString()}`,`Message-ID: <bulk-${i}-${tag}@test.local>`,...(forum?['List-Id: <hikers.googlegroups.com>','List-Post: <mailto:hikers@googlegroups.com>','X-Google-Group-Id: 42']:[]),'Content-Type: text/plain; charset=utf-8','',`Message ${i}.`,''].join('\r\n');
await bulkImap(async(c)=>{for(let i=0;i<320;i++)await c.append('INBOX',raw(i,i<20));});
const Cy=await signup(`bulk-${tag}@example.com`,'Cy');
r=await api(Cy.token,'POST','/v1/mail/accounts',{email:BULK,displayName:'Bulk',password:'x',imap:server(3143),smtp:server(3025)});
const P3=`/v1/mail/accounts/${r.j.account?.id}`;await api(Cy.token,'PATCH',P3,{tabs:['promotions','social','updates','forums']});
const cold=await (async()=>{const t0=Date.now();const x=await fetch(`${B}${P3}/messages?folder=INBOX&category=forums&limit=25`,{headers:{authorization:'Bearer '+Cy.token,'x-mail-test-slow-ms':'1500'}});return{s:x.status,j:await x.json(),ms:Date.now()-t0};})();
t('cold cache: the first page of a tab answers at once, with sorting',cold.s===200&&cold.ms<1500&&cold.j.sorting===true&&cold.j.messages.length<25,cold.s+' '+cold.ms+'ms '+JSON.stringify(cold.j).slice(0,120));
let filled=null,asks=0;for(const t0=Date.now();Date.now()-t0<30000;){asks++;const x=await fetch(`${B}${P3}/messages?folder=INBOX&category=forums&limit=25`,{headers:{authorization:'Bearer '+Cy.token}});const j=await x.json();if(!j.sorting){filled=j;break;}await sleep(500);}
t('cold cache: asked again, the page fills in as the sorter goes',filled?.messages?.length===20&&filled.next===null&&filled.messages.every(m=>m.category==='forums'&&m.subject.includes('[hikers]')),`${asks} asks, ${filled?.messages?.length} messages`);
const prim=await walk(P3,'primary',50,{authorization:'Bearer '+Cy.token});
t('cold cache: and Primary pages through all 300, newest first',prim.ordered&&prim.out.length===300&&new Set(prim.out).size===300,`${prim.out.length} in ${prim.calls} calls, ${prim.sorting} sorting`);
await api(Cy.token,'DELETE',P3);
await bulkImap(async(c)=>{const lock=await c.getMailboxLock('INBOX');try{await c.messageDelete('1:*');}finally{lock.release();}}).catch(()=>{});
const logText=fs.readFileSync(log,'utf8');const timingLines=logText.split('\n').filter(l=>/\[mail\] (GET|POST|PATCH|DELETE) \/v1\/mail/.test(l));
t('timing: one line per request, with the lock wait and IMAP time',timingLines.some(l=>/\[mail\] GET \/v1\/mail\/accounts\/:id\/messages\/:uid 200 \d+ms \(lock wait \d+ms, imap \d+ms\)/.test(l)),timingLines.at(-1));
t('timing: and nothing of the mail in them',timingLines.length>20&&!timingLines.some(l=>l.includes(tag)||l.includes(ACC)||l.includes(MAIL_USER)),timingLines.find(l=>l.includes(tag)||l.includes(ACC)));
await imapDirect(async(c)=>{await c.mailboxDelete(MOVED2).catch(()=>{});const lock=await c.getMailboxLock('INBOX');try{await c.messageDelete(Object.values(UIDS).join(','),{uid:true});}finally{lock.release();}}).catch(()=>{});
smtpDirect.close();

r=await api(A.token,'PATCH',P,{displayName:'Ann Example'});t('rename the account',r.s===200&&r.j.account?.displayName==='Ann Example',JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'PATCH',P,{password:'new-pw',imap:server(3998)});t('changing servers re-verifies, and a bad one is refused',r.s===422&&r.j.error?.code==='connect_failed',r.s+' '+JSON.stringify(r.j).slice(0,120));
r=await api(A.token,'GET','/v1/mail/accounts');t('and nothing was saved',r.j.accounts?.[0]?.imap?.port===3143&&r.j.accounts[0].status==='ok',JSON.stringify(r.j).slice(0,140));
r=await api(A.token,'DELETE',P);t('delete the account',r.s===200&&r.j.ok,r.s);
r=await api(A.token,'GET','/v1/mail/accounts');t('it is gone',r.j.accounts?.length===0,JSON.stringify(r.j));
r=await api(A.token,'GET',`${P}/folders`);t('and its routes are not_found',r.s===404,r.s);
// Tidy GreenMail: the folder made here, and this run's copies in Sent and Trash.
await imapDirect(async(c)=>{await c.mailboxDelete(MOVED).catch(()=>{});for(const box of ['Sent','Trash','INBOX']){const lock=await c.getMailboxLock(box).catch(()=>null);if(!lock)continue;try{const u=await c.search({subject:tag},{uid:true});if(u?.length)await c.messageDelete(u.join(','),{uid:true});}finally{lock.release();}}}).catch(()=>{});

// The sign-in rate limit: 10 verifications per 15 minutes per person. Bo has used none.
let codes=[];for(let i=0;i<11;i++){r=await api(Bo.token,'POST','/v1/mail/accounts',{email:MAIL_USER,password:'x',imap:server(3997),smtp:server(3025)});codes.push(r.j.error?.code);}
t('sign-in attempts are rate limited',codes.slice(0,10).every(c=>c==='connect_failed')&&codes[10]==='rate_limited',codes.join(','));

console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);
