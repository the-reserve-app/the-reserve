/**
 * seed-demo — The Reserve as if it had been running since January 1 of
 * LAST year, on the LOCAL stack only (docs/demo.md). A spa with ten staff,
 * a real menu, a retail range, a few hundred clients, appointments and
 * sales from that day to today with a weekly rhythm, growth and seasonal
 * bumps, the next four weeks booked, and one demo owner login printed to
 * the terminal. Loads in about 16 seconds.
 *
 * Why local only: the hosted ledger and audit log are append-only for
 * every role, so demo rows there could never be removed. requireLocalStack
 * refuses anything else.
 *
 * How the money is written: a history needs back-dated sales, and
 * write_ledger_transaction takes no created_at by design — so history is
 * inserted on the direct connection with every ledger trigger ACTIVE
 * (balanced at commit by assert_ledger_transaction, line arithmetic
 * checked, one refund per original, gift-card balances and product stock
 * moved by their triggers). Today's sales go through
 * write_ledger_transaction, the app's own path. Both sets pass the same
 * checks; neither bypasses anything.
 *
 *   SUPABASE_LOCAL=true npm run seed:demo              create (refuses if a demo is already loaded)
 *   SUPABASE_LOCAL=true npm run seed:demo -- --clean    remove everything it created and prove nothing is left
 *
 * Everything created is recorded in node_modules/.cache/demo-seed.json and
 * carries a marker besides (staff emails @thereserve.demo, ledger keys
 * demo:…, clients referral_source 'Demo seed'), so --clean takes both.
 */
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { ROOT, get, guard, pgSsl, requireLocalStack, supabaseEnv } from "./_env.mjs";

guard(["NUXT_PUBLIC_SUPABASE_URL", "DATABASE_URL"]);
const { url, serviceKey } = supabaseEnv();
const dsn = get("DATABASE_URL");
requireLocalStack("the demo seed (writes two years of ledger and audit rows)", [url, dsn]);

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
const db = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) });
await db.connect();
const MANIFEST = `${ROOT}/node_modules/.cache/demo-seed.json`;
const CLEAN = process.argv.includes("--clean");
const STAFF_DOMAIN = "thereserve.demo";
const REFERRAL_MARK = "Demo seed";
const KEY_PREFIX = "demo:";

// ---------------------------------------------------------------- helpers
let seed = 20261008;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const weighted = (pairs) => { const total = pairs.reduce((a, [, w]) => a + w, 0); let r = rand() * total; for (const [x, w] of pairs) { r -= w; if (r <= 0) return x; } return pairs[pairs.length - 1][0]; };
const chance = (p) => rand() < p;
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));
const must = async (p, what) => { const { data, error } = await p; if (error) throw new Error(`${what}: ${error.message}`); return data; };
const DAY = 86_400_000;

