/**
 * Demandes de jetons adressées aux administrateurs.
 * Couvre : création (validation, unicité de la demande en attente), lecture,
 * approbation (crédit + transaction + audit), refus, idempotence et contrôle d'accès.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { app, db } = require('./helpers/setup');

const MDP = 'C0rrect!Horse#Battery9';
const ADMIN = { username: 'admindemandes', password: MDP, rgpdConsent: true };
const JOUEUR = { username: 'joueurdemandes', password: MDP, rgpdConsent: true };
const AUTRE = { username: 'autredemandes', password: MDP, rgpdConsent: true };

async function login(user) {
    const res = await request(app).post('/api/auth/login').send({ username: user.username, password: user.password });
    const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
    const csrf = await request(app).get('/api/csrf-token').set('Cookie', cookie);
    return { cookie, csrfToken: csrf.body.data.csrfToken };
}

/**
 * Base repartie de zéro à chaque test : les comptes sont recréés et la table des
 * demandes vidée, sinon l'index unique partiel ferait échouer le 2e test venu.
 */
async function setupUsers() {
    db.prepare('DELETE FROM token_requests').run();
    for (const u of [ADMIN, JOUEUR, AUTRE]) {
        if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username)) {
            await request(app).post('/api/auth/register').send(u);
        }
    }
    db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(ADMIN.username);
    db.prepare('UPDATE users SET is_admin = 0 WHERE username IN (?, ?)').run(JOUEUR.username, AUTRE.username);
    return {
        joueur: db.prepare('SELECT id, tokens FROM users WHERE username = ?').get(JOUEUR.username),
        autre: db.prepare('SELECT id, tokens FROM users WHERE username = ?').get(AUTRE.username)
    };
}

function demander(ctx, body) {
    return request(app).post('/api/tokens/requests')
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send(body);
}

function resoudre(ctx, id, decision) {
    return request(app).post(`/api/admin/token-requests/${id}/${decision}`)
        .set('Cookie', ctx.cookie).set('X-CSRF-Token', ctx.csrfToken).send({});
}

test('une demande valide est créée en statut pending', async () => {
    await setupUsers();
    const ctx = await login(JOUEUR);

    const res = await demander(ctx, { amount: 25, reason: 'Je veux tester le mode recommandation' });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.data.status, 'pending');
    assert.strictEqual(res.body.data.amount, 25);

    const inDb = db.prepare('SELECT * FROM token_requests WHERE id = ?').get(res.body.data.id);
    assert.ok(inDb, 'la demande doit être persistée');
    assert.strictEqual(inDb.status, 'pending');
    assert.strictEqual(inDb.resolved_at, null);
});

test('validations : montant entier 1..100 et motif de 3 à 200 caractères', async () => {
    await setupUsers();
    const ctx = await login(JOUEUR);

    for (const body of [
        { amount: 0, reason: 'motif valable' },                       // trop bas
        { amount: 101, reason: 'motif valable' },                     // au-dessus du plafond
        { amount: 2.5, reason: 'motif valable' },                     // non entier
        { amount: '25', reason: 'motif valable' },                    // mauvais type
        { amount: 25 },                                               // motif absent
        { amount: 25, reason: '  ' },                                 // motif vide après trim
        { amount: 25, reason: 'ab' },                                 // motif trop court
        { amount: 25, reason: 'x'.repeat(201) }                       // motif trop long
    ]) {
        const res = await demander(ctx, body);
        assert.strictEqual(res.status, 400, `body ${JSON.stringify(body)} doit être refusé`);
    }

    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM token_requests').get().c, 0);
});

test('une seule demande en attente à la fois (409)', async () => {
    await setupUsers();
    const ctx = await login(JOUEUR);

    assert.strictEqual((await demander(ctx, { amount: 10, reason: 'première demande' })).status, 201);

    const doublon = await demander(ctx, { amount: 5, reason: 'seconde demande' });
    assert.strictEqual(doublon.status, 409);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM token_requests').get().c, 1);
});

test('une nouvelle demande est possible après résolution de la précédente', async () => {
    await setupUsers();
    const joueurCtx = await login(JOUEUR);
    const adminCtx = await login(ADMIN);

    const first = await demander(joueurCtx, { amount: 10, reason: 'première demande' });
    assert.strictEqual((await resoudre(adminCtx, first.body.data.id, 'reject')).status, 200);

    const second = await demander(joueurCtx, { amount: 15, reason: 'nouvelle tentative' });
    assert.strictEqual(second.status, 201);
});

