/**
 * DEMO IMAGES — gives every DEV merchant a real logo and every voucher a real
 * cover photo, then uploads them to the public R2 logo bucket and points
 * merchant.logoUrl / voucher.coverImageUrl at the uploaded objects.
 *
 * Logos  : monogram PNG (brand-colored) from ui-avatars.com
 * Covers : context-relevant photo (Unsplash curated IDs, loremflickr fallback)
 *
 * Idempotent: re-running just re-uploads and re-points to the same keys.
 * SAFETY: refuses to run against anything that is not the DEV project / localhost.
 *
 * Usage:  npx tsx scripts/set-demo-images.ts     (from /backend)
 */
import "dotenv/config";
import { prisma } from "../src/db.js";
import { uploadFile } from "../src/services/r2.js";

const url = process.env.DATABASE_URL ?? "";
if (!/ulncvbzreqtrfbkfrjrh|localhost|127\.0\.0\.1/.test(url)) {
  throw new Error("SAFETY: this script only runs against the DEV project or localhost");
}

const BUCKET = process.env.R2_LOGO_BUCKET_NAME!;
const PUBLIC_BASE = (process.env.R2_LOGO_PUBLIC_URL ?? "").replace(/\/$/, "");
if (!BUCKET || !PUBLIC_BASE) throw new Error("R2_LOGO_BUCKET_NAME / R2_LOGO_PUBLIC_URL missing");

// Brand-ish accent colours (hex w/o #) keyed by merchant name substring.
const BRAND_COLORS: [RegExp, string][] = [
  [/kopi kenangan/i, "3B2A20"],
  [/fore/i, "1F6F54"],
  [/sportstation/i, "E4002B"],
  [/alfamart/i, "ED1C24"],
  [/cgv/i, "C4161C"],
  [/chatime/i, "7A3B9A"],
  [/pekangembiraria/i, "0F766E"],
];

function colorFor(name: string): string {
  for (const [re, c] of BRAND_COLORS) if (re.test(name)) return c;
  // deterministic fallback colour from the name
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) & 0xffffff;
  return h.toString(16).padStart(6, "0");
}

function initials(name: string): string {
  const clean = name.replace(/\(demo\)/i, "").replace(/[^A-Za-z ]/g, " ").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? "??").slice(0, 2).toUpperCase();
}

// Context-relevant cover candidates, tried in order until one returns an image.
function coverCandidates(title: string): string[] {
  const uns = (id: string) =>
    `https://images.unsplash.com/photo-${id}?w=1200&q=80&auto=format&fit=crop`;
  const lf = (kw: string) => `https://loremflickr.com/1200/800/${kw}`;
  const t = title.toLowerCase();
  if (/(americano|kopi|coffee)/.test(t)) return [uns("1509042239860-f550ce710b93"), uns("1447933601403-0c6688de566e"), lf("coffee")];
  if (/latte/.test(t)) return [uns("1461023058943-07fcbe16d735"), uns("1541167760496-1628856ab772"), lf("latte")];
  if (/(chatime|milk tea|boba|teh)/.test(t)) return [uns("1558857563-b371033873b8"), uns("1525803377221-4f6ccd6c1063"), lf("bubble,tea")];
  if (/(sepatu|sport|sneaker|shoe)/.test(t)) return [uns("1542291026-7eec264c27ff"), uns("1460353581641-37baddab0fa2"), lf("sneakers")];
  if (/(belanja|alfamart|grocer|market)/.test(t)) return [uns("1542838132-92c53300491e"), uns("1578916171728-46686eac8d58"), lf("supermarket")];
  if (/(nonton|tiket|cinema|cgv|film|movie)/.test(t)) return [uns("1489599849927-2ee91cede3ba"), uns("1517604931442-7e0c8ed2963c"), lf("cinema")];
  return [lf("gift,voucher"), uns("1607083206869-4c7672e72a8a")];
}

async function fetchImage(candidates: string[]): Promise<{ buf: Buffer; type: string } | null> {
  for (const u of candidates) {
    try {
      const res = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000) });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && type.startsWith("image/")) {
        return { buf: Buffer.from(await res.arrayBuffer()), type };
      }
    } catch { /* try next */ }
  }
  return null;
}

async function main() {
  // ---- Merchant logos ----
  const merchants = await prisma.merchant.findMany({ select: { id: true, name: true } });
  for (const m of merchants) {
    const bg = colorFor(m.name);
    const uiUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(initials(m.name))}&size=256&background=${bg}&color=fff&bold=true&format=png`;
    const img = await fetchImage([uiUrl]);
    if (!img) { console.log(`  ! logo failed: ${m.name}`); continue; }
    const key = `demo/logos/${m.id}.png`;
    await uploadFile({ bucket: BUCKET, key, body: img.buf, contentType: "image/png" });
    const logoUrl = `${PUBLIC_BASE}/${key}`;
    await prisma.merchant.update({ where: { id: m.id }, data: { logoUrl } });
    console.log(`  logo  ✓ ${m.name.padEnd(26)} → ${logoUrl}`);
  }

  // ---- Voucher covers ----
  const vouchers = await prisma.voucher.findMany({ select: { id: true, title: true } });
  for (const v of vouchers) {
    const img = await fetchImage(coverCandidates(v.title));
    if (!img) { console.log(`  ! cover failed: ${v.title}`); continue; }
    const ext = img.type.includes("png") ? "png" : "jpg";
    const key = `demo/covers/${v.id}.${ext}`;
    await uploadFile({ bucket: BUCKET, key, body: img.buf, contentType: img.type });
    const coverImageUrl = `${PUBLIC_BASE}/${key}`;
    await prisma.voucher.update({ where: { id: v.id }, data: { coverImageUrl } });
    console.log(`  cover ✓ ${v.title.slice(0, 30).padEnd(30)} → ${coverImageUrl}`);
  }
}

main()
  .catch((err) => {
    console.error("[set-demo-images] FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
