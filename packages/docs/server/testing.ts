// Helpers for the server tests: a mailbox that captures outgoing mail, and sign-up that completes email
// verification so a test gets a signed-in cookie in one call.
import type { FastifyInstance } from 'fastify';
import JSZip from 'jszip';
import type { Mail } from './mail.ts';

export interface Mailbox {
  sent: Mail[];
  send: (mail: Mail) => Promise<void>;
  /** The token in the most recent `/<page>?token=...` link sent to this address. */
  tokenFor(to: string, page: 'verify' | 'reset'): string;
}

export function mailbox(): Mailbox {
  const sent: Mail[] = [];
  return {
    sent,
    send: async (mail) => void sent.push(mail),
    tokenFor(to, page) {
      const mail = [...sent].reverse().find((m) => m.to === to.trim().toLowerCase());
      const match = mail && new RegExp(`/${page}\\?token=([A-Za-z0-9_-]+)`).exec(mail.text);
      if (!match) throw new Error(`no ${page} link was emailed to ${to}`);
      return match[1];
    },
  };
}

/** Register, open the emailed verification link, and return the session cookie and user. */
export async function signUp(app: FastifyInstance, box: Mailbox, email: string, password = 'password123') {
  let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email, password } });
  if (res.statusCode !== 200) throw new Error(`register ${email} failed: ${res.statusCode} ${res.body}`);
  res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: box.tokenFor(email, 'verify') } });
  if (res.statusCode !== 200) throw new Error(`verify ${email} failed: ${res.statusCode} ${res.body}`);
  const sc = res.headers['set-cookie'];
  const cookie = (Array.isArray(sc) ? sc[0] : String(sc)).split(';')[0];
  return { cookie, user: (res.json() as { user: { id: string; email: string } }).user };
}

// --- Word documents for the import tests ---------------------------------------------------

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

/** Build a .docx with the given body XML (paragraphs etc.), standard styles and numbering, one picture and a hyperlink. */
export async function buildDocx(body: string, opts: { styles?: string; numbering?: string } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`);
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://biztrip.ai/" TargetMode="External"/><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
  );
  zip.file('word/media/image1.png', PNG);
  zip.file(
    'word/styles.xml',
    opts.styles ??
      `<?xml version="1.0"?><w:styles ${W}>
        <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
        <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
        <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="56"/></w:rPr></w:style>
        <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/></w:style>
        <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr></w:style>
        <w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/></w:style>
        <w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/></w:style>
        <w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>
        <w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>
      </w:styles>`,
  );
  zip.file(
    'word/numbering.xml',
    opts.numbering ??
      `<?xml version="1.0"?><w:numbering ${W}>
        <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
        <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
        <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
        <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
      </w:numbering>`,
  );
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}
