import { existsSync } from "node:fs";
import { MAIL_FROM } from "./config.ts";

export interface Mail {
  to: string;
  subject: string;
  body: string;
}

export type Transport = (mail: Mail) => Promise<void>;

const SENDMAIL_PATH = process.env.SENDMAIL_PATH ?? "/usr/sbin/sendmail";
export const SENDMAIL_AVAILABLE = existsSync(SENDMAIL_PATH);

const encodeHeader = (s: string) =>
  // eslint-disable-next-line no-control-regex
  /^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

const compose = (mail: Mail): string =>
  [
    `From: ${MAIL_FROM}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    mail.body.replace(/\r?\n/g, "\r\n"),
    "",
  ].join("\r\n");

const sendmailTransport: Transport = async (mail) => {
  const proc = Bun.spawn([SENDMAIL_PATH, "-t"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(compose(mail));
  await proc.stdin.end();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`sendmail exited ${code} sending to ${mail.to}: ${err.trim()}`);
  }
};

const logTransport: Transport = async (mail) => {
  console.log(
    `\n----- MAIL (dev, not sent) -----\n${compose(mail).replace(/\r\n/g, "\n")}--------------------------------\n`,
  );
};

let transport: Transport = SENDMAIL_AVAILABLE ? sendmailTransport : logTransport;

/** Swap the transport (tests, and anything that wants to capture outgoing mail). */
export function setTransport(t: Transport) {
  transport = t;
}

export function announceMailMode() {
  if (SENDMAIL_AVAILABLE) {
    console.log(`mail: sending via ${SENDMAIL_PATH} -t as ${MAIL_FROM}`);
  } else {
    console.warn(
      `!! MAIL IS IN DEV MODE !!\n` +
        `!! ${SENDMAIL_PATH} does not exist, so no mail will actually be sent.\n` +
        `!! Messages are printed to stdout instead. Set SENDMAIL_PATH to a real binary in production.`,
    );
  }
}

export async function sendMail(mail: Mail): Promise<void> {
  await transport(mail);
}
