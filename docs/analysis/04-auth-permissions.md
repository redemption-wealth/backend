# 04 — Auth & Permission Enforcement

## Auth Flows

### Admin Auth Flow

```
1. POST /api/auth/check-email  → { needs_password_setup: bool }
2a. (first login) POST /api/auth/set-password  → { message: "Password set successfully" }
2b. (returning)   POST /api/auth/login          → { token, admin }
3. All subsequent requests:    Authorization: Bearer <jwt>
```

- Token: JWT, HS256, 24h expiry, signed with `ADMIN_JWT_SECRET`
- Storage: client-side (FE responsible)
- Refresh: Not implemented — no refresh token endpoint
- Revocation: Effective immediately because `requireAdmin` does a **live DB lookup** on every request and checks `admin.isActive`

### User Auth Flow

```
1. User authenticates via Privy (client-side, external)
2. POST /api/auth/user-sync    → syncs Privy user to local DB (upsert)
3. All subsequent requests:    Authorization: Bearer <privy-access-token>
```

- Token: Privy access token, validated via `privyClient.verifyAuthToken()`
- User identity: `claims.userId` (Privy) → looked up in local `users` table via `privyUserId`

---

## Token Strategy

| Aspect | Admin | User |
|--------|-------|------|
| Token type | Custom JWT (jose, HS256) | Privy access token |
| Location | `Authorization: Bearer` header | `Authorization: Bearer` header |
| Expiry | 24h | Privy-managed |
| Storage | Client-side | Client-side |
| Refresh | None | Via Privy SDK |
| Revocation | Instant (DB `isActive` check) | Via Privy |

---

## Middleware

### `requireAdmin` (`src/middleware/auth.ts:126`)
1. Extract `Bearer` token from `Authorization` header
2. Verify JWT with `ADMIN_JWT_SECRET` (jose `jwtVerify`)
3. **Live DB lookup**: `prisma.admin.findUnique({ where: { id: decoded.id } })`
4. Check `admin.isActive === true`
5. Set `c.set("auth", adminAuth)` and `c.set("adminAuth", adminAuth)` from **DB values** (not JWT payload)
   - Role changes take effect on next request without re-login

### `requireUser` (`src/middleware/auth.ts:89`)
1. Extract `Bearer` token
2. Verify via `privyClient.verifyAuthToken(token)`
3. **Live DB lookup**: `prisma.user.findUnique({ where: { privyUserId: claims.userId } })`
4. User must exist in local DB (requires prior `/api/auth/user-sync`)
5. Set `c.set("auth", userAuth)` and `c.set("userAuth", userAuth)`

### `requireOwner` (`src/middleware/auth.ts:165`)
- Must run after `requireAdmin`
- Reads `c.get("adminAuth").role`
- Fails with 403 if role !== "owner"

### `requireManager` (`src/middleware/auth.ts:175`)
- Must run after `requireAdmin`
- Allows `owner` or `manager`
- Fails with 403 if role === "admin"

---

## Role Matrix

