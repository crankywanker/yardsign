/**
 * Outbound email behind one small interface. Resend and Postmark are plain HTTPS
 * APIs, so each is a few lines. SES needs request signing and is not here yet.
 * Pick with EMAIL_PROVIDER; the key goes in EMAIL_API_KEY; the sender address in EMAIL_FROM.
 */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface EmailSender {
  readonly name: string;
  send(msg: EmailMessage): Promise<{ id: string | null }>;
}

export interface EmailEnv {
  EMAIL_PROVIDER?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
}

async function readError(res: Response): Promise<string> {
  const text = (await res.text()).slice(0, 500);
  return `${res.status} ${res.statusText}: ${text}`;
}

export class ResendSender implements EmailSender {
  readonly name = 'resend';
  constructor(private readonly apiKey: string, private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}
  async send(msg: EmailMessage): Promise<{ id: string | null }> {
    const res = await this.fetchFn('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: msg.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, reply_to: msg.replyTo }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`resend: ${await readError(res)}`);
    const body = (await res.json()) as { id?: string };
    return { id: body.id ?? null };
  }
}

export class PostmarkSender implements EmailSender {
  readonly name = 'postmark';
  constructor(private readonly serverToken: string, private readonly fetchFn: typeof fetch = (input, init) => fetch(input, init)) {}
  async send(msg: EmailMessage): Promise<{ id: string | null }> {
    const res = await this.fetchFn('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'X-Postmark-Server-Token': this.serverToken, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ From: msg.from, To: msg.to, Subject: msg.subject, HtmlBody: msg.html, TextBody: msg.text, ReplyTo: msg.replyTo, MessageStream: 'outbound' }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`postmark: ${await readError(res)}`);
    const body = (await res.json()) as { MessageID?: string };
    return { id: body.MessageID ?? null };
  }
}

/** Null when email is not configured; the caller falls back to the log channel. Throws on a bad provider name. */
export function getEmailSender(env: EmailEnv): { sender: EmailSender; from: string } | null {
  const provider = (env.EMAIL_PROVIDER ?? '').toLowerCase();
  if (!provider) return null;
  if (!env.EMAIL_API_KEY) throw new Error(`EMAIL_PROVIDER is "${provider}" but EMAIL_API_KEY is not set`);
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is not set');
  switch (provider) {
    case 'resend':
      return { sender: new ResendSender(env.EMAIL_API_KEY), from: env.EMAIL_FROM };
    case 'postmark':
      return { sender: new PostmarkSender(env.EMAIL_API_KEY), from: env.EMAIL_FROM };
    default:
      throw new Error(`Unknown EMAIL_PROVIDER "${provider}" (expected "resend" or "postmark")`);
  }
}
