# Wealth Redemption Back-Office — Refactor Brief

**Status:** Locked, pending backend planning before implementation
**Date:** 2026-05-04
**Stack target:** Vite + TypeScript + TanStack Query + Tailwind v4 + shadcn

---

## 1. Roles

Tiga role di back-office, login di aplikasi yang sama.

| Role | Scope |
|------|-------|
| **Owner** | Platform monitoring + account management |
| **Manager** | Operasional penuh: merchant, voucher, fee config |
| **Admin** | Per-merchant: CRUD voucher + scan QR untuk assigned merchant |

**Relasi Admin ↔ Merchant:** 1 admin ↔ 1 merchant (exclusive both ways).

---

## 2. Page Inventory (12 total)

### Owner (4 unique)
| Page | Purpose |
|------|---------|
| Dashboard | KPI cards (4), charts (line/bar/pie), top merchants/vouchers leaderboard, recent activity feed (10), treasury balance |
| Account Management | CRUD admin, reset password, badge "Pending Setup" untuk admin yang baru di-reset |
| Activity Log | Full redemption transaction log dengan filter status |

### Manager (6 unique)
| Page | Purpose |
|------|---------|
| Overview | 3 KPI cards: total merchant, total voucher, total QR available |
| Merchants | List + CRUD merchant (semua merchant) |
| Merchant Detail | Detail merchant + voucher list + create/edit voucher (merchant pre-locked) |
| Vouchers | List voucher cross-merchant + create voucher (merchant selectable) |
| QR Monitoring | View-only list semua QR cross-merchant. Filter status (available/redeemed/used) + filter per merchant/voucher. Tidak ada action manual override |
| System Config | App fee % + gas fee IDR (form 2 input, edit langsung. No preset, no history) |

### Admin (2 unique)
| Page | Purpose |
|------|---------|
| Merchant Detail | Landing page setelah login. Single scrollable: info merchant (read-only) + voucher CRUD + sticky "Scan QR" button. Mobile-first |
| No Access | Fallback untuk admin yang belum di-assign merchant |

### Shared (3)
| Page | Purpose |
|------|---------|
| Login | 2-step: cek email → input password. Ada link "Lupa password?" → halaman instruksi |
| Profile / Change Password | Display info account + form change password (3-input) + tombol "Logout other devices" |
| Set Password | Post-reset flow. Akses via temporary token, bukan email query param |

---

## 3. Authentication

### Library & Strategy
- **Library:** Better Auth
- **Session:** Database session (table `sessions` di Postgres)
- **Multi-device:** Allowed (1 user banyak session, beda device beda row)
- **Email service:** **Tidak ada.** Reset manual via Owner.

### Login Flow
```
Input email
  ↓
Backend cek: password_hash exists?
  ↓                              ↓
NULL (first login / reset)    EXISTS
  ↓                              ↓
Issue temporary token         Verify password
  ↓                              ↓
Redirect /set-password        Issue session
  ↓                              ↓
Set password baru             Redirect dashboard
```

### Reset Password Flow (Manual via Owner)
```
Admin lupa password → hubungi Owner manual (chat/WA)
  ↓
Owner buka Account Management → klik "Reset Password" pada admin
  ↓
Backend:
  - Set password_hash = NULL
  - Invalidate semua session admin tersebut (auto-logout)
  ↓
Owner inform admin → admin login → password_hash NULL detected
  ↓
Backend issue temporary token → redirect /set-password
  ↓
Admin set password baru → auto-login → dashboard
```

### Temporary Token (Set Password)
- Random 32-byte string
- Stored di table `password_setup_tokens`
- Expire 5 menit
- Single-use (mark used setelah dipakai)
- In-memory di FE (Zustand/React state, **bukan** localStorage)
- Tied ke specific admin_id (no cross-account manipulation)

### Change Password
- Form 3-input: current password + new password + confirm new password
- Validate current password dengan bcrypt compare
- Hash & update `password_hash`
- **Auto-invalidate semua session lain** (kecuali current session)

### Logout
- Tombol logout di profile dropdown (avatar pojok kanan atas header)
- Mobile: sama, atau di profile page

