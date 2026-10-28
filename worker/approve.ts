// Ben's decisions on the Video-inator, from a BenBot session:
//   node ~/Projects/videoinator/worker/approve.ts list
//   node ~/Projects/videoinator/worker/approve.ts approve <request id> [generations, default 5]
//   node ~/Projects/videoinator/worker/approve.ts deny <request id>
//   node ~/Projects/videoinator/worker/approve.ts credits <user id> <total generations>
import { get, post, type Request, type User } from "./site.ts";

const [cmd, id, n] = process.argv.slice(2);
if (cmd === "list") {
  const p = (await get<{ requests: Request[]; users: User[] }>("/pending"))!;
  console.log("pending requests:");
  for (const r of p.requests) console.log(`  ${r.id}  ${r.name} <${r.email}>  ${r.idea}`);
  console.log("users:");
  for (const u of p.users) console.log(`  ${u.id}  ${u.name} <${u.email}>  ${u.used}/${u.credits} used`);
} else if (cmd === "approve" && id) {
  console.log(JSON.stringify(await post(`/requests/${id}/approve`, { credits: n ? Number(n) : 5 })));
} else if (cmd === "deny" && id) {
  console.log(JSON.stringify(await post(`/requests/${id}/deny`, {})));
} else if (cmd === "credits" && id && n) {
  console.log(JSON.stringify(await post(`/users/${id}/credits`, { credits: Number(n) })));
} else {
  console.error("usage: approve.ts list | approve <request> [n] | deny <request> | credits <user> <n>");
  process.exit(2);
}