/** The UTC instant of a wall-clock time in `zone`. */
function zoned(zone, y, m, d, hh = 0, mm = 0) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const read = (t) => { const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); };
  return new Date(guess - (read(guess) - guess));
}
/** The local calendar day of an instant in `zone`, as {y, m, d, dow}. */
function localDay(zone, t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(t).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
const key = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
async function insertMany(table, cols, rows, returning = "id") {
  const out = [];
  for (let at = 0; at < rows.length; at += 400) {
    const chunk = rows.slice(at, at + 400);
    const params = []; const tuples = chunk.map((r) => `(${cols.map((c) => { params.push(r[c] ?? null); return `$${params.length}`; }).join(",")})`);
    const { rows: got } = await db.query(`insert into ${table} (${cols.join(",")}) values ${tuples.join(",")} returning ${returning}`, params);
    out.push(...got);
  }
  return out;
}

// ---------------------------------------------------------------- the organisation as it is
const org = await must(admin.from("organizations").select("id, name, timezone").order("created_at").limit(1).single(), "organisation");
const location = await must(admin.from("locations").select("id, name, timezone, tax_rate_bps, business_hours").eq("organization_id", org.id).order("created_at").limit(1).single(), "location");
const ZONE = location.timezone;
const ORG = org.id, LOC = location.id;

// ================================================================= --clean
if (CLEAN) {
  if (!fs.existsSync(MANIFEST)) { console.error("No demo manifest found (node_modules/.cache/demo-seed.json); nothing to clean. A full `npx supabase db reset --local` also removes everything."); process.exit(1); }
  const m = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const counts = {};
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica"); // append-only tables and foreign keys: the one place, local only
    const q = async (name, sql, params) => { counts[name] = (await db.query(sql, params)).rowCount; };
    await q("payments", "delete from payments p using transactions t where p.transaction_id = t.id and t.idempotency_key like $1", [`${KEY_PREFIX}%`]);
    await q("lines", "delete from transaction_items i using transactions t where i.transaction_id = t.id and t.idempotency_key like $1", [`${KEY_PREFIX}%`]);
    await q("refunds", "delete from transactions where idempotency_key like $1 and refunds_transaction_id is not null", [`${KEY_PREFIX}%`]);
    await q("transactions", "delete from transactions where idempotency_key like $1", [`${KEY_PREFIX}%`]);
    await q("audit rows", "delete from audit_log where actor_staff_id = any($1::uuid[]) or (entity_type = 'staff' and entity_id = any($1::uuid[]))", [m.staff]);
    await q("cancellation tokens", "delete from cancellation_tokens where appointment_id = any($1::uuid[])", [m.appointments]);
    await q("appointment lines", "delete from appointment_services where appointment_id = any($1::uuid[])", [m.appointments]);
    await q("appointments", "delete from appointments where id = any($1::uuid[]) or staff_id = any($2::uuid[])", [m.appointments, m.staff]);
    await q("communications", "delete from communications_sent where client_id = any($1::uuid[])", [m.clients]);
    await q("client notes", "delete from client_notes where client_id = any($1::uuid[]) or author_id = any($2::uuid[])", [m.clients, m.staff]);
    await q("gift cards", "delete from gift_cards where id = any($1::uuid[])", [m.giftCards]);
    await q("clients", "delete from clients where id = any($1::uuid[]) or referral_source = $2", [m.clients, REFERRAL_MARK]);
    await q("products", "delete from products where id = any($1::uuid[])", [m.products]);
    await q("service requirements", "delete from service_resource_requirements where service_id = any($1::uuid[])", [m.services]);
    await q("service staff", "delete from service_staff where service_id = any($1::uuid[]) or staff_id = any($2::uuid[])", [m.services, m.staff]);
    await q("services", "delete from services where id = any($1::uuid[])", [m.services]);
    await q("service categories", "delete from service_categories where id = any($1::uuid[])", [m.categories]);
    await q("rooms", "delete from resources where id = any($1::uuid[])", [m.resources]);
    await q("room types", "delete from resource_types where id = any($1::uuid[])", [m.resourceTypes]);
    await q("hours", "delete from availability_rules where staff_id = any($1::uuid[])", [m.staff]);
    await q("time off", "delete from availability_exceptions where staff_id = any($1::uuid[])", [m.staff]);
    await q("notifications", "delete from notifications where staff_id = any($1::uuid[])", [m.staff]);
    await q("staff roles", "delete from staff_roles where staff_id = any($1::uuid[])", [m.staff]);
    await q("staff locations", "delete from staff_locations where staff_id = any($1::uuid[])", [m.staff]);
    await q("staff", "delete from staff where id = any($1::uuid[]) or email like $2", [m.staff, `%@${STAFF_DOMAIN}`]);
    await q("role permissions", "delete from role_permissions where role_id = $1", [m.role]);
    await q("role", "delete from roles where id = $1", [m.role]);
    await db.query("update locations set tax_rate_bps = $2, business_hours = $3 where id = $1", [LOC, m.location.tax_rate_bps, m.location.business_hours]);
    if (m.deactivated?.length) await db.query("update services set active = true where id = any($1::uuid[])", [m.deactivated]);
    await db.query("commit");
  } catch (e) { await db.query("rollback").catch(() => {}); console.error(`clean failed: ${e.message}`); process.exit(1); }
  let users = 0;
  for (const id of m.users) { const { error } = await admin.auth.admin.deleteUser(id); if (!error) users++; }
  counts["auth users"] = users;
  // Nothing left: every marker and every manifest id.
  const left = [];
  const probe = async (what, sql, params) => { const { rows } = await db.query(sql, params); if (rows[0].n) left.push(`${what}: ${rows[0].n}`); };
  await probe("demo transactions", "select count(*)::int n from transactions where idempotency_key like $1", [`${KEY_PREFIX}%`]);
  await probe("demo clients", "select count(*)::int n from clients where id = any($1::uuid[]) or referral_source = $2", [m.clients, REFERRAL_MARK]);
  await probe("demo staff", "select count(*)::int n from staff where id = any($1::uuid[]) or email like $2", [m.staff, `%@${STAFF_DOMAIN}`]);
  await probe("demo appointments", "select count(*)::int n from appointments where id = any($1::uuid[])", [m.appointments]);
  await probe("demo products", "select count(*)::int n from products where id = any($1::uuid[])", [m.products]);
  await probe("demo services", "select count(*)::int n from services where id = any($1::uuid[])", [m.services]);
  await probe("demo gift cards", "select count(*)::int n from gift_cards where id = any($1::uuid[])", [m.giftCards]);
  await probe("orphan appointment lines", "select count(*)::int n from appointment_services s where not exists (select 1 from appointments a where a.id = s.appointment_id)", []);
  await probe("orphan ledger lines", "select count(*)::int n from transaction_items i where not exists (select 1 from transactions t where t.id = i.transaction_id)", []);
  await db.end();
  console.log("Removed: " + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", "));
  if (left.length) { console.error("STILL PRESENT: " + left.join("; ")); process.exit(1); }
  fs.unlinkSync(MANIFEST);
  console.log("Nothing of the demo is left. (A full `npx supabase db reset --local` is the other way back.)");
  process.exit(0);
}

// ================================================================= create
if (fs.existsSync(MANIFEST)) { console.error("A demo is already loaded (node_modules/.cache/demo-seed.json). Run `npm run seed:demo -- --clean` first."); process.exit(1); }
const m = { staff: [], users: [], clients: [], services: [], categories: [], products: [], giftCards: [], appointments: [], resources: [], resourceTypes: [], role: null, location: { tax_rate_bps: location.tax_rate_bps, business_hours: location.business_hours }, deactivated: [] };
const save = () => { fs.mkdirSync(`${ROOT}/node_modules/.cache`, { recursive: true }); fs.writeFileSync(MANIFEST, JSON.stringify(m)); };
process.on("exit", save);

const now = new Date();
const today = localDay(ZONE, now);
// The history starts on January 1 of LAST year, so a year-over-year comparison
// has a whole previous year to compare with (a one-year history read
// "up 4475%" on the year view, 2026-10-08).
const HISTORY_START = zoned(ZONE, today.y - 1, 1, 1, 0, 0).getTime();
const HISTORY_DAYS = Math.round((now.getTime() - HISTORY_START) / DAY);
console.log(`\nseed-demo — ${org.name} at ${location.name} (${ZONE}); today is ${key(today)}\n`);

// ---- the migrations' "[EXAMPLE]" services: out of the menu for the demo, back at cleanup
const examples = await must(admin.from("services").select("id").eq("organization_id", ORG).like("name", "[EXAMPLE]%").eq("active", true), "example services");
for (const e of examples) { await must(admin.from("services").update({ active: false }).eq("id", e.id), "deactivate example"); m.deactivated.push(e.id); }

