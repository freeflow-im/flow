// End-to-end check of FreeFlow Mail (/v1/mail/*, src/imap/object.ts) through the Worker and a person's Mail object, against
// the GreenMail server in Docker (`flow-greenmail`: SMTP 127.0.0.1:3025, IMAP 127.0.0.1:3143, any password logs in) and a
// local `wrangler dev` started as test/e2e.mjs says, on port 18798 and with mail's insecure dev mode on:
//   npx wrangler dev --port 18798 --local --enable-containers=false --var PORTED_HOSTS:edge.freeflow.im,localhost \
//     --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 --var WEB_URL_BASE:http://localhost:18798 \
//     --var MAIL_ALLOW_INSECURE:1 > /tmp/edge-mail.log 2>&1 &
//   node test/e2e-mail.mjs /tmp/edge-mail.log
// It reads signup links from the Worker's log, because local mail goes there. MAIL_USER picks the GreenMail address.
import fs from 'node:fs';
import { ImapFlow } from 'imapflow';
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
