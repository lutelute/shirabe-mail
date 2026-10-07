// nodemailer は型定義を同梱していないので、使う範囲だけ宣言する
declare module 'nodemailer' {
  export interface SendMailOptions {
    from?: string;
    to?: string | string[];
    cc?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string | string[];
    messageId?: string;
    date?: Date | string;
  }
  export interface SentMessageInfo {
    messageId?: string;
    accepted?: Array<string | { address: string }>;
    rejected?: Array<string | { address: string }>;
    response?: string;
  }
  export interface TransportOptions {
    host: string;
    port: number;
    secure?: boolean;
    requireTLS?: boolean;
    auth?: { user: string; pass: string };
    connectionTimeout?: number;
    greetingTimeout?: number;
    socketTimeout?: number;
  }
  export interface Transporter {
    sendMail(mail: SendMailOptions): Promise<SentMessageInfo>;
    verify(): Promise<true>;
    close(): void;
  }
  export function createTransport(options: TransportOptions): Transporter;
  const nodemailer: { createTransport: typeof createTransport };
  export default nodemailer;
}

declare module 'nodemailer/lib/mail-composer/index.js' {
  import type { SendMailOptions } from 'nodemailer';
  export default class MailComposer {
    constructor(mail: SendMailOptions);
    compile(): { build(): Promise<Buffer> };
  }
}
