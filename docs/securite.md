# Posture de sécurité — défense en profondeur

Vue d'ensemble des mesures de sécurité **implémentées** dans le projet, avec
leur *raison d'être*. L'objectif n'est pas d'empiler des libs mais d'avoir une
défense cohérente sur trois axes : **authentification**, **traçabilité**,
**supply-chain**.

> Ce document décrit la **posture technique**. Pour la **politique** (signalement
> de vulnérabilité, rotation des secrets, incident connu), voir
> [`../SECURITY.md`](../SECURITY.md). Pour le détail du modèle d'auth, voir
> [`authentification.md`](./authentification.md).

## Socle applicatif

| Mesure | Détail | Pourquoi |
|--------|--------|----------|
| **Requêtes préparées** (better-sqlite3) | Tout le SQL passe par des statements paramétrés (`queries`) | SQLi neutralisée **par conception**, pas par filtrage. |
| **bcrypt 12 rounds** | Hachage des mots de passe | Résistance au brute-force offline. |
| **Politique de mot de passe** | `express-validator` (format) + `passwordService` : score **`zxcvbn` ≥ 3** et rejet des mots de passe présents dans les fuites connues (**HaveIBeenPwned en k-anonymity** : seuls les 5 premiers caractères du SHA-1 sortent) | Une règle de composition seule laisse passer `Password1!`. Le score mesure la vraie imprévisibilité, HIBP écarte ce qui est déjà dans les dictionnaires d'attaque. **Fail-open** assumé si HIBP est injoignable : ne pas bloquer une inscription à cause d'un tiers indisponible. |
| **Helmet + CSP** | Scripts sans `unsafe-inline`, HSTS preload | Réduit la surface XSS et force HTTPS. |
| **Sanitization des entrées** | Nettoyage récursif, **hors champs sensibles** | Filtre les payloads dangereux **sans** corrompre mots de passe / codes 2FA avant hachage. |
| **Rate limiting différencié** | global / login (anti-brute-force) / register / 2FA (deux plafonds distincts) / demandes de jetons (5 par heure) | Limite l'abus par catégorie de risque. Store Redis optionnel (multi-instance). Le plafond 2FA est dédoublé : `a2fLimiter` (5) garde le *gate* de connexion, `a2fSessionLimiter` (10) les routes déjà authentifiées où le rejeu automatique du front consomme deux crédits par tentative. |
| **Verrouillage de compte** | 15 min après 5 échecs (`locked_until`), **jamais prolongé tant qu'il est actif** | Ralentit le credential stuffing ciblé, sans offrir un déni de service : sinon, connaître un pseudo suffirait à garder un compte fermé indéfiniment. |
| **Horodatages SQLite lus en UTC** | `services/sqliteDate.js`, **fail-closed** sur valeur illisible | `new Date('2026-07-25 10:00:00')` interprète la chaîne en heure *locale* : hors UTC, un verrou paraissait expiré dès sa pose. Testé sous 4 fuseaux imposés, la CI tournant en UTC ne l'aurait jamais vu. |
| **CSRF** | Global sur `tokens`/`a2f`/`avatar`/`admin`, route par route sur `/game/start` et `/auth/claim-daily` ; middleware **fail-closed** | Défense en profondeur derrière `sameSite: 'strict'`. Le middleware exige `req.user`, donc doit être monté **après** `authenticateToken` — l'ordre inverse le neutralise silencieusement. |
| **Projection des réponses** | Liste blanche de colonnes sur les routes admin (`projectUser`) | Une ligne `users` brute exposerait `password_hash` et `a2f_secret`. Liste blanche et non noire : une future colonne sensible reste privée par défaut. |
| **Contrôle de propriété (IDOR)** | `/game/choose` et `/game/recommend` valident tout `gameId` fourni, y compris sans session | Ces routes sont sous `optionalAuth` : ne contrôler que les appelants authentifiés laisse les anonymes écrire dans la partie d'autrui. |
| **CORS** | Origines contrôlées, fermé par défaut en prod | Empêche l'usage cross-origin non autorisé. |

## Authentification moderne

