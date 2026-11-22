import nodemailer from "nodemailer";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  ics?: { method: "REQUEST" | "CANCEL"; content: string };
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private transport;
  constructor(
    url: string,
    private from: string,
  ) {
    this.transport = nodemailer.createTransport(url);
  }
  async send(m: MailMessage) {
    await this.transport.sendMail({
      from: this.from,
      to: m.to,
      replyTo: m.replyTo,
      subject: m.subject,
      html: m.html,
      text: m.text,
      icalEvent: m.ics ? { method: m.ics.method, content: m.ics.content, filename: "invite.ics" } : undefined,
    });
  }
}

/** Used when SMTP is not configured: prints emails to the server log. */
export class ConsoleMailer implements Mailer {
  async send(m: MailMessage) {
    console.log(`[email] to=${m.to} subject="${m.subject}"\n${m.text}\n`);
  }
}

/** Collects messages in memory (tests). */
export class MemoryMailer implements Mailer {
  messages: MailMessage[] = [];
  async send(m: MailMessage) {
    this.messages.push(m);
  }
}
