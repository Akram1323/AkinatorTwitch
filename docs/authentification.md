# Authentification & sessions

C'est la partie la plus sensible et la plus subtile du code. Ce document décrit
le modèle réel : les deux tokens, la stratégie de cookies, le flux 2FA, la
rotation des refresh, la détection de réutilisation, et l'invalidation de
session au changement de mot de passe.

Fichiers concernés :
[`services/tokenService.js`](../AkinatorWeb/backend/services/tokenService.js),
[`middleware/security.js`](../AkinatorWeb/backend/middleware/security.js),
[`routes/auth.js`](../AkinatorWeb/backend/routes/auth.js).

## Modèle à deux tokens

| Token | Nature | Durée | Stockage client | Stockage serveur |
|-------|--------|-------|-----------------|------------------|
| **Access** | JWT signé HS256 | **15 min** | cookie `access_token` (httpOnly) | aucun (stateless), sauf blacklist au logout |
| **Refresh** | Opaque, 96 hex aléatoires | **7 j** | cookie `refresh_token` (httpOnly) | table `refresh_tokens`, **haché SHA-256** |

Charge utile de l'access token : `{ id, username, is_admin, jti }` + `iat`/`exp`
standard. Le `jti` (UUID unique) permet la révocation ciblée.

Le refresh **n'est jamais stocké en clair** côté serveur : seul son SHA-256 est
en base. Un dump de la table ne permet donc pas de rejouer un refresh.

### Pourquoi ce modèle

Un seul JWT longue durée en `localStorage` serait volable par XSS. Ici :
access court + refresh en cookie **httpOnly** (inaccessible au JavaScript),
avec rotation et détection de vol. C'est la réponse attendue à la question
« où stockez-vous le JWT ? ».

## Stratégie de cookies

Posés par `setAuthCookies()` ([auth.js:35](../AkinatorWeb/backend/routes/auth.js)) :

- **`access_token`** : `httpOnly`, `secure` (prod), `sameSite=strict`, `path=/`, 15 min.
- **`refresh_token`** : mêmes flags, mais **`path=/api/auth`**, 7 j.

Le `path=/api/auth` est délibéré : le refresh n'est envoyé par le navigateur
qu'aux routes `/api/auth/refresh` et `/api/auth/logout`. Il ne « traîne » donc
pas sur chaque requête API, réduisant sa surface d'exposition.

Le header `Authorization: Bearer` reste accepté en lecture (compat/tests), mais
le cookie httpOnly est prioritaire.

## Flux de connexion

### Cas simple (sans 2FA)
`POST /api/auth/login` → vérifie le mot de passe (bcrypt), gère le
verrouillage (`failed_login_attempts`, `locked_until` : 15 min après 5 échecs)
→ `issueTokenPair()` → `setAuthCookies()` → renvoie le profil.

### Cas 2FA activé
1. `POST /api/auth/login` valide le mot de passe mais **ne pose PAS les cookies de session**. Il renvoie un **`tempToken`** = JWT court avec `{ pending2FA: true }`.
2. `POST /api/auth/verify-login-a2f` vérifie le code (TOTP via speakeasy **ou** un code de secours), puis seulement là émet la vraie paire de tokens et pose les cookies.

**Garde-fou critique** : un `tempToken` (`pending2FA:true`) ne doit jamais
ouvrir une session. `authenticateToken` **rejette explicitement** tout token
portant `pending2FA` ([security.js:174](../AkinatorWeb/backend/middleware/security.js)),
et `optionalAuth` le traite comme non authentifié. Sans cette garde, un
attaquant pourrait présenter le tempToken directement et contourner le 2FA.

## Rotation & détection de réutilisation

Au refresh (`POST /api/auth/refresh` → `rotateRefreshToken()`,
[tokenService.js:64](../AkinatorWeb/backend/services/tokenService.js)) :

1. On retrouve la ligne par `token_hash`. Inconnue → refus.
2. Si elle est **déjà `used_at` ou `revoked`** → **réutilisation** : le token
   avait déjà servi. C'est le signe d'un vol (l'attaquant rejoue un vieux
   refresh). On **révoque toute la famille** (`family_id`) → les deux copies
   (légitime et volée) sont invalidées, forçant une reconnexion propre.
3. Si expiré → refus.
4. Sinon : on marque l'ancien `used_at`, on émet un nouveau refresh **dans la
   même famille**, et une nouvelle paire. Chaque refresh est donc **à usage
   unique**.