---

## 4. UX & Pattern Decisions

### Voucher Creation (Pattern C)
- **Dari Merchant Detail:** form muncul dengan merchant pre-selected dan disabled
- **Dari Vouchers list (Manager only):** form muncul dengan dropdown merchant selectable
- **Edit voucher:** merchant field selalu disabled (snapshot transactional)

### Voucher Edit Constraints

| Field | Bisa Diedit? |
|-------|--------------|
| Judul, deskripsi | Yes |
| Tanggal mulai, expired | Yes |
| Status aktif/nonaktif | Yes |
| Stok | Yes (dengan floor constraint) |
| Harga dasar | No |
| QR per slot | No |
| Fee snapshot | No |

**Stock floor:** minimum stok = jumlah slot yang sudah REDEEMED + FULLY_USED. Validation FE + BE.

### Admin Scope di Merchant Detail
- **Bisa:** CRUD voucher (sesuai constraint di atas)
- **Tidak bisa:** edit info merchant (nama, logo, deskripsi, kategori), toggle merchant active/inactive

### QR Scanner (Admin)
- Webcam scan (html5-qrcode)
- Manual input fallback (paste UUID) untuk hardware failure case
- Validate: QR harus milik assigned merchant admin

### Mobile Responsive
- **Wajib** untuk Admin (scan QR di HP di gerai)
- Admin Merchant Detail: single scrollable page + sticky "Scan QR" button
- Manager/Owner: nice-to-have responsive, primary use case desktop

---

## 5. Components Reusable Cross-Role

### Shared UI Components

| Component | Purpose | Used in |
|-----------|---------|---------|
| **DataTable** | Generic table — pagination, sortable columns, column visibility toggle, global search, per-column filter, scrollable horizontal di mobile | Merchants, Vouchers, Accounts, Activity Log, QR Monitoring |
| **FormField** | Wrapper: label + input + error message dengan spacing & style konsisten | Semua form |
| **FileUpload** | Image upload dengan validation (size, type) + preview | Logo merchant |
| **DatePicker** | Date input dengan calendar UI | Voucher start/expired |
| **ConfirmDialog** | Destructive action confirmation | Delete merchant/voucher, reset password, dll |
| **KpiCard** | Metric display dengan label + value + optional delta/icon | Owner Dashboard, Manager Overview |
| **PageHeader** | Title kiri + action button kanan | Semua list page |
| **EmptyState** | Saat list kosong | Semua list page |
| **LoadingState** | Skeleton untuk table & card | Semua data fetch |
| **LoginForm** | 2-step login: cek email → input password | Login page |

### Domain Components (per-feature)

| Component | Purpose | Used in |
|-----------|---------|---------|
| **MerchantForm** | Add/edit merchant (1 component, 2 mode) | `/merchants/new`, `/merchants/:id/edit` |
| **VoucherForm** | Add/edit voucher (1 component, 2 mode: locked merchant vs selectable) | Voucher add/edit pages |
| **AccountForm** | Add/edit admin account | Account add/edit pages |
| **ChangePasswordForm** | 3-input form | Profile page |
| **SetPasswordForm** | New password + confirm | Set Password page |
| **QrScanner** | Webcam scan + manual input fallback | Admin Merchant Detail (sticky button) |

---

## 6. Out of Scope (Decided to Drop / Defer)

- **Owner System Config page** — moved ke Manager. Wallet addresses & RPC pindah ke env var (bukan UI editable)
- **Email service & email-based password reset** — deferred sampai ada kebutuhan riil
- **User growth metric di Dashboard** — deferred, butuh backend work
- **`coingeckoApiKey` field** — dead field, drop dari schema & UI
- **`alchemyRpcUrl` di System Config** — pindah ke env var
- **Top merchants/vouchers leaderboard size** — keep existing (3 atau 5, tidak diubah)

---

## 7. Implementation Dependencies

**Tidak boleh start implementasi back-office sebelum backend planning selesai.** Beberapa decision di atas butuh backend support yang belum ada:

