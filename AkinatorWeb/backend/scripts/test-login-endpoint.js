/**
 * Script pour tester l'endpoint de login directement
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testLogin() {
    try {
        console.log('🔍 Test de l\'endpoint /api/auth/login...\n');
        
        const response = await axios.post(`${BASE_URL}/api/auth/login`, {
            username: 'Akinator',
            password: '6?;8aH3V3yBe@r'
        }, {
            validateStatus: () => true // Accepter tous les codes de statut
        });
        
        console.log('📊 Réponse du serveur:');
        console.log(`   Status: ${response.status}`);
        console.log(`   Data:`, JSON.stringify(response.data, null, 2));
        
        if (response.status === 200 && response.data.success) {
            console.log('\n✅ Connexion réussie !');
        } else {
            console.log('\n❌ Connexion échouée');
            console.log(`   Erreur: ${response.data.error || 'Erreur inconnue'}`);
        }
        
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            console.error('❌ Impossible de se connecter au serveur');
            console.error('   Assurez-vous que le serveur est démarré sur le port 3000');
        } else if (error.response) {
            console.error('❌ Erreur HTTP:', error.response.status);
            console.error('   Data:', error.response.data);
        } else {
            console.error('❌ Erreur:', error.message);
            console.error('   Stack:', error.stack);
        }
    }
}

testLogin();
