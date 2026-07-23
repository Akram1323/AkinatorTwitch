# Architecture

Carte du code back-end : ce qui vit où, dans quel ordre les requêtes sont
traitées, et comment les données sont structurées. But : pouvoir se repérer
sans relire tout le projet.

## Vue d'ensemble

Monolithe **Node.js 20 + Express 4**, base **SQLite** (`better-sqlite3`,
synchrone), front-end **statique** (HTML/CSS/JS vanilla) servi par le même
serveur. Pas de framework front, pas d'ORM : le SQL est écrit à la main via des
**requêtes préparées** (parade SQLi par conception).

```
AkinatorWeb/backend/
├── server.js            # Point d'entrée : pipeline de middleware, montage des routes, démarrage
├── config/config.js     # Configuration centralisée (lecture env, fail-secure des secrets)
├── middleware/
│   ├── security.js      # Helmet, rate limiters, authenticateToken/optionalAuth/requireAdmin, sanitize, logger
│   └── csrf.js          # Protection CSRF par token utilisateur (persistée en base)
├── routes/              # Un router Express par domaine (voir table plus bas)
├── services/            # Logique métier & sécurité réutilisable (voir table plus bas)
├── migrations/          # Évolutions ponctuelles du schéma (scripts one-shot)
├── scripts/             # Outils d'admin / diagnostic (création admin, rotation de clé…)
├── tests/               # node:test + supertest (un fichier par comportement)
└── data/akinator.db     # Base SQLite générée au démarrage
```

## Pipeline de middleware (ordre réel)

Défini dans [`server.js`](../AkinatorWeb/backend/server.js). L'ordre est
significatif : chaque requête traverse ces étages **de haut en bas** avant
d'atteindre une route.

1. **`helmetConfig`** — en-têtes de sécurité + CSP (scripts sans `unsafe-inline`, HSTS preload).
2. **`extraHeaders`** — `Permissions-Policy` et `Reporting-Endpoints` (report-to CSP).
3. **`cors`** — origines contrôlées (fermé par défaut en production).
4. **`express.json`** (limite 1 Mo) — parsing du corps des requêtes.
5. **`cookieParser`** — lit les cookies httpOnly `access_token` / `refresh_token`.
6. **`globalLimiter`** — rate limiting global (store Redis si `REDIS_URL`, sinon mémoire).
7. **`sanitizeInput`** — nettoyage récursif des entrées, **hors champs sensibles** (mots de passe, codes 2FA — sinon on corromprait les secrets avant hachage).
8. **`securityLogger`** — log RGPD (IP hachée) + détection de motifs suspects (path traversal, XSS, SQLi) → 400.
9. **Fichiers statiques** — le front est servi depuis `../frontend`.
10. **Routes API** (voir ci-dessous).

### Montage des routes et CSRF

Points d'attention dans `server.js` :