| Endpoint | owner | manager | admin |
|----------|:-----:|:-------:|:-----:|
| GET /api/admin/merchants | ✅ | ✅ | ✅ |
| GET /api/admin/merchants/select | ✅ | ❌ | ❌ |
| GET /api/admin/merchants/:id | ✅ | ✅ | ✅ (own only) |
| POST /api/admin/merchants | ✅ | ✅ | ❌ |
| PUT /api/admin/merchants/:id | ✅ | ✅ | ❌ |
| DELETE /api/admin/merchants/:id | ✅ | ✅ | ❌ |
| GET /api/admin/vouchers | ✅ | ✅ | ✅ (own merchant) |
| GET /api/admin/vouchers/:id | ✅ | ✅ | ✅ (own merchant) |
| POST /api/admin/vouchers | ✅ | ✅ | ✅ ⚠️ (no role guard) |
| PUT /api/admin/vouchers/:id | ✅ | ✅ | ✅ (own merchant) |
| DELETE /api/admin/vouchers/:id | ✅ | ✅ | ✅ (own merchant) |
| POST /api/admin/qr-codes/scan | ✅ | ✅ | ✅ (own merchant) |
| GET /api/admin/qr-codes | ✅ | ✅ | ✅ (own merchant) |
| POST /api/admin/qr-codes (legacy) | ✅ | ✅ | ✅ |
| GET /api/admin/redemptions | ✅ | ✅ | ✅ (own merchant) |
| GET /api/admin/redemptions/:id | ✅ | ✅ | ✅ (own merchant) |
| GET /api/admin/admins | ✅ | ❌ | ❌ |
| GET /api/admin/admins/:id | ✅ | ❌ | ❌ |
| POST /api/admin/admins | ✅ | ❌ | ❌ |
| PUT /api/admin/admins/:id | ✅ | ❌ | ❌ |
| POST /api/admin/admins/:id/reset-password | ✅ | ❌ | ❌ |
| DELETE /api/admin/admins/:id | ✅ | ❌ | ❌ |
| GET /api/admin/analytics/* | ✅ | ✅ | ✅ (own merchant) |
| GET /api/admin/fee-settings | ✅ | ✅ | ✅ |
| POST /api/admin/fee-settings | ✅ | ✅ | ❌ |
| PUT /api/admin/fee-settings/:id | ✅ | ✅ | ❌ |
| POST /api/admin/fee-settings/:id/activate | ✅ | ✅ | ❌ |
| DELETE /api/admin/fee-settings/:id | ✅ | ✅ | ❌ |
| GET /api/admin/settings | ✅ | ❌ | ❌ |
| PUT /api/admin/settings | ✅ | ❌ | ❌ |
| POST /api/admin/upload/logo | ✅ | ✅ | ❌ |

---

## Merchant Scoping for `admin` Role

The `admin` role has a `merchantId` field that restricts their access. Scoping is enforced **inline in each handler** (not in a shared middleware). Pattern:

```javascript
// List: filter where clause
const merchantIdFilter = adminAuth.role === "admin"
  ? adminAuth.merchantId
  : merchantIdQuery || undefined;

// Detail: post-fetch check
if (adminAuth.role === "admin" && resource.merchantId !== adminAuth.merchantId) {
  return c.json({ error: "Access denied" }, 403);
}
```

Enforced in: vouchers (list/detail/update/delete), qr-codes (scan/list), redemptions (list/detail), analytics (all), merchants (detail only).

**⚠️ Not enforced in**: `GET /api/admin/merchants` list — `admin` role can see all merchants' names.

---

## Auth Inconsistencies

1. **`GET /api/auth/me` returns `adminAuth` shape** (`adminId`, `type`) vs **`POST /api/auth/login` returns DB shape** (`id`, `isActive`, `createdAt`, `updatedAt`). FE receives two different shapes for "admin object".

2. **`POST /api/auth/user-sync`** does its own manual `privyClient.verifyAuthToken()` instead of using the `requireUser` middleware — duplicated logic (`src/routes/auth.ts:178-186` vs `src/middleware/auth.ts:79-85`).

3. **`loginLimiter` and `setPasswordLimiter`** are defined in `src/middleware/rate-limit.ts` but never imported or applied anywhere. The auth endpoints have no rate limiting.

4. **Webhook has no auth** — `POST /api/webhook/alchemy` checks for presence of `x-alchemy-signature` header but the actual HMAC verification is TODO'd out (`webhook.ts:17-20`). Any unauthenticated caller can trigger `confirmRedemption()` or `failRedemption()` by crafting a payload.

5. **`POST /api/admin/vouchers`** has no `requireManager` guard — only `requireAdmin`. Any `admin` role can create vouchers (and is force-restricted to their merchantId, but the pattern is inconsistent with DELETE which has explicit role comment: "manager can always delete").
