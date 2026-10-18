// Sends email through SMTP. Defaults are for Gmail with an App Password.
import type { AlertEmail } from "../core/alerts.ts";

export function mailConfig() {
  const user = process.env.SMTP_USER?.trim();
  const pass = process.env.SMTP_PASS?.replace(/\s+/g, ""); // Gmail shows app passwords with spaces
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    user,
    pass,
    host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port,
    secure: port === 465,
    to: process.env.MAIL_TO?.trim() || user,
  };
}

export async function sendMail(email: AlertEmail): Promise<void> {
  const cfg = mailConfig();
  if (!cfg.user || !cfg.pass) {
    throw new Error("Set SMTP_USER and SMTP_PASS in .env first (see .env.example).");
  }
  const nodemailer = (await import("nodemailer")).default;
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transport.sendMail({
    from: `Job Tracker <${cfg.user}>`,
    to: cfg.to,
    subject: email.subject,
    text: email.text,
    html: email.html,
  });
}