// ---- the location: a tax rate and hours
await db.query("update locations set tax_rate_bps = 875, business_hours = $2 where id = $1", [LOC, JSON.stringify({ mon: ["09:00", "19:00"], tue: ["09:00", "19:00"], wed: ["09:00", "19:00"], thu: ["09:00", "20:00"], fri: ["09:00", "20:00"], sat: ["08:00", "18:00"], sun: ["10:00", "17:00"] })]);
const TAX_BPS = 875;

// ---- the demo owner's role: every permission, not a system role (no last-super-admin trigger on it)
const roleRow = await must(admin.from("roles").insert({ organization_id: ORG, name: "Owner", is_system: false }).select("id").single(), "owner role");
m.role = roleRow.id;
const perms = await must(admin.from("permissions").select("key"), "permissions");
await must(admin.from("role_permissions").insert(perms.map((p) => ({ role_id: m.role, permission_key: p.key }))), "owner permissions");
const roles = Object.fromEntries((await must(admin.from("roles").select("id, name").eq("organization_id", ORG), "roles")).map((r) => [r.name, r.id]));

// ---- staff
const STAFF = [
  { name: "Avery Lane", title: "Owner", role: "Owner", bookable: false, login: true },
  { name: "Priya Natarajan", title: "Spa Manager", role: "admin", bookable: false },
  { name: "Marcus Bell", title: "Front Desk Lead", role: "front_desk", bookable: false },
  { name: "Sofia Reyes", title: "Front Desk", role: "front_desk", bookable: false },
  { name: "Elena Marsh", title: "Massage Therapist", role: "provider", bookable: true, hours: { days: [2, 3, 4, 5, 6], start: "09:00", end: "17:00" }, skills: ["massage"] },
  { name: "Daniel Okafor", title: "Massage Therapist", role: "provider", bookable: true, hours: { days: [3, 4, 5, 6, 0], start: "10:00", end: "18:00" }, skills: ["massage"] },
  { name: "Hana Kobayashi", title: "Lead Esthetician", role: "provider", bookable: true, hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }, skills: ["facial", "body"] },
  { name: "Lucas Moreau", title: "Esthetician", role: "provider", bookable: true, hours: { days: [2, 3, 4, 5, 6], start: "11:00", end: "19:00" }, skills: ["facial"] },
  { name: "Imani Carter", title: "Body Treatment Specialist", role: "provider", bookable: true, hours: { days: [4, 5, 6, 0], start: "09:00", end: "17:00" }, skills: ["body", "massage"] },
  { name: "Theo Lindqvist", title: "Massage Therapist", role: "provider", bookable: true, hours: { days: [1, 2, 5, 6, 0], start: "10:00", end: "18:00" }, skills: ["massage"] },
];
const COLORS = ["#7c3aed", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#f97316", "#6366f1", "#ec4899"];
const staff = [];
let demoLogin = null;
for (const [i, s] of STAFF.entries()) {
  const email = `${s.name.toLowerCase().replace(/[^a-z]+/g, ".")}@${STAFF_DOMAIN}`;
  let user_id = null;
  if (s.login) {
    const password = `demo-${randomBytes(9).toString("base64url")}`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw new Error(`demo login: ${error.message}`);
    user_id = data.user.id; m.users.push(user_id); demoLogin = { email, password };
  }
  const hired = new Date(now.getTime() - between(400, 1500) * DAY);
  const row = await must(admin.from("staff").insert({ organization_id: ORG, user_id, display_name: s.name, email, title: s.title, color: COLORS[i], bookable: s.bookable, active: true, hired_at: hired.toISOString().slice(0, 10), phone: `(415) 555-01${String(10 + i).padStart(2, "0")}` }).select("id").single(), `staff ${s.name}`);
  m.staff.push(row.id);
  await must(admin.from("staff_roles").insert({ staff_id: row.id, role_id: s.role === "Owner" ? m.role : roles[s.role] }), `role ${s.name}`);
  await must(admin.from("staff_locations").insert({ staff_id: row.id, location_id: LOC }), `location ${s.name}`);
  staff.push({ ...s, id: row.id });
}
const providers = staff.filter((s) => s.bookable);
const desk = staff.filter((s) => s.role === "front_desk");
save();
// Hours: valid from the start of the history.
const start = localDay(ZONE, new Date(HISTORY_START));
const hoursRows = [];
for (const p of providers) for (const dow of p.hours.days) hoursRows.push({ staff_id: p.id, location_id: LOC, day_of_week: dow, start_time: p.hours.start, end_time: p.hours.end, valid_from: key(start) });
await insertMany("availability_rules", ["staff_id", "location_id", "day_of_week", "start_time", "end_time", "valid_from"], hoursRows);

// ---- rooms
const roomType = await must(admin.from("resource_types").insert({ organization_id: ORG, name: "Treatment room" }).select("id").single(), "room type");
m.resourceTypes.push(roomType.id);
for (const name of ["Room 1 — Sage", "Room 2 — Cedar", "Room 3 — Lotus", "Couples Suite"]) {
  const r = await must(admin.from("resources").insert({ location_id: LOC, resource_type_id: roomType.id, name }).select("id").single(), name);
  m.resources.push(r.id);
}

// ---- the menu
const MENU = [
  ["Massage", [
    ["Swedish Massage 60", 60, 13_000, "massage", 10], ["Swedish Massage 90", 90, 18_500, "massage", 6],
    ["Deep Tissue 60", 60, 14_500, "massage", 8], ["Deep Tissue 90", 90, 20_000, "massage", 4],
    ["Hot Stone Massage", 75, 17_500, "massage", 4], ["Prenatal Massage", 60, 14_000, "massage", 2],
  ]],
  ["Facials", [
    ["Signature Facial", 60, 14_000, "facial", 8], ["HydraGlow Facial", 50, 17_500, "facial", 6],
    ["Age-Defying Facial", 75, 19_500, "facial", 3], ["Express Facial", 30, 8_500, "facial", 4],
  ]],
  ["Body Treatments", [
    ["Sea Salt Body Scrub", 45, 11_500, "body", 3], ["Detox Body Wrap", 60, 15_500, "body", 2],
    ["Scrub + Wrap Ritual", 90, 23_000, "body", 1],
  ]],
];
const services = [];
for (const [i, [catName, items]] of MENU.entries()) {
  // The migrations seed a few categories by name; reuse one that exists (and leave it at cleanup), make the rest.
  const existing = await must(admin.from("service_categories").select("id").eq("organization_id", ORG).eq("name", catName).maybeSingle(), catName);
  const cat = existing ?? (await must(admin.from("service_categories").insert({ organization_id: ORG, name: catName, sort_order: i }).select("id").single(), catName));
  if (!existing) m.categories.push(cat.id);
  for (const [name, minutes, price, skill, weight] of items) {
    const row = await must(admin.from("services").insert({ organization_id: ORG, category_id: cat.id, name, duration_minutes: minutes, buffer_before_min: 0, buffer_after_min: 15, price_cents: price, requires_intake: false, description: `${name.split(" — ")[0]}, ${minutes} minutes.` }).select("id").single(), name);
    m.services.push(row.id);
    const qualified = providers.filter((p) => p.skills.includes(skill));
    await must(admin.from("service_staff").insert(qualified.map((p) => ({ service_id: row.id, staff_id: p.id }))), `staff for ${name}`);
    services.push({ id: row.id, name, minutes, price, skill, weight, staff: qualified });
  }
}
save();

// ---- the retail range (stock set after the year's sales are known)
const RETAIL = [
  ["Verdant Botanical Face Oil", "VB-OIL-30", 6_800, 2_900, 14], ["Verdant Gentle Cleanser", "VB-CLN-150", 3_400, 1_300, 22],
  ["Verdant Daily SPF 30", "VB-SPF-50", 4_200, 1_700, 18], ["Verdant Night Repair Cream", "VB-NGT-50", 7_900, 3_200, 9],
  ["Verdant Vitamin C Serum", "VB-VTC-30", 8_600, 3_500, 11], ["Reserve Signature Candle", "RS-CND-01", 3_800, 1_400, 20],
  ["Reserve Bath Salts — Lavender", "RS-SLT-LV", 2_600, 900, 26], ["Reserve Bath Salts — Eucalyptus", "RS-SLT-EU", 2_600, 900, 0],
  ["Muscle Recovery Balm", "RS-BLM-60", 2_900, 1_100, 3], ["Silk Sleep Mask", "RS-MSK-01", 2_400, 800, 2],
  ["Linen Robe — M", "RS-ROB-M", 12_000, 5_500, 5], ["Linen Robe — L", "RS-ROB-L", 12_000, 5_500, 0],
  ["Jade Facial Roller", "RS-JDR-01", 3_200, 1_000, 7], ["Dry Body Brush", "RS-BRS-01", 1_800, 600, 16],
  ["Hydrating Sheet Masks (5)", "VB-MSK-05", 2_500, 900, 30], ["Lip Treatment Balm", "VB-LIP-10", 1_600, 500, 24],
  ["Gift Box — Calm Evening", "RS-GFT-01", 9_500, 4_200, 4], ["Aromatherapy Roller — Sleep", "RS-ARM-SL", 1_900, 600, 12],
];
const products = RETAIL.map(([name, sku, price, cost, finalStock]) => ({ name, sku, price, cost, finalStock, sold: 0 }));

// ---- clients: fictional names, varied habits
const FIRST = ["Maya", "Olivia", "Noah", "Liam", "Emma", "Ava", "Sophia", "Isabella", "Mia", "Charlotte", "Amelia", "Harper", "Evelyn", "Abigail", "Ethan", "James", "Benjamin", "Lucas", "Henry", "Alexander", "Grace", "Chloe", "Zoe", "Nora", "Lily", "Hannah", "Layla", "Riley", "Aria", "Ellie", "Jackson", "Aiden", "Sebastian", "Mateo", "Jack", "Owen", "Leo", "Julian", "Wyatt", "Luca", "Priya", "Aisha", "Yuki", "Mei", "Sana", "Ines", "Camila", "Valentina", "Freya", "Elif", "Omar", "Kenji", "Rafael", "Idris", "Mateus", "Tomas", "Elias", "Jonas", "Felix", "Arjun"];
const LAST = ["Hartwell", "Okonjo", "Brennan", "Castillo", "Delacroix", "Fairbanks", "Ghosh", "Halvorsen", "Ibarra", "Jansen", "Kowalski", "Lindgren", "Matsuda", "Nakamura", "Oyelaran", "Petrov", "Quintana", "Rasmussen", "Santoro", "Takahashi", "Underwood", "Vasquez", "Whitfield", "Xiang", "Yilmaz", "Zielinski", "Abernathy", "Blackwood", "Calloway", "Dunmore", "Everly", "Fontaine", "Greenwood", "Holloway", "Ivers", "Jennings", "Kingsley", "Lockhart", "Marlow", "Northcott", "Oakes", "Pemberton", "Rowan", "Sinclair", "Thornbury", "Vance", "Westbrook", "Yardley", "Adeyemi", "Bergström", "Caruso", "Dastagir", "Eriksen", "Farahani", "Gallagher", "Haddad", "Iwasaki", "Joshi", "Karlsson", "Lefebvre", "Mbeki", "Nascimento", "Oduya", "Papadopoulos", "Ramírez", "Schreiber", "Tanaka", "Uriarte", "Villanueva", "Weiss", "Yamamoto", "Zhang", "Ahmadi", "Bianchi", "Chowdhury", "Duarte", "Esposito", "Ferreira", "Gruber", "Hoffmann", "Ishikawa", "Jiménez", "Kaur", "Larsen", "Moreno", "Novak", "Ortega", "Pereira", "Rahman", "Sørensen", "Toledo", "Varga", "Wagner", "Yoon", "Zuniga"];
const REFERRALS = ["Friend", "Instagram", "Website", "Walk-in", "Google", "Gift card"];
const clients = [];
const clientRows = [];
const usedNames = new Set();
for (let i = 0; i < 420; i++) {
  let first = pick(FIRST), last = pick(LAST);
  while (usedNames.has(`${first} ${last}`)) { first = pick(FIRST); last = pick(LAST); }
  usedNames.add(`${first} ${last}`);
  const habit = weighted([["regular", 15], ["occasional", 45], ["once", 40]]);
  const firstVisitDaysAgo = habit === "regular" ? between(200, HISTORY_DAYS) : between(5, HISTORY_DAYS);
  clientRows.push({
    organization_id: ORG, first_name: first, last_name: last,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`, phone: `(415) 555-0${String(100 + (i % 900)).padStart(3, "0")}`,
    date_of_birth: chance(0.6) ? `${between(1958, 2002)}-${String(between(1, 12)).padStart(2, "0")}-${String(between(1, 28)).padStart(2, "0")}` : null,
    referral_source: REFERRAL_MARK, pronouns: chance(0.3) ? pick(["she/her", "he/him", "they/them"]) : null,
    marketing_opt_in: chance(0.55), communication_channel: "email", preferred_contact_method: pick(["email", "sms", "email"]),
    created_at: new Date(now.getTime() - firstVisitDaysAgo * DAY).toISOString(),
  });
  clients.push({ first, last, habit, firstVisit: now.getTime() - firstVisitDaysAgo * DAY, preferred: chance(0.4) ? pick(providers) : null, visits: 0, noShows: 0 });
}
const clientIds = await insertMany("clients", ["organization_id", "first_name", "last_name", "email", "phone", "date_of_birth", "referral_source", "pronouns", "marketing_opt_in", "communication_channel", "preferred_contact_method", "created_at"], clientRows);
clientIds.forEach((r, i) => { clients[i].id = r.id; m.clients.push(r.id); });
for (const c of clients) if (c.preferred) await db.query("update clients set preferred_staff_id = $2 where id = $1", [c.id, c.preferred.id]);
save();
// A few notes.
const NOTES = [["preference", "Prefers firm pressure; no scented oils."], ["preference", "Likes the room warm and quiet music."], ["internal", "Regular — books the same Saturday slot each month."], ["preference", "Allergic to lavender; use unscented products."], ["internal", "Gift card from their partner; expiring soon."], ["preference", "Prefers a female therapist."]];
const noteRows = [];
for (const c of clients) if (chance(0.18)) { const [kind, body] = pick(NOTES); noteRows.push({ client_id: c.id, author_id: pick(desk).id, kind, body, created_at: new Date(c.firstVisit + between(0, 30) * DAY).toISOString() }); }
await insertMany("client_notes", ["client_id", "author_id", "kind", "body", "created_at"], noteRows);

// ---- the year: demand by day
const demandFor = (day, t) => {
  const fraction = (t - HISTORY_START) / (HISTORY_DAYS * DAY); // 0 at the start of the history, 1 today
  let base = 16 + 11 * fraction; // growth: ~16 a day at the start → ~27 now
  base *= [0.75, 0.7, 0.9, 0.95, 1.05, 1.25, 1.5][day.dow];
  const md = `${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
  if (md >= "12-10" && md <= "12-23") base *= 1.3;
  if (md >= "12-24" && md <= "12-26") base *= 0.25;
  if (md === "01-01") base *= 0.2;
  if (md >= "01-03" && md <= "01-20") base *= 0.8;
  if (md >= "02-07" && md <= "02-14") base *= 1.35;
  if (md >= "05-04" && md <= "05-10") base *= 1.3;
  if (md >= "08-01" && md <= "08-31") base *= 0.9;
  return base;
};
// A day with nobody registered yet (the first days of the year, depending on the
// draw) is served by the earliest-registered clients: the pool is never empty.
const earliest = [...clients].sort((a, b) => a.firstVisit - b.firstVisit).slice(0, 20);
const pickClient = (t, taken = new Set()) => { let pool = clients.filter((c) => c.firstVisit <= t + DAY && !taken.has(c)); if (!pool.length) pool = earliest.filter((c) => !taken.has(c)); if (!pool.length) pool = earliest; return weighted(pool.map((c) => [c, c.habit === "regular" ? 8 : c.habit === "occasional" ? 2 : c.visits === 0 ? 1 : 0.05])); };

const appts = []; // { client, provider, service, startsAt, endsAt, blockedUntil, status, when:'past'|'future', day }
const dayStart = HISTORY_START, dayEnd = now.getTime() + 27 * DAY;
for (let t = dayStart; t <= dayEnd; t += DAY) {
  const day = localDay(ZONE, new Date(t));
  const future = t >= now.getTime() - DAY / 2 && key(day) > key(today);
  const isToday = key(day) === key(today);
  const daysAhead = Math.round((t - now.getTime()) / DAY);
  const fill = !future ? 1 : daysAhead <= 10 ? 1 : daysAhead <= 20 ? 0.85 : 0.6; // the next ten days are full; further out, still filling
  const target = future ? demandFor(day, now.getTime()) * fill : demandFor(day, t);
  const working = providers.filter((p) => p.hours.days.includes(day.dow));
  if (!working.length) continue;
  const perProvider = target / working.length;
  const taken = new Set(); // a client comes once a day
  for (const p of working) {
    const [sh, sm] = p.hours.start.split(":").map(Number), [eh, em] = p.hours.end.split(":").map(Number);
    let cursor = zoned(ZONE, day.y, day.m, day.d, sh, sm).getTime();
    const close = zoned(ZONE, day.y, day.m, day.d, eh, em).getTime();
    const want = Math.max(0, Math.round(perProvider + (rand() - 0.5) * 2));
    let made = 0;
    while (made < want && cursor < close) {
      const service = weighted(services.filter((s) => s.staff.includes(p)).map((s) => [s, s.weight]));
      const startsAt = cursor; const endsAt = startsAt + service.minutes * 60_000; const blockedUntil = endsAt + 15 * 60_000;
      if (endsAt > close) break;
      let status = "booked";
      if (!future && !isToday) status = weighted([["completed", 90], ["cancelled", 8], ["no_show", 2]]);
      else if (isToday) status = startsAt < now.getTime() ? weighted([["completed", 85], ["no_show", 5], ["cancelled", 10]]) : weighted([["booked", 70], ["confirmed", 30]]);
      else status = weighted([["booked", 70], ["confirmed", 30]]);
      const client = pickClient(startsAt, taken);
      taken.add(client);
      client.visits++;
      appts.push({ client, provider: p, service, startsAt, endsAt, blockedUntil, status, future, day, late: status === "cancelled" && chance(0.15) });
      made++;
      cursor = blockedUntil + weighted([[0, 50], [15 * 60_000, 30], [45 * 60_000, 20]]);
    }
  }
}
console.log(`appointments planned: ${appts.length} (${appts.filter((a) => a.future).length} upcoming)`);
const apptRows = appts.map((a) => ({ organization_id: ORG, location_id: LOC, client_id: a.client.id, staff_id: a.provider.id, blocked_from: new Date(a.startsAt).toISOString(), blocked_until: new Date(a.blockedUntil).toISOString(), starts_at: new Date(a.startsAt).toISOString(), ends_at: new Date(a.endsAt).toISOString(), status: a.status, booked_by: pick(desk).id, cancelled_at: a.status === "cancelled" ? new Date(a.startsAt - (a.late ? 3 : 48) * 3_600_000).toISOString() : null, cancel_reason: a.status === "cancelled" ? (a.late ? "client_via_link" : "client_request") : null, created_at: new Date(a.startsAt - between(2, 21) * DAY).toISOString() }));
const apptIds = await insertMany("appointments", ["organization_id", "location_id", "client_id", "staff_id", "blocked_from", "blocked_until", "starts_at", "ends_at", "status", "booked_by", "cancelled_at", "cancel_reason", "created_at"], apptRows);
apptIds.forEach((r, i) => { appts[i].id = r.id; m.appointments.push(r.id); });
await insertMany("appointment_services", ["appointment_id", "service_id", "name_snapshot", "price_cents", "duration_min"], appts.map((a) => ({ appointment_id: a.id, service_id: a.service.id, name_snapshot: a.service.name, price_cents: a.service.price, duration_min: a.service.minutes })), "appointment_id");
// Cancel tokens for the upcoming ones (the booking route would have minted them).
await insertMany("cancellation_tokens", ["organization_id", "appointment_id", "expires_at"], appts.filter((a) => a.future).map((a) => ({ organization_id: ORG, appointment_id: a.id, expires_at: new Date(a.endsAt + DAY).toISOString() })));
for (const c of clients) c.noShows = appts.filter((a) => a.client === c && a.status === "no_show").length;
for (const c of clients) if (c.noShows) await db.query("update clients set no_show_count = $2 where id = $1", [c.id, c.noShows]);
save();

// ---- the sales: plan, then insert with the triggers active
const sales = []; // { at, client, appointment?, lines:[{kind, name, unit, qty, taxable, staff, product, giftCard}], tip, discount, payments:[{method, amount, giftCard, ref}], key }
const giftCards = []; // { code, balance, initial, purchaser, soldAt, id? }
const code = () => Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(rand() * 32)]).join("")).join("-");
let keyN = 0;
const RECENT = now.getTime() - 2 * 3_600_000;
const viaFunction = (a) => key(a.day) === key(today) && a.status === "completed" && a.endsAt >= RECENT;
const past = appts.filter((a) => !a.future && (a.status === "completed" || a.late) && !viaFunction(a));
for (const a of past) {
  if (a.late) { // late cancellation: the fee, charged to a card
    sales.push({ at: a.startsAt - 3 * 3_600_000 + 60_000, client: a.client, appointment: a, lines: [{ kind: "late_cancellation_fee", name: `Late cancellation fee (${a.service.name})`, unit: 5_000, qty: 1, taxable: false, staff: null }], tip: 0, discount: 0, payments: [{ method: "card_external", amount: 5_000, ref: null }], key: `${KEY_PREFIX}fee:${keyN++}` });
    continue;
  }
  const lines = [{ kind: "service", name: a.service.name, unit: a.service.price, qty: 1, taxable: false, staff: a.provider, appointment: a }];
  if (chance(0.25)) { const n = chance(0.75) ? 1 : 2; for (let i = 0; i < n; i++) { const pr = pick(products); pr.sold++; lines.push({ kind: "product", name: pr.name, unit: pr.price, qty: 1, taxable: true, product: pr }); } }
  const subtotal = lines.reduce((s, l) => s + l.unit * l.qty, 0);
  const discount = chance(0.08) ? Math.round(a.service.price * 0.1) : 0;
  const tax = lines.filter((l) => l.taxable).reduce((s, l) => s + Math.round(l.unit * l.qty * TAX_BPS / 10_000), 0);
  const tip = chance(0.62) ? Math.round(a.service.price * pick([0.15, 0.18, 0.2, 0.2, 0.22])) : 0;
  const total = subtotal - discount + tax + tip;
  const payments = [];
  const card = giftCards.find((g) => g.balance > 0 && g.redeemAt && g.redeemAt <= a.endsAt && g.purchaser !== a.client) ?? null;
  let remaining = total;
  if (card) { const use = Math.min(card.balance, remaining); payments.push({ method: "gift_card", amount: use, giftCard: card }); card.balance -= use; remaining -= use; card.redeemAt = card.balance > 0 && chance(0.5) ? a.endsAt + between(20, 90) * DAY : null; }
  if (remaining > 0) payments.push({ method: weighted([["card_external", 78], ["cash", 22]]), amount: remaining, ref: chance(0.5) ? `AUTH-${between(100000, 999999)}` : null });
  const sale = { at: a.endsAt + between(2, 12) * 60_000, client: a.client, appointment: a, lines, tip, discount, tax, payments, key: `${KEY_PREFIX}sale:${keyN++}` };
  if (chance(0.015)) { // a gift card sold at the desk with this visit
    const g = { code: code(), initial: pick([5_000, 10_000, 10_000, 15_000, 20_000, 25_000]), purchaser: a.client, soldAt: sale.at, recipient: `${pick(FIRST)} ${pick(LAST)}` }; g.balance = g.initial; g.redeemAt = chance(0.66) ? sale.at + between(10, 120) * DAY : null; giftCards.push(g);
    sale.lines.push({ kind: "gift_card", name: `Gift card for ${g.recipient}`, unit: g.initial, qty: 1, taxable: false, giftCard: g });
    const last = sale.payments[sale.payments.length - 1]; if (last && last.method !== "gift_card") last.amount += g.initial; else sale.payments.push({ method: "card_external", amount: g.initial, ref: null });
  }
  sales.push(sale);
}
// Walk-in retail, about two a day.
for (let t = dayStart; t < now.getTime() - DAY; t += DAY) {
  const day = localDay(ZONE, new Date(t));
  for (let i = 0; i < between(1, 3); i++) {
    const pr = pick(products); pr.sold++;
    const unit = pr.price, tax = Math.round(unit * TAX_BPS / 10_000);
    sales.push({ at: zoned(ZONE, day.y, day.m, day.d, between(10, 17), between(0, 59)).getTime(), client: chance(0.6) ? pickClient(t) : null, lines: [{ kind: "product", name: pr.name, unit, qty: 1, taxable: true, product: pr }], tip: 0, discount: 0, tax, payments: [{ method: weighted([["card_external", 70], ["cash", 30]]), amount: unit + tax, ref: null }], key: `${KEY_PREFIX}retail:${keyN++}` });
  }
}
sales.sort((x, y) => x.at - y.at);
// Products now, with stock = what is left after the year's sales.
const productIds = await insertMany("products", ["organization_id", "name", "sku", "price_cents", "cost_cents", "stock_quantity", "taxable", "description"], products.map((p) => ({ organization_id: ORG, name: p.name, sku: p.sku, price_cents: p.price, cost_cents: p.cost, stock_quantity: p.finalStock + p.sold, taxable: true, description: null })));
productIds.forEach((r, i) => { products[i].id = r.id; m.products.push(r.id); });
save();

// Insert, one transaction per sale, triggers active (balanced at commit).
const cashierFor = (t) => pick(desk).id;
async function writeSale(s) {
  const saleLines = s.lines.reduce((x, l) => x + l.unit * l.qty, 0);
  const tax = s.tax ?? 0, tip = s.tip ?? 0, discount = s.discount ?? 0;
  const total = saleLines - discount + tax + tip;
  await db.query("begin");
  try {
    for (const l of s.lines) if (l.kind === "gift_card" && !l.giftCard.id) {
      const { rows } = await db.query("insert into gift_cards (organization_id, code, initial_balance_cents, balance_cents, purchaser_client_id, recipient_name, created_at) values ($1,$2,$3,$3,$4,$5,$6) returning id", [ORG, l.giftCard.code, l.giftCard.initial, l.giftCard.purchaser?.id ?? null, l.giftCard.recipient, new Date(s.at).toISOString()]);
      l.giftCard.id = rows[0].id; m.giftCards.push(rows[0].id);
    }
    const { rows: [t] } = await db.query(
      "insert into transactions (organization_id, location_id, client_id, appointment_id, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, checked_out_by, created_at, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id",
      [ORG, LOC, s.client?.id ?? null, s.appointment?.id ?? null, saleLines, discount, tax, tip, total, cashierFor(s.at), new Date(s.at).toISOString(), s.key],
    );
    const lineRows = s.lines.map((l) => ({ transaction_id: t.id, organization_id: ORG, kind: l.kind, appointment_id: l.appointment?.id ?? null, product_id: l.product?.id ?? null, gift_card_id: l.giftCard?.id ?? null, staff_id: l.staff?.id ?? null, name_snapshot: l.name, quantity: l.qty, unit_price_cents: l.unit, taxable: l.taxable, tax_cents: l.taxable ? Math.round(l.unit * l.qty * TAX_BPS / 10_000) : 0, total_cents: l.unit * l.qty, discount_reason: null }));
    if (discount) lineRows.push({ transaction_id: t.id, organization_id: ORG, kind: "discount", appointment_id: null, product_id: null, gift_card_id: null, staff_id: null, name_snapshot: "Member discount (10%)", quantity: 1, unit_price_cents: -discount, taxable: false, tax_cents: 0, total_cents: -discount, discount_reason: "Member" });
    if (tip) lineRows.push({ transaction_id: t.id, organization_id: ORG, kind: "tip", appointment_id: null, product_id: null, gift_card_id: null, staff_id: s.appointment?.provider.id ?? null, name_snapshot: "Gratuity", quantity: 1, unit_price_cents: tip, taxable: false, tax_cents: 0, total_cents: tip, discount_reason: null });
    await insertMany("transaction_items", ["transaction_id", "organization_id", "kind", "appointment_id", "product_id", "gift_card_id", "staff_id", "name_snapshot", "quantity", "unit_price_cents", "taxable", "tax_cents", "total_cents", "discount_reason"], lineRows);
    await insertMany("payments", ["transaction_id", "organization_id", "method", "amount_cents", "gift_card_id", "reference", "created_at"], s.payments.map((p) => ({ transaction_id: t.id, organization_id: ORG, method: p.method, amount_cents: p.amount, gift_card_id: p.giftCard?.id ?? null, reference: p.ref ?? null, created_at: new Date(s.at).toISOString() })));
    await db.query("commit");
    s.id = t.id; s.total = total;
  } catch (e) { await db.query("rollback").catch(() => {}); throw new Error(`sale ${s.key}: ${e.message}`); }
}
let written = 0;
for (const s of sales) { await writeSale(s); if (++written % 500 === 0) process.stdout.write(`\rsales ${written} / ${sales.length}`); }
console.log(`\rsales written: ${written} (${sales.filter((s) => s.key.startsWith(KEY_PREFIX + "fee")).length} late-cancellation fees, ${giftCards.length} gift cards sold)`);

// A handful of refunds: exact mirrors, days later.
const refundable = sales.filter((s) => s.appointment && s.appointment.status === "completed" && !s.lines.some((l) => l.kind === "gift_card") && !s.payments.some((p) => p.method === "gift_card") && s.at < now.getTime() - 7 * DAY);
let refunds = 0;
for (const s of refundable.filter(() => chance(0.0012)).slice(0, 8)) {
  const at = s.at + between(1, 5) * DAY;
  await db.query("begin");
  try {
    const { rows: [h] } = await db.query("select * from transactions where id = $1", [s.id]);
    const { rows: [r] } = await db.query("insert into transactions (organization_id, location_id, client_id, appointment_id, refunds_transaction_id, subtotal_cents, discount_cents, tax_cents, tip_cents, total_cents, checked_out_by, note, created_at, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id", [ORG, LOC, h.client_id, h.appointment_id, s.id, -h.subtotal_cents, -h.discount_cents, -h.tax_cents, -h.tip_cents, -h.total_cents, h.checked_out_by, "Refunded at the client's request", new Date(at).toISOString(), `${KEY_PREFIX}refund:${s.id}`]);
    await db.query("insert into transaction_items (transaction_id, organization_id, kind, appointment_id, product_id, gift_card_id, staff_id, name_snapshot, quantity, unit_price_cents, taxable, tax_cents, total_cents, discount_reason) select $2, organization_id, kind, appointment_id, product_id, gift_card_id, staff_id, 'Refund — ' || name_snapshot, quantity, -unit_price_cents, taxable, -tax_cents, -total_cents, discount_reason from transaction_items where transaction_id = $1", [s.id, r.id]);
    await db.query("insert into payments (transaction_id, organization_id, method, amount_cents, gift_card_id, reference, created_at) select $2, organization_id, method, -amount_cents, gift_card_id, case when reference is null then null else 'refund: ' || reference end, $3 from payments where transaction_id = $1", [s.id, r.id, new Date(at).toISOString()]);
    await db.query("commit"); refunds++;
  } catch (e) { await db.query("rollback").catch(() => {}); throw new Error(`refund of ${s.key}: ${e.message}`); }
}
console.log(`refunds: ${refunds}`);

// Today's sales through the app's own writer, write_ledger_transaction.
let todays = 0;
for (const a of appts.filter(viaFunction)) {
  const tip = chance(0.6) ? Math.round(a.service.price * 0.18) : 0;
  const { error } = await admin.rpc("write_ledger_transaction", {
    p_organization_id: ORG, p_idempotency_key: `${KEY_PREFIX}today:${keyN++}`,
    p_header: { location_id: LOC, client_id: a.client.id, appointment_id: a.id, refunds_transaction_id: null, subtotal_cents: a.service.price, discount_cents: 0, tax_cents: 0, tip_cents: tip, total_cents: a.service.price + tip, checked_out_by: desk[0].id, note: null },
    p_items: [{ kind: "service", appointment_id: a.id, staff_id: a.provider.id, name_snapshot: a.service.name, quantity: 1, unit_price_cents: a.service.price, taxable: false, tax_cents: 0, total_cents: a.service.price }, ...(tip ? [{ kind: "tip", staff_id: a.provider.id, name_snapshot: "Gratuity", quantity: 1, unit_price_cents: tip, taxable: false, tax_cents: 0, total_cents: tip }] : [])],
    p_payments: [{ method: "card_external", amount_cents: a.service.price + tip, reference: `AUTH-${between(100000, 999999)}` }],
  });
  if (error) throw new Error(`today's sale through write_ledger_transaction: ${error.message}`);
  todays++;
}
console.log(`today's sales through write_ledger_transaction: ${todays}`);
save();
await db.end();

const { rows: [tot] } = await (async () => { const c = new pg.Client({ connectionString: dsn, ssl: pgSsl(dsn) }); await c.connect(); const r = await c.query("select count(*)::int as sales, sum(total_cents)::bigint as cents from transactions where idempotency_key like $1 and refunds_transaction_id is null", [`${KEY_PREFIX}%`]); await c.end(); return r; })();
console.log(`\nThe Reserve since ${key(start)} (${HISTORY_DAYS} days): ${m.staff.length} staff, ${services.length} services, ${products.length} products, ${clients.length} clients, ${appts.length} appointments, ${tot.sales} sales totalling $${(Number(tot.cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}.`);
console.log(`\nDemo login (printed here only; not stored anywhere else):\n  email     ${demoLogin.email}\n  password  ${demoLogin.password}\n`);
console.log("Remove with: SUPABASE_LOCAL=true npm run seed:demo -- --clean");
