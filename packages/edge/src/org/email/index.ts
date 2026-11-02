// Mail, through the Worker's sender.
import { sendMail, type MailEnv } from '../../mail';

export interface EmailMessage { to: string; subject: string; text: string; html?: string; fromName?: string }
let env: MailEnv = {};
export const setMailEnv = (e: MailEnv) => { env = e; };
export const emailSender = () => ({ send: (m: EmailMessage) => sendMail(env, m) });
