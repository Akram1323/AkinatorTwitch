/**
 * Lecture des horodatages SQLite — le piège qui a rendu le verrouillage de compte
 * inopérant pendant toute la vie du projet.
 *
 * Ces tests s'exécutent dans des SOUS-PROCESSUS avec un TZ imposé. C'est
 * indispensable : le bug ne se manifeste que hors UTC, or la CI GitHub tourne en
 * UTC. Un test qui se contenterait du fuseau ambiant passerait au vert en CI même
 * si le bug était réintroduit — il ne protégerait rien.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const MODULE = path.join(__dirname, '..', 'services', 'sqliteDate.js');

// Fuseaux volontairement de part et d'autre d'UTC, plus UTC lui-même.
const FUSEAUX = ['Asia/Tokyo', 'America/New_York', 'Europe/Paris', 'UTC'];

/** Évalue une expression JS dans un sous-processus dont le TZ est imposé. */
function dansLeFuseau(tz, expression) {
    const script = `const { parseSqliteDate, isStillActive } = require(${JSON.stringify(MODULE)});`
        + ` process.stdout.write(String(${expression}));`;
    return execFileSync(process.execPath, ['-e', script], {
        env: { ...process.env, TZ: tz },
        encoding: 'utf8'
    });
}

test('un horodatage SQLite est lu comme de l\'UTC, quel que soit le fuseau du serveur', () => {
    for (const tz of FUSEAUX) {
        const iso = dansLeFuseau(tz, `parseSqliteDate('2026-07-25 10:00:00').toISOString()`);
        assert.strictEqual(iso, '2026-07-25T10:00:00.000Z',
            `en ${tz}, l'horodatage doit désigner le même instant absolu`);
    }
});

test('le piège est réel : new Date() décale le même horodatage hors UTC', () => {
    // Documente POURQUOI parseSqliteDate existe. Si ce test échoue un jour, c'est
    // que Node a changé sa tolérance de parsing — et parseSqliteDate devient
    // peut-être superflu.
    const naif = dansLeFuseau('Asia/Tokyo', `new Date('2026-07-25 10:00:00').toISOString()`);
    assert.notStrictEqual(naif, '2026-07-25T10:00:00.000Z',
        'new Date() interprète la chaîne en heure locale — c\'est la cause du bug');
});

test('un verrou de 15 minutes est bien vu comme actif hors UTC', () => {
    // Reproduction exacte du bug : SQLite écrit `datetime('now','+15 minutes')` en
    // UTC ; en Europe/Paris (UTC+2 l'été) la lecture naïve le plaçait 2 h dans le
    // passé, donc le compte n'était jamais verrouillé.
    for (const tz of FUSEAUX) {
        const actif = dansLeFuseau(tz,
            `isStillActive(new Date(Date.now() + 15 * 60000).toISOString().slice(0, 19).replace('T', ' '))`);
        assert.strictEqual(actif, 'true', `en ${tz}, un verrou posé pour 15 minutes doit être actif`);
    }
});

test('un verrou échu est vu comme expiré', () => {
    for (const tz of FUSEAUX) {
        const actif = dansLeFuseau(tz,
            `isStillActive(new Date(Date.now() - 60000).toISOString().slice(0, 19).replace('T', ' '))`);
        assert.strictEqual(actif, 'false', `en ${tz}, un verrou dépassé d'une minute doit être expiré`);
    }
});

test('absence de verrou = pas de verrou', () => {
    assert.strictEqual(dansLeFuseau('Asia/Tokyo', `isStillActive(null)`), 'false');
    assert.strictEqual(dansLeFuseau('Asia/Tokyo', `isStillActive(undefined)`), 'false');
    assert.strictEqual(dansLeFuseau('Asia/Tokyo', `isStillActive('')`), 'false');
});

test('FAIL-CLOSED : un horodatage illisible est traité comme un verrou actif', () => {
    // Un dump restauré de travers ou une migration bancale ne doit jamais
    // déverrouiller un compte. Le coût d'un faux positif est une attente ;
    // celui d'un faux négatif est un contrôle de sécurité contourné.
    assert.strictEqual(dansLeFuseau('UTC', `isStillActive('pas-une-date')`), 'true');
    assert.strictEqual(dansLeFuseau('UTC', `parseSqliteDate('pas-une-date')`), 'null');
});

test('une chaîne portant déjà un fuseau est respectée', () => {
    const iso = dansLeFuseau('Asia/Tokyo', `parseSqliteDate('2026-07-25T10:00:00+02:00').toISOString()`);
    assert.strictEqual(iso, '2026-07-25T08:00:00.000Z', 'le décalage explicite ne doit pas être écrasé');
});