- `GET /api/csrf-token` exige `authenticateToken` : le token CSRF n'est délivré qu'à un utilisateur authentifié.
- `csrfProtection` est appliqué aux routers **`tokens`, `a2f`, `avatar`, `admin`** — pas à `auth` ni `game` (login/register n'ont pas encore de token CSRF ; `game` est majoritairement public).
- `POST /api/csp-report` contourne volontairement le CSRF : rapports de violation CSP envoyés
  directement par le navigateur, pas depuis une session applicative.
- `GET /.well-known/security.txt` — politique de divulgation (RFC 9116).

## Routers (`routes/`)

| Router | Préfixe | Auth | Responsabilité |
|--------|---------|------|----------------|
| `auth.js` | `/api/auth` | mixte | Inscription, connexion, 2FA à la connexion, refresh, logout, mot de passe, claim quotidien. Voir [authentification.md](./authentification.md). |
| `game.js` | `/api/game` | mixte (`optionalAuth`) | Arbre de décision, démarrage de partie (consomme 1 jeton), recommandations IGDB, historique, leaderboard. |
| `tokens.js` | `/api/tokens` | 🔒 + CSRF | Solde, historique des transactions, gift quotidien. |
| `a2f.js` | `/api/a2f` | 🔒 + CSRF | Cycle de vie du 2FA TOTP : setup, verify-setup, verify, disable, backup-codes, status. |
| `avatar.js` | `/api/avatar` | 🔒 + CSRF | Upload (multer+sharp, re-encode WebP) et suppression d'avatar. |
| `admin.js` | `/api/admin` | 👑 + CSRF | Stats, gestion utilisateurs (promote/demote/unlock/delete), attribution de jetons (`users/:id/tokens`), consultation + vérification du journal d'audit. |

🔒 = `authenticateToken` · 👑 = `requireAdmin` (après `authenticateToken`).

### Filtre IGDB irrésoluble

Si un slug de filtre (genre, plateforme, thème, mode) ne correspond à aucun ID
IGDB — via `resolveSlugDynamic`, y compris le fallback thème→keywords —,
`igdbFilters.resolveFilters` l'exclut de la requête plutôt que de faire
échouer la recommandation. `igdb.js` logue alors `⚠️ Filtres ignorés (aucune
correspondance IGDB): ...` et poursuit la recherche avec les filtres restants ;
au démarrage, `validateTreeSlugs()` fait le même contrôle sur tout l'arbre de
décision et n'émet qu'un avertissement (jamais de blocage).

## Services (`services/`)

| Service | Rôle |
|---------|------|
| `database.js` | Ouvre la connexion SQLite, crée les tables (`initializeTables`), expose `db` et l'objet `queries` (requêtes préparées par domaine). |
| `tokenService.js` | Émission/rotation des tokens : access JWT court + refresh opaque rotatif, reuse detection, blacklist par `jti`. Voir [authentification.md](./authentification.md). |
| `auditService.js` | Journal d'audit append-only à chaînage HMAC (`appendAudit`, `verifyAuditChain`). |
| `encryption.js` | AES-256-GCM pour chiffrer les IP en base + SHA-256 pour hacher les IP dans les logs (RGPD). |
| `passwordService.js` | Politique de mot de passe (validation, force). |
| `twoFactor.js` | TOTP (speakeasy) : génération de secret, QR, vérification, anti-rejeu (`a2f_last_step`). |
| `igdb.js` | Réseau : OAuth Twitch (token mis en cache mémoire), requêtes IGDB (jeux, jaquettes), résolution dynamique slug→ID (`resolveSlugDynamic`) avec cache DB `igdb_cache` (TTL 7 jours). |
| `igdbFilters.js` | Module pur et testable : mappings de filtres (multi-ID, cross-facette) et construction de la requête IGDB (`resolveFilters`, `buildGamesQuery`). Aucun appel réseau. |
| `cleanup.js` | Purges programmées : IP anciennes (RGPD), tokens expirés, CSRF expirés. |

## Schéma de la base

Tables créées par `initializeTables()` dans
[`database.js`](../AkinatorWeb/backend/services/database.js). Migrations de
colonnes via `ALTER TABLE … ` en try/catch (idempotent : ignore « colonne
existe déjà »).

| Table | Rôle | Points de sécurité |
|-------|------|--------------------|
| `users` | Comptes | `password_hash` (bcrypt), `a2f_secret`, `a2f_last_step` (anti-rejeu TOTP), `password_changed_at` (invalidation de session), `failed_login_attempts`/`locked_until` (verrouillage), `ip_address` chiffrée. |
| `transactions` | Gifts/daily/parties/attributions admin (`admin_grant`) | `status` contraint (`pending`/`completed`/`failed`). |
| `games` | Parties jouées | Filtres + recommandations sérialisés. |
| `decision_tree` | Arbre Akinator | Nœuds (genre → plateforme → thème → mode). Peuplé au 1er démarrage. |
| `igdb_cache` | Cache IGDB | Résolution dynamique slug→ID (`resolveSlugDynamic`), TTL 7 jours. |
| `sessions` | Trace de connexion | Audit léger (IP, user-agent). |
| `refresh_tokens` | Refresh rotatifs | `token_hash` (SHA-256, jamais en clair), `family_id`, `used_at`, `revoked` → rotation + reuse detection. |
| `revoked_tokens` | Blacklist access | Par `jti`, purge après expiration. |
| `a2f_backup_codes` | Codes de secours 2FA | Hashés, usage unique (`used_at`). |
| `csrf_tokens` | Tokens CSRF persistants | Survivent au redémarrage (contrairement à une `Map` mémoire). |
| `audit_log` | Journal inviolable | Append-only, `prev_hash`+`hash` chaînés (HMAC). |

Pragmas SQLite : `journal_mode=WAL`, `foreign_keys=ON`, `secure_delete=ON`.

## Cycle de vie d'une requête authentifiée (exemple)

`POST /api/admin/users/:id/tokens` :

1. Pipeline global (helmet → cors → json → cookies → rate limit → sanitize → logger).
2. `csrfProtection` (routeur `admin`) valide le token CSRF.
3. `authenticateToken` puis `requireAdmin` : lit `access_token` (cookie, sinon header `Authorization`), vérifie le JWT, rejette si `pending2FA`, si `jti` révoqué, ou si le token est antérieur à `password_changed_at` ; puis vérifie `is_admin`. Injecte `req.user`.
4. Le handler exécute la logique métier via `queries` (requêtes préparées).
5. Les mutations sensibles appellent `appendAudit(...)` pour tracer l'événement (ici `admin.user.tokens`).

## Démarrage (`startServer`)

Ordre dans `server.js` : `initializeTables()` → `initializeDecisionTree()`
(peuple l'arbre au 1er lancement) → `validateTreeSlugs()` (uniquement si
`TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` sont définis ; non bloquant, voir
« Filtre IGDB irrésoluble ») → `ensureAdminAccount()` (crée/promeut l'admin si
`ADMIN_PASSWORD` défini) → `runFullCleanup()` (purge RGPD) → `app.listen`. Le
module n'écoute que si lancé directement (`require.main === module`), pour
rester importable dans les tests.

## Tests

`node:test` + `supertest`, un fichier par comportement dans `tests/`. Lancer
depuis `AkinatorWeb/backend` :

```bash
JWT_SECRET=ci-secret-0123456789abcdef0123456789abcdef npm test
```

Helper commun : `tests/helpers/setup.js`. Les tests montent l'app Express sans
`app.listen` et utilisent une base isolée.
