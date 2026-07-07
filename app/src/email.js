"use strict";
// Email tools: read + send using the USER'S OWN account, with credentials from the
// secrets vault. Save a secret named "email" with fields:
//   username, password, imap_host, smtp_host  (optional: imap_port, smtp_port, from)
// For Gmail/Outlook use an app password. Nothing here creates accounts.
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const nodemailer = require("nodemailer");
const { getSecrets } = require("./config");

function creds() {
  const s = getSecrets().email;
  if (!s || !s.username || !s.password || !s.imap_host) {
    throw new Error("no 'email' secret configured — save one with set_secret name='email' and fields {username, password, imap_host, smtp_host} (use an app password for Gmail/Outlook)");
  }
  return s;
}

async function withImap(fn) {
  const c = creds();
  const client = new ImapFlow({
    host: c.imap_host, port: Number(c.imap_port) || 993, secure: true,
    auth: { user: c.username, pass: c.password }, logger: false,
  });
  await client.connect();
  try { return await fn(client); }
  finally { await client.logout().catch(() => {}); }
}

// List recent messages (newest last) — headers only, cheap.
async function checkEmail(args = {}) {
  const folder = args.folder || "INBOX";
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  return await withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const total = client.mailbox.exists;
      if (!total) return { folder, total: 0, messages: [] };
      let range;
      if (args.unseen_only) {
        const uids = await client.search({ seen: false }, { uid: true });
        if (!uids || !uids.length) return { folder, total, unseen: 0, messages: [] };
        range = uids.slice(-limit).join(",");
      } else {
        range = `${Math.max(1, total - limit + 1)}:*`;
      }
      const messages = [];
      for await (const m of client.fetch(range, { envelope: true, uid: true, flags: true }, { uid: !!args.unseen_only })) {
        messages.push({
          uid: m.uid,
          from: (m.envelope.from && m.envelope.from[0] && m.envelope.from[0].address) || "",
          subject: m.envelope.subject || "(no subject)",
          date: m.envelope.date ? new Date(m.envelope.date).toISOString() : null,
          seen: m.flags ? m.flags.has("\\Seen") : undefined,
        });
      }
      return { folder, total, messages };
    } finally { lock.release(); }
  });
}

// Fetch + parse ONE message's body by uid (from check_email).
async function readEmail(args = {}) {
  if (!args.uid) throw new Error("uid is required (get it from check_email)");
  const folder = args.folder || "INBOX";
  return await withImap(async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const m = await client.fetchOne(String(args.uid), { source: true }, { uid: true });
      if (!m || !m.source) throw new Error(`no message with uid ${args.uid} in ${folder}`);
      const parsed = await simpleParser(m.source);
      const body = (parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : "")).trim();
      return {
        uid: args.uid,
        from: parsed.from && parsed.from.text,
        to: parsed.to && parsed.to.text,
        subject: parsed.subject,
        date: parsed.date ? parsed.date.toISOString() : null,
        body: body.slice(0, 15000) + (body.length > 15000 ? "\n[truncated]" : ""),
        attachments: (parsed.attachments || []).map((a) => ({ filename: a.filename, size: a.size, contentType: a.contentType })),
      };
    } finally { lock.release(); }
  });
}

async function sendEmail(args = {}) {
  const { to, subject, body } = args;
  if (!to || !subject || body == null) throw new Error("to, subject, and body are all required");
  const c = creds();
  if (!c.smtp_host) throw new Error("the 'email' secret has no smtp_host — add it with set_secret to enable sending");
  const port = Number(c.smtp_port) || 465;
  const transport = nodemailer.createTransport({
    host: c.smtp_host, port, secure: port === 465,
    auth: { user: c.username, pass: c.password },
  });
  const info = await transport.sendMail({ from: c.from || c.username, to, subject, text: String(body) });
  return { sent: true, to, subject, message_id: info.messageId };
}

module.exports = { checkEmail, readEmail, sendEmail };
