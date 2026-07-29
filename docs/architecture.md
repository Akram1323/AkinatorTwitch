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
│   ├── security.js      # Helmet, rate limiters (global/login/register/2FA/demandes de jetons), authenticateToken/optionalAuth/requireAdmin, sanitize, logger
│   └── csrf.js          # Protection CSRF par token utilisateur (persistée en base)
├── routes/              # Un router Express par domaine (voir table plus bas)
├── services/            # Logique métier & sécurité réutilisable (voir table plus bas)
├── migrations/          # Évolutions ponctuelles du schéma (scripts one-shot)
├── scripts/             # Outils d'admin / diagnostic (création admin, rotation de clé…)
└── tests/               # node:test + supertest (un fichier par comportement)
```

Les **données** vivent hors de l'arborescence de code, dans le répertoire
`DATA_DIR` (défaut `backend/data/`, créé automatiquement) :
`akinator.db` (base SQLite générée au démarrage) et `avatars/` (uploads servis
sur `/avatars`). Ce répertoire n'est persistant que si l'hébergeur fournit un
disque monté — ce n'est **pas** le cas du plan Render `free` actuellement
utilisé, où base et avatars sont perdus à chaque redéploiement.

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
9. **Fichiers statiques** — `/avatars` est servi depuis `config.paths.avatarsDir` (hors du dépôt), monté **avant** le static général ; `express.static` appelant `next()` sur fichier absent, les anciens avatars restés dans `frontend/avatars` continuent d'être servis. Le reste du front est servi depuis `../frontend`.
10. **Routes API** (voir ci-dessous).

### Montage des routes et CSRF

Points d'attention dans `server.js` :

- `GET /api/csrf-token` exige `authenticateToken` : le token CSRF n'est délivré qu'à un utilisateur authentifié.
- `csrfProtection` est appliqué **globalement** aux routers **`tokens`, `a2f`, `avatar`, `admin`**.
  Les routers `auth` et `game` ne peuvent pas l'être globalement (login, register, refresh et le
  parcours de jeu public n'ont pas de session), mais leurs routes mutantes qui touchent au solde
  de jetons le sont **route par route** : `POST /api/game/start` (débite 1 jeton) et
  `POST /api/auth/claim-daily` (en crédite 3). C'est un choix explicite, pas un oubli : toute
  nouvelle route mutante hors de ces quatre routers doit décider de son cas.
  Défense en profondeur, la protection primaire restant `sameSite: 'strict'` sur les cookies.
- **Ordre imposé : `app.use('/api/xxx', authenticateToken, csrfProtection, xxxRoutes)`.**
  `csrfProtection` valide le token *pour un utilisateur donné* : sans `req.user`, il ne peut rien
  vérifier. Le monter avant `authenticateToken` (qui n'était appelé qu'à l'intérieur des routers)
  neutralisait silencieusement toute la protection. Les routers conservent leurs appels internes à
  `authenticateToken` (idempotents) pour rester sûrs s'ils sont montés ailleurs.
- `csrfProtection` est **fail-closed** : sur une méthode mutante sans `req.user`, il répond 403 au
  lieu de laisser passer. Couvert par `tests/csrf-middleware.test.js` (supertest sur l'app montée,
  pas seulement sur les fonctions unitaires de `csrf.js`).
- `POST /api/csp-report` contourne volontairement le CSRF : rapports de violation CSP envoyés
  directement par le navigateur, pas depuis une session applicative.
- `GET /.well-known/security.txt` — politique de divulgation (RFC 9116).

## Routers (`routes/`)

| Router | Préfixe | Auth | Responsabilité |
|--------|---------|------|----------------|
| `auth.js` | `/api/auth` | mixte | Inscription, connexion, 2FA à la connexion, refresh, logout, mot de passe, claim quotidien. Voir [authentification.md](./authentification.md). |
| `game.js` | `/api/game` | mixte (`optionalAuth`) | Arbre de décision, démarrage de partie (consomme 1 jeton), recommandations IGDB, historique, leaderboard. |
| `tokens.js` | `/api/tokens` | 🔒 + CSRF | Solde, historique des transactions, gift quotidien, **demandes de jetons** adressées aux admins (`GET/POST /requests`). |
| `a2f.js` | `/api/a2f` | 🔒 + CSRF | Cycle de vie du 2FA TOTP : setup, verify-setup, verify, disable, backup-codes, status. |
| `avatar.js` | `/api/avatar` | 🔒 + CSRF | Upload (multer+sharp, re-encode WebP) et suppression d'avatar. |
| `admin.js` | `/api/admin` | 👑 + CSRF | Stats, gestion utilisateurs (promote/demote/unlock/delete), attribution de jetons (`users/:id/tokens`), **traitement des demandes de jetons** (`token-requests`, approve/reject), purge RGPD des IP, consultation + vérification du journal d'audit. |

🔒 = `authenticateToken` · 👑 = `requireAdmin` (après `authenticateToken`).

### Filtre IGDB irrésoluble

Si un slug de filtre (genre, plateforme, thème, mode) ne correspond à aucun ID
IGDB — via `resolveSlugDynamic`, y compris le fallback thème→keywords —,
`igdbFilters.resolveFilters` l'exclut de la requête plutôt que de faire
échouer la recommandation. `igdb.js` logue alors `⚠️ Filtres ignorés (aucune
correspondance IGDB): ...` et poursuit la recherche avec les filtres restants ;
au démarrage, `validateTreeSlugs()` fait le même contrôle sur tout l'arbre de
décision et n'émet qu'un avertissement (jamais de blocage).

### Résolution d'une demande de jetons

Aucun paiement n'étant branché, la boutique du front n'ouvre pas une caisse mais
un formulaire de **demande à un administrateur**. Deux invariants portés par le
code, pas par l'interface :

- **Une seule demande en attente par utilisateur**, garantie par l'index unique
  partiel en base. La vérification applicative préalable ne sert qu'à produire un
  message clair ; c'est le `SQLITE_CONSTRAINT` qui fait foi (→ `409`).
- **Crédit et changement de statut sont atomiques**. `resoudreDemande()`
  ([admin.js:488](../AkinatorWeb/backend/routes/admin.js)) exécute l'`UPDATE`
  conditionné à `status = 'pending'` **et** le crédit dans la même transaction
  `better-sqlite3`. Si `changes === 0`, un autre admin a gagné la course : rien
  n'est crédité et la réponse est `409`. Un double clic ne peut donc pas créditer
  deux fois.

L'approbation trace une transaction `admin_grant` et un événement d'audit
`admin.token_request.approve` ; le refus ne crédite rien. Le tableau
« Attributions de crédits » du panneau admin réunit les deux voies de crédit via
`GET /api/admin/audit?event_type=admin.user.tokens,admin.token_request.approve`.

## Services (`services/`)

| Service | Rôle |
|---------|------|
| `database.js` | Ouvre la connexion SQLite, crée les tables (`initializeTables`), expose `db` et l'objet `queries` (requêtes préparées par domaine). |
| `tokenService.js` | Émission/rotation des tokens : access JWT court + refresh opaque rotatif, reuse detection, blacklist par `jti`. Voir [authentification.md](./authentification.md). |
| `auditService.js` | Journal d'audit append-only à chaînage HMAC (`appendAudit`, `verifyAuditChain`). |
| `encryption.js` | AES-256-GCM pour chiffrer les IP en base + SHA-256 pour hacher les IP dans les logs (RGPD). |
| `passwordService.js` | Politique de mot de passe : force via `zxcvbn` (score ≥ 3) + rejet des mots de passe compromis via HaveIBeenPwned en k-anonymity (fail-open si l'API est injoignable ; jamais appelée en `NODE_ENV=test`). |
| `dailyTokens.js` | Robinet quotidien unique (3 jetons, colonne `last_daily_claim`) partagé par `/api/auth/claim-daily` et `/api/tokens/gift`. |
| `sqliteDate.js` | Lecture **en UTC** des horodatages SQLite, fail-closed sur valeur illisible (sinon `locked_until` paraît expiré hors UTC). |
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
| `token_requests` | Demandes de jetons adressées aux admins | `status` (`pending`/`approved`/`rejected`), `resolved_by`/`resolved_at`. **Index unique partiel** `idx_token_requests_une_en_attente` → une seule demande en attente par utilisateur, garanti par la base et non par une vérification applicative. |
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
2. `authenticateToken` (monté sur `/api/admin`) : lit `access_token` (cookie, sinon header `Authorization`), vérifie le JWT, rejette si `pending2FA`, si `jti` révoqué, ou si le token est antérieur à `password_changed_at`. Injecte `req.user`.
3. `csrfProtection` valide le token CSRF pour `req.user.id`, puis `requireAdmin` (routeur `admin`) vérifie `is_admin`.
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
npm test          # 144 tests
```

Helper commun : `tests/helpers/setup.js`, à require **avant** tout module
applicatif : il fige `NODE_ENV=test`, fournit un `JWT_SECRET` de repli et pointe
`DATABASE_PATH` sur une base temporaire propre à chaque processus. Aucune
variable d'environnement n'est donc nécessaire pour lancer la suite. Les tests
montent l'app Express sans `app.listen`, et `NODE_ENV=test` neutralise les appels
réseau réels (HIBP, IGDB) ainsi que les plafonds de rate limiting.