- Better Auth migration dari custom JWT
- Database session table
- `password_setup_tokens` table + temporary token issuance
- Stock floor validation
- Field tracking untuk badge "Pending Setup" (e.g., `password_reset_at` timestamp)
- Treasury balance — implement on-chain read (existing endpoint masih return "0" hardcoded)
- Recent activity feed extend dari 5 ke 10
- Drop dead fields (`coingeckoApiKey`, dll)
- Normalize response shapes (categories wrapper, QR scan error format, QR image URL signing)
- Drop `fee_settings` table entirely. Replace dengan 2 field di `app_settings`: `appFeeRate` + `gasFeeAmount`. Voucher snapshot tetep pakai field `appFeeSnapshot` + `gasFeeSnapshot` saat created.

**Next step:** Backend planning. Hasil backend planning akan dictate API contract yang FE refactor consume.

---

## 8. Stack Decisions Summary

| Concern | Decision |
|---------|----------|
| Frontend framework | Vite + TypeScript |
| State management | TanStack Query (server state) + Zustand (client state) |
| Styling | Tailwind v4 + shadcn |
| Auth library | Better Auth |
| Session strategy | Database session, multi-device |
| Mobile responsive | Wajib semua role (Owner, Manager, Admin) |

### UI Conventions

| Element | Decision |
|---------|----------|
| Color mode | Light mode (no dark mode toggle) |
| Tables | TanStack Table (datatable) — semua list view (Merchants, Vouchers, Accounts, Activity Log, QR Monitoring) |
| Forms | shadcn components (Input, Select, Button, Dialog, dll) — semua form |
| Cards | Simple, fokus ke clarity informasi. No heavy decoration |

### Layout Conventions

**Application shell:**
- **Sidebar (kiri):** logo paling atas, nav items di bawah. Collapsible (bisa di-minimize jadi icon-only di desktop)
- **Header (atas):**
  - **Atas kiri:** breadcrumb (current location dalam hierarki page)
  - **Atas kanan:** profile icon → dropdown ("Profile", "Logout")
- **Content area:** sisanya

**Page content pattern:**
- **Header section:** title kiri + action button kanan (e.g., "Add Merchant" untuk membuka form)
- **Body:** filter/search bar + datatable, atau detail view

**Form pattern:**
- **Page-based, bukan modal.** Add/edit form punya route sendiri:
  - `/merchants/new`, `/merchants/:id/edit`
  - `/vouchers/new`, `/vouchers/:id/edit` (Manager)
  - `/merchants/:id/vouchers/new` (dari Merchant Detail)
  - `/accounts/new`, `/accounts/:id/edit`
- Navigasi natural via breadcrumb, easy to bookmark/share, predictable back button

**Mobile pattern (semua role full mobile):**
- Sidebar → hamburger menu, buka drawer dari kiri
- Header tetap (breadcrumb + profile dropdown)
- Datatable → scrollable horizontal (no card conversion)
- Form pages tetap page-based, full screen di mobile

### Datatable Behavior

**Standard features (built-in via TanStack Table):**
- Sortable per column (klik header)
- Column visibility toggle (show/hide kolom)
- Global search bar
- Per-column filter (untuk page yang butuh)
- Pagination (server-side, sesuai backend `page`/`limit` convention)

**Filter state management:**
- **URL-based.** Filter, search, page, sort state disimpan di URL query params (e.g., `/merchants?search=cafe&category=kuliner&page=2`)
- Update via `pushState` — no page reload
- Refresh-safe, shareable, predictable back button
- Implementation: TanStack Query baca dari URL → trigger fetch otomatis

**Bulk action:** Skipped untuk Phase 1. Bisa di-add nanti kalau ada use case konkret.

### Filter Scope per Page

| Page | Filter |
|------|--------|
| Merchants | Search nama, filter kategori, filter status (aktif/nonaktif) |
| Vouchers | Search judul, filter merchant, filter status (aktif/nonaktif), filter expired/aktif/upcoming |
| Accounts | Search email, filter role, filter status (aktif/nonaktif), filter "Pending Setup" |
| Activity Log | Filter status redemption, filter date range, search by txHash atau email user |
| QR Monitoring | Filter status QR, filter merchant, filter voucher |
