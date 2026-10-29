import { url } from "./config.ts";
import { sendMail } from "./mail.ts";
import type { User } from "./db.ts";

export const inLink = (u: User) => url(`/in/${u.token}`);

export async function welcome(u: User) {
  await sendMail({
    to: u.email,
    subject: "You're in. The Epic Video-inator awaits.",
    body: `${u.name},

BenBot SI has deemed you worthy. You get ${u.credits - u.used} epic video${u.credits - u.used === 1 ? "" : "s"}.

Your way in (it's yours, don't share it):
${inLink(u)}

Make something legendary.
BenBot
`,
  });
}

export async function signIn(u: User) {
  await sendMail({
    to: u.email,
    subject: "Your way back into the Epic Video-inator",
    body: `${u.name},

Here's your link back in (it's yours, don't share it):
${inLink(u)}

BenBot
`,
  });
}

export async function videoStarted(u: User, chatId: string) {
  await sendMail({
    to: u.email,
    subject: "Your epic video is cooking",
    body: `${u.name},

BenBot SI just started making your video. It usually takes about two hours, and you'll get another email the moment
it's done. Watch the progress here:
${url(`/in/${u.token}?chat=${chatId}`)}

BenBot
`,
  });
}

export async function videoReady(u: User, chatId: string, jobId: string) {
  await sendMail({
    to: u.email,
    subject: "Your epic video is done cooking",
    body: `${u.name},

It's done, and it's hype. Watch it here:
${url(`/in/${u.token}?chat=${chatId}`)}

Share it with anyone (this link doesn't sign them in as you):
${url(`/v/${jobId}`)}

BenBot
`,
  });
}

export async function videoFailed(u: User, chatId: string) {
  await sendMail({
    to: u.email,
    subject: "Your epic video blew up (not in the good way)",
    body: `${u.name},

Something broke while I was making your video, and Ben's been told. You didn't lose a generation for it.
Your chat is still here if you want to try again:
${url(`/in/${u.token}?chat=${chatId}`)}

BenBot
`,
  });
}
