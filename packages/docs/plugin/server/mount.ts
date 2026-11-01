// Runs the plugin inside the app's own Fastify server, so one server with one volume serves both.
// The plugin owns a few paths (/mcp, /oauth/*, /plugin/*, the OAuth well-known documents); a hook at the
// start of the request answers those with the plugin's handler and leaves everything else to the app.
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AuthService } from '../../server/auth.ts';
import type { DB } from '../../server/db.ts';
import type { GoogleLogin } from '../../server/googleAuth.ts';
import type { Mailer } from '../../server/mail.ts';
import type { FileStore } from '../../server/files.ts';
import type { ImageStore } from '../../server/images.ts';
import type { SheetStore } from '../../server/sheets.ts';
import { FileHub } from './files.ts';
import { createPluginHandler } from './http.ts';
import { OAuthServer } from './oauth.ts';
import type { PdfMaker } from '../../server/pdf.ts';

export interface MountOptions {
  db: DB;
  dataDir: string;
  sheets: SheetStore;
  images: ImageStore;
  /** The app's stored files (PDFs, videos), which the plugin lists and shows too. */
  files?: FileStore;
  /** Makes PDFs of files (server/pdf.ts), for export_pdf. */
  pdf?: PdfMaker;
  auth: AuthService;
  google: GoogleLogin | null;
  /** The app's mailer and its limit on emails per address, for accounts created on the plugin's sign-in page. */
  sendMail: Mailer;
  mailAllowed: (email: string) => boolean;
  /**
   * Public origin of the app (the OAuth issuer and where images come from), e.g. https://docs.example.com. Several,
   * comma-separated, when the app is reached on more than one host: each is the issuer and resource of requests to
   * its host (a client checks both against the address it was given), the first for any other host and for images.
   */
  publicUrl: string;
  /** Directory with the built plugin app (plugin/dist/web). */
  webDir: string;
  /** The app session cookie's name, to skip the sign-in page for a browser already signed in to the app. */
  sessionCookie: string;
  production: boolean;
}

/** Returns the OAuth server, for the app's Settings page (the agents connected with a device code). */
export async function mountPlugin(app: FastifyInstance, opts: MountOptions): Promise<OAuthServer> {
  const urls = opts.publicUrl.split(',').map((u) => u.trim().replace(/\/$/, '')).filter(Boolean);
  const publicUrl = urls[0];
  const hub = new FileHub({ db: opts.db, dataDir: opts.dataDir, publicUrl, sheets: opts.sheets, images: opts.images, files: opts.files, pdf: opts.pdf });
  // One OAuth server per host, over the same database: a sign-in on either host gives tokens both accept.
  const db = new DatabaseSync(path.join(opts.dataDir, 'plugin.db'));
  const hosts = urls.map((url) => {
    const oauth = new OAuthServer({
      db,
      issuer: url,
      resource: `${url}/mcp`,
      auth: opts.auth,
      profile: (id) => hub.profile(id),
      google: opts.google,
      sendMail: opts.sendMail,
      mailAllowed: opts.mailAllowed,
    });
    const handler = createPluginHandler({
      hub,
      oauth,
      publicUrl: url,
      webDir: opts.webDir,
      production: opts.production,
      sessionUser: (req) => {
        const cookie = parseCookie(req.headers.cookie)[opts.sessionCookie];
        return opts.auth.userForSession(cookie)?.id ?? null;
      },
    });
    return { host: new URL(url).host, oauth, handler };
  });
  app.addHook('onRequest', (req, reply, done) => {
    const pathname = (req.raw.url ?? '/').split('?')[0];
    const host = req.headers.host?.toLowerCase();
    const { handler } = hosts.find((h) => h.host === host) ?? hosts[0];
    if (!handler.handles(pathname)) return done();
    reply.hijack();
    handler.handle(req.raw, reply.raw).catch((e: unknown) => {
      req.log.error({ err: e }, 'plugin request failed');
      if (!reply.raw.headersSent) reply.raw.writeHead(500).end();
    });
  });
  app.log.info(`ChatGPT plugin mounted at ${urls.map((u) => `${u}/mcp`).join(', ')} (each its own OAuth issuer)`);
  return hosts[0].oauth;
}

function parseCookie(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