test("l'approbation crédite le demandeur et trace une transaction admin_grant", async () => {
    const { joueur } = await setupUsers();
    const joueurCtx = await login(JOUEUR);
    const adminCtx = await login(ADMIN);

    const demande = await demander(joueurCtx, { amount: 20, reason: 'besoin de jetons' });
    const res = await resoudre(adminCtx, demande.body.data.id, 'approve');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.oldBalance, joueur.tokens);
    assert.strictEqual(res.body.data.newBalance, joueur.tokens + 20);

    assert.strictEqual(db.prepare('SELECT tokens FROM users WHERE id = ?').get(joueur.id).tokens, joueur.tokens + 20);

    const ligne = db.prepare('SELECT * FROM token_requests WHERE id = ?').get(demande.body.data.id);
    assert.strictEqual(ligne.status, 'approved');
    assert.ok(ligne.resolved_at, 'resolved_at doit être renseigné');
    assert.ok(ligne.resolved_by, 'resolved_by doit être renseigné');

    const tx = db.prepare("SELECT * FROM transactions WHERE user_id = ? AND type = 'admin_grant' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(joueur.id);
    assert.ok(tx, 'une transaction admin_grant doit être créée');
    assert.strictEqual(tx.amount, 20);

    const audit = db.prepare("SELECT * FROM audit_log WHERE event_type = 'admin.token_request.approve' ORDER BY id DESC LIMIT 1").get();
    assert.ok(audit, "l'approbation doit être auditée");
    assert.strictEqual(JSON.parse(audit.details).amount, 20);

    // Bout-en-bout : l'entrée doit REMONTER par la requête exacte que fait le
    // tableau « Attributions de crédits » du panneau admin. Elle était bien
    // écrite mais jamais affichée, le tableau ne demandant qu'un seul type.
    const journal = await request(app)
        .get('/api/admin/audit?event_type=' + encodeURIComponent('admin.user.tokens,admin.token_request.approve') + '&limit=50')
        .set('Cookie', adminCtx.cookie);
    assert.strictEqual(journal.status, 200);
    const affichee = journal.body.data.entries.find(e => e.id === audit.id);
    assert.ok(affichee, "l'approbation doit apparaître dans le journal affiché au panneau admin");
    assert.strictEqual(JSON.parse(affichee.details).targetUsername, JOUEUR.username);
});

test('le refus ne crédite rien et clôt la demande', async () => {
    const { joueur } = await setupUsers();
    const joueurCtx = await login(JOUEUR);
    const adminCtx = await login(ADMIN);

    const demande = await demander(joueurCtx, { amount: 30, reason: 'demande abusive' });
    const res = await resoudre(adminCtx, demande.body.data.id, 'reject');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.newBalance, joueur.tokens);
    assert.strictEqual(db.prepare('SELECT tokens FROM users WHERE id = ?').get(joueur.id).tokens, joueur.tokens);
    assert.strictEqual(db.prepare('SELECT status FROM token_requests WHERE id = ?').get(demande.body.data.id).status, 'rejected');
});

test('une demande déjà traitée ne peut pas être re-créditée (409)', async () => {
    const { joueur } = await setupUsers();
    const joueurCtx = await login(JOUEUR);
    const adminCtx = await login(ADMIN);

    const demande = await demander(joueurCtx, { amount: 20, reason: 'besoin de jetons' });
    assert.strictEqual((await resoudre(adminCtx, demande.body.data.id, 'approve')).status, 200);

    const rejeu = await resoudre(adminCtx, demande.body.data.id, 'approve');
    assert.strictEqual(rejeu.status, 409);

    // Le solde n'a été crédité qu'une fois.
    assert.strictEqual(db.prepare('SELECT tokens FROM users WHERE id = ?').get(joueur.id).tokens, joueur.tokens + 20);
});

test('le panneau admin liste les demandes en attente avec le pseudo du demandeur', async () => {
    await setupUsers();
    const joueurCtx = await login(JOUEUR);
    const autreCtx = await login(AUTRE);
    const adminCtx = await login(ADMIN);

    await demander(joueurCtx, { amount: 10, reason: 'demande A' });
    await demander(autreCtx, { amount: 20, reason: 'demande B' });

    const res = await request(app).get('/api/admin/token-requests').set('Cookie', adminCtx.cookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.length, 2);

    const pseudos = res.body.data.map(d => d.username).sort();
    assert.deepStrictEqual(pseudos, [AUTRE.username, JOUEUR.username].sort());
    assert.ok(res.body.data.every(d => d.status === 'pending'));
});

test("un joueur ne voit que ses propres demandes et n'accède pas aux routes admin", async () => {
    await setupUsers();
    const joueurCtx = await login(JOUEUR);
    const autreCtx = await login(AUTRE);

    const mienne = await demander(joueurCtx, { amount: 10, reason: 'ma demande' });
    await demander(autreCtx, { amount: 20, reason: "demande d'un autre" });

    const liste = await request(app).get('/api/tokens/requests').set('Cookie', joueurCtx.cookie);
    assert.strictEqual(liste.status, 200);
    assert.strictEqual(liste.body.data.length, 1);
    assert.strictEqual(liste.body.data[0].id, mienne.body.data.id);

    assert.strictEqual((await request(app).get('/api/admin/token-requests').set('Cookie', joueurCtx.cookie)).status, 403);
    assert.strictEqual((await resoudre(joueurCtx, mienne.body.data.id, 'approve')).status, 403);
});

test('les routes de demande exigent authentification et token CSRF', async () => {
    await setupUsers();
    const ctx = await login(JOUEUR);

    // Anonyme
    const anonyme = await request(app).post('/api/tokens/requests').send({ amount: 10, reason: 'anonyme' });
    assert.strictEqual(anonyme.status, 401);

    // Authentifié mais sans en-tête CSRF
    const sansCsrf = await request(app).post('/api/tokens/requests')
        .set('Cookie', ctx.cookie).send({ amount: 10, reason: 'sans csrf' });
    assert.strictEqual(sansCsrf.status, 403);

    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM token_requests').get().c, 0);
});

test('une demande inexistante renvoie 404', async () => {
    await setupUsers();
    const adminCtx = await login(ADMIN);
    assert.strictEqual((await resoudre(adminCtx, 'id-inexistant', 'approve')).status, 404);
});