Access token court (15 min) + refresh token rotatif en cookie **httpOnly**,
avec **rotation à usage unique** et **détection de réutilisation** (le rejeu
d'un vieux refresh révoque toute la famille → détecte le vol). Blacklist et
refresh **persistés en base** (survivent au redémarrage). Détail complet et
subtilités (garde `pending2FA`, invalidation au changement de mot de passe)
dans [`authentification.md`](./authentification.md).

*Pourquoi ça compte :* c'est la question classique « où stockez-vous le JWT ? ».
Un token en `localStorage` est volable par XSS ; ici il est hors de portée du
JavaScript et son vol est détectable.

## 2FA (TOTP) renforcé

- Second facteur **TOTP** (speakeasy + QR code), compatible Google Authenticator.
- **Anti-rejeu** : le dernier `step` TOTP utilisé est mémorisé (`a2f_last_step`)
  → un même code ne peut pas être rejoué.
- **Codes de secours** : 8 codes hashés, à **usage unique** (`a2f_backup_codes`),
  remis à l'activation (`verify-setup`) et régénérables (`backup-codes`, ce qui
  invalide les anciens). Ils sont acceptés partout où un TOTP l'est — connexion,
  désactivation — pour qu'une perte de téléphone ne ferme pas le compte.
- **Désactivation protégée** : `/disable` exige le mot de passe **et** un second
  facteur (TOTP ou code de secours). Sans cela, un cookie volé suffirait à
  retirer le 2FA — c'est-à-dire à annuler la mesure censée protéger du vol.