La `family_id` relie tous les refresh issus d'une même connexion initiale :
c'est l'unité de révocation en cas de vol détecté.

## Révocation

| Événement | Mécanisme |
|-----------|-----------|
| **Logout** | `revokeAccessToken(jti)` insère le `jti` dans `revoked_tokens` (blacklist consultée à chaque requête) + `revokeFamilyByToken(refresh)` révoque la famille. Cookies effacés. |
| **Changement de mot de passe** | voir ci-dessous. |
| **Réutilisation de refresh** | `revokeFamily(family_id)` (détection de vol). |
| **Rotation de `JWT_SECRET`** | invalide *tous* les access tokens (signature) ; les refresh persistés forcent une reconnexion. |

Purge : `purgeExpiredTokens()` nettoie `refresh_tokens` et `revoked_tokens`
expirés (appelée par le cycle de nettoyage).

## Invalidation de session au changement de mot de passe

Problème résolu : après un changement/réinitialisation de mot de passe, les
sessions déjà ouvertes (potentiellement celles d'un attaquant) doivent tomber.

Mécanisme :

1. `users.password_changed_at` (secondes Unix) est mis à jour lors d'un
   `change-password` **et** d'un `forgot-password`.
2. Toutes les familles de refresh de l'utilisateur sont révoquées via
   `revokeAllUserFamilies(userId)`.
3. À chaque requête, `authenticateToken` recharge le compte et **rejette tout
   access token dont `iat < password_changed_at`**
   ([security.js:200](../AkinatorWeb/backend/middleware/security.js)).

Subtilités assumées, documentées dans le code :

- **Granularité 1 s** : `iat` est en secondes. La comparaison est `<` stricte,
  donc un token émis *dans la même seconde* que le changement survit. C'est
  volontaire : cela permet à `change-password` de **ré-émettre immédiatement**
  une paire fraîche pour la session courante (l'utilisateur qui change son mot
  de passe n'est pas déconnecté), tout en tuant toutes les sessions antérieures.
  Fenêtre de tolérance ≤ 1 s, à comparer au TTL de 15 min.
- **Coût** : un `findById` (SELECT sur clé primaire indexée) est ajouté à chaque
  requête authentifiée. Compromis accepté pour la garantie de sécurité.
- `optionalAuth` applique la même règle mais **sans jamais bloquer** : un token
  invalidé fait juste retomber la requête en « non authentifié ».

Différence entre les deux routes :

- `change-password` (utilisateur connecté) : ré-émet une paire fraîche → la
  session courante **survit**, les autres tombent.
- `forgot-password` (non authentifié) : invalide **toutes** les sessions, aucune
  n'est ré-émise. Un événement `auth.password.reset` est ajouté au journal d'audit.

Dans les deux cas, le nouveau mot de passe passe par `validateNewPassword()`
(score `zxcvbn` ≥ 3 + HaveIBeenPwned) : une réinitialisation ne peut pas servir à
poser un mot de passe plus faible que ce que l'inscription aurait accepté.

## Récupération de compte (`forgot-password`)

Le projet ne stocke **pas d'email** (minimisation RGPD, migration
`remove-email-column`). Il n'y a donc pas de lien de réinitialisation par mail :
la récupération s'adosse au **second facteur**.

`POST /api/auth/forgot-password` attend `{ username, a2fCode, newPassword }` et
exige que l'A2F soit **activée** sur le compte. La vérification suit l'ordre :
compte introuvable → délai constant de 500 ms puis message générique (pas
d'énumération) ; A2F non activée → message d'orientation vers un administrateur ;
code TOTP invalide → 401.

**Corollaire assumé** : un compte sans A2F ne peut pas être récupéré en
libre-service. C'est le prix de l'absence d'email — le canal de récupération
serait sinon plus faible que l'authentification qu'il contourne.

## Ordre des vérifications dans `authenticateToken`

Pour référence, la séquence exacte (échec = 401/403) :

1. Présence d'un token (cookie prioritaire, sinon header).
2. `jwt.verify` (signature + expiration), algorithme forcé (`HS256`).
3. Rejet si `pending2FA`.
4. Rejet si `jti` dans `revoked_tokens` (logout).
5. Rechargement du compte : rejet si introuvable, ou si `iat < password_changed_at`.
6. `req.user = decoded` puis `next()`.

## Traçabilité

Les événements sensibles (connexion, échec, 2FA, changement/réinit de mot de
passe, actions admin) sont journalisés via `appendAudit(...)` dans le journal
inviolable. Voir [securite.md](./securite.md#journal-daudit-inviolable).