- **Réinitialisation de mot de passe adossée au 2FA** : `/forgot-password` exige
  un code TOTP valide (pas d'email dans ce projet). Corollaire assumé : un compte
  sans A2F ne peut pas être récupéré en libre-service, il faut passer par un
  administrateur.
- **Rate-limit dédié** sur la vérification (anti-brute-force sur 6 chiffres).
- Garde-fou : un token `pending2FA` ne peut jamais ouvrir de session (voir
  [`authentification.md`](./authentification.md#garde-fou-critique)).

## Journal d'audit inviolable

Table `audit_log` **append-only** à **chaînage HMAC** :
`hash_n = HMAC-SHA256(clé, payload_n || hash_n-1)`
([`auditService.js`](../AkinatorWeb/backend/services/auditService.js)).

- La clé `AUDIT_HMAC_KEY` est conservée **hors de la base** : un attaquant qui
  écrit dans la DB mais n'a pas la clé ne peut pas recalculer une chaîne valide.
- `appendAudit` est **transactionnel** (lecture du dernier hash + insertion
  atomiques → pas de course sur `prev_hash`).
- `verifyAuditChain` revalide toute la chaîne (`GET /api/admin/audit/verify`).
- **Garanties réelles** : détecte toute altération, insertion ou suppression
  *interne*. **Limites connues** : (1) ne détecte pas la troncature de queue
  (suppression des dernières lignes) sans ancrage externe ; (2) le journal vit
  dans la base SQLite, donc sur l'hébergement Render `free` actuel — sans disque
  persistant — il disparaît à chaque redéploiement. La traçabilité ne vaut que
  pour la durée de vie de l'instance.

*Pourquoi ça compte :* traçabilité, forensics, non-répudiation sur les
événements sensibles (login, changement de rôle, actions admin, attribution de
jetons).

## Données personnelles (RGPD)

- **IP chiffrées en base** (AES-256-GCM) via `ENCRYPTION_KEY` dédiée.
- **IP hachées** (SHA-256 + sel) dans les logs applicatifs → jamais d'IP en clair.
- **Minimisation** : pas de colonne email (migration `remove-email-column`).
- **Purge automatique** des IP anciennes au démarrage (`cleanup.js`).

## Gestion des secrets

Quatre secrets **indépendants** (la fuite de l'un n'affecte pas les autres) :
`JWT_SECRET`, `ENCRYPTION_KEY`, `AUDIT_HMAC_KEY`, `IP_HASH_SALT`.

- **Fail-secure** : en production, `ENCRYPTION_KEY` et `AUDIT_HMAC_KEY` sont
  **obligatoires** — le serveur refuse de démarrer si elles manquent ou sont
  malformées. En dev/test seulement, un repli dérivé de `JWT_SECRET` est toléré
  (avec avertissement).
- Génération : `node scripts/generate-keys.js`.
- Rotation de la clé de chiffrement (re-chiffre les données existantes) :
  `scripts/rotate-encryption-key.js`.
- Aucun secret dans le dépôt : **gitleaks** en pre-commit + CI.

## Attribution de jetons

**Aucun paiement n'est branché** : la boutique est une vitrine. Trois voies
d'obtention seulement, toutes tracées.

- **Claim quotidien** — 3 jetons/jour. Deux routes (`/api/auth/claim-daily` et
  `/api/tokens/gift`) exposent le *même* robinet via `services/dailyTokens.js`.
  *Pourquoi ça compte :* `/gift` acceptait autrefois un `amount` arbitraire du
  client, soit un robinet caché à 10 jetons/jour. Le champ est encore accepté
  pour compatibilité mais **délibérément ignoré** — un montant venant du client
  ne décide jamais d'un crédit.

- **Demande à un administrateur** (`POST /api/tokens/requests`) — montant 1–100,
  motif obligatoire (3–200 caractères), **5 demandes par heure**, et **une seule
  demande en attente à la fois**. Cet unicité n'est pas une vérification
  applicative mais un **index unique partiel** en base
  (`idx_token_requests_une_en_attente`) : deux requêtes concurrentes ne peuvent
  pas la contourner, la seconde reçoit un `409`. La résolution par un admin place
  le crédit et le changement de statut dans **une seule transaction**,
  conditionnée à `status = 'pending'` : un double clic ou deux admins simultanés
  ne créditent jamais deux fois. Tracé en `tokens.request.create` puis
  `admin.token_request.approve` / `.reject`.

- **Attribution directe** (`POST /api/admin/users/:id/tokens`, `requireAdmin` +
  CSRF). La raison est **obligatoire** (≤ 200 caractères), le solde final ne peut
  pas être négatif, et l'opération est tracée à la fois comme transaction
  (`admin_grant`) et dans le journal d'audit (`admin.user.tokens`).

*Pourquoi ça compte :* non-répudiation de qui a crédité quoi et pourquoi. Toute
création de valeur dans le système passe par un événement d'audit chaîné.

## Upload d'avatar durci

`multer` + `sharp` : re-encodage en WebP (neutralise un contenu malveillant),
limites de taille/dimensions, nom de fichier généré (anti path-traversal).

## En-têtes & découverte

`Permissions-Policy` (désactive caméra/micro/géoloc/paiement/usb),
CSP avec `report-to` → `/api/csp-report` (violations journalisées à l'audit),
et `/.well-known/security.txt` (RFC 9116).

## DevSecOps (CI)

Pipeline de sécurité dans `.github/workflows/` :

- **Secret scanning** : gitleaks (pre-commit + CI). Faux positifs gérés par
  allowlist ciblée dans `.gitleaks.toml` (jamais par exemption de chemin).
- **SAST** : CodeQL.
- **Dépendances** : `npm audit` (gate `high`), `npm ci` sur lockfile.

*Contexte :* un token GitHub avait fuité dans l'historique du projet. Le secret
scanning est la mesure qui empêche la récidive — l'incident est documenté dans
[`../SECURITY.md`](../SECURITY.md#incident-connu-leçon-apprise).

## Récapitulatif des 10 axes

| # | Axe | État |
|---|-----|------|
| 1 | Access court + refresh rotatif (cookies httpOnly, reuse detection) | ✅ |
| 2 | Journal d'audit inviolable (chaînage HMAC) | ✅ |
| 3 | Anti-énumération / réponses uniformisées sur login/register | ✅ |
| 4 | 2FA renforcé (backup codes, anti-rejeu, rate-limit dédié) | ✅ |
| 5 | Verrouillage de compte anti-brute-force | ✅ |
| 6 | Pipeline CI sécurité (gitleaks, CodeQL, npm audit) | ✅ |
| 7 | Séparation & rotation des secrets (fail-secure) | ✅ |
| 8 | Upload avatar durci (re-encode, anti path-traversal) | ✅ |
| 9 | Stores persistants (Redis optionnel, CSRF/tokens en base) | ✅ |
| 10 | En-têtes + security.txt (Permissions-Policy, report-to) | ✅ |
