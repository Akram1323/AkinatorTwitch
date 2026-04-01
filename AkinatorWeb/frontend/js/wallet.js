/**
 * Wallet - Intégration Web3 / MetaMask
 * Connexion wallet et paiements crypto
 * 
 * @author AkinatorTwitch Team
 * @version 2.0
 */

const Wallet = {
    provider: null,
    signer: null,
    address: null,
    chainId: null,
    
    // Polygon Mainnet
    POLYGON_CHAIN_ID: '0x89', // 137 en décimal
    POLYGON_RPC: 'https://polygon-rpc.com',
    
    /**
     * Vérifie si MetaMask est installé
     */
    isMetaMaskInstalled() {
        return typeof window.ethereum !== 'undefined' && window.ethereum.isMetaMask;
    },

    /**
     * Connecte le wallet MetaMask
     */
    async connect() {
        if (!this.isMetaMaskInstalled()) {
            throw new Error('MetaMask n\'est pas installé. Installez-le depuis metamask.io');
        }

        try {
            // Demander la connexion
            const accounts = await window.ethereum.request({
                method: 'eth_requestAccounts'
            });

            if (accounts.length === 0) {
                throw new Error('Aucun compte sélectionné');
            }

            this.address = accounts[0];
            this.chainId = await window.ethereum.request({ method: 'eth_chainId' });

            // Vérifier le réseau (Polygon)
            if (this.chainId !== this.POLYGON_CHAIN_ID) {
                await this.switchToPolygon();
            }

            // Écouter les changements
            window.ethereum.on('accountsChanged', (accounts) => {
                if (accounts.length === 0) {
                    this.disconnect();
                } else {
                    this.address = accounts[0];
                    window.dispatchEvent(new CustomEvent('walletChanged', { detail: { address: this.address } }));
                }
            });

            window.ethereum.on('chainChanged', (chainId) => {
                this.chainId = chainId;
                window.location.reload();
            });

            console.log('✅ Wallet connecté:', this.address);
            return this.address;

        } catch (error) {
            console.error('Erreur connexion wallet:', error);
            throw error;
        }
    },

    /**
     * Déconnecte le wallet
     */
    disconnect() {
        this.address = null;
        this.chainId = null;
        window.dispatchEvent(new CustomEvent('walletDisconnected'));
    },

    /**
     * Change le réseau vers Polygon
     */
    async switchToPolygon() {
        try {
            await window.ethereum.request({
                method: 'wallet_switchEthereumChain',
                params: [{ chainId: this.POLYGON_CHAIN_ID }]
            });
        } catch (switchError) {
            // Le réseau n'existe pas, on l'ajoute
            if (switchError.code === 4902) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: this.POLYGON_CHAIN_ID,
                        chainName: 'Polygon Mainnet',
                        nativeCurrency: {
                            name: 'MATIC',
                            symbol: 'MATIC',
                            decimals: 18
                        },
                        rpcUrls: [this.POLYGON_RPC],
                        blockExplorerUrls: ['https://polygonscan.com']
                    }]
                });
            } else {
                throw switchError;
            }
        }
    },

    /**
     * Envoie une transaction de paiement
     */
    async sendPayment(toAddress, amountWei) {
        if (!this.address) {
            throw new Error('Wallet non connecté');
        }

        try {
            const txHash = await window.ethereum.request({
                method: 'eth_sendTransaction',
                params: [{
                    from: this.address,
                    to: toAddress,
                    value: '0x' + BigInt(amountWei).toString(16),
                    chainId: this.POLYGON_CHAIN_ID
                }]
            });

            console.log('✅ Transaction envoyée:', txHash);
            return txHash;

        } catch (error) {
            if (error.code === 4001) {
                throw new Error('Transaction annulée par l\'utilisateur');
            }
            throw error;
        }
    },

    /**
     * Récupère le solde MATIC
     */
    async getBalance() {
        if (!this.address) return '0';

        const balance = await window.ethereum.request({
            method: 'eth_getBalance',
            params: [this.address, 'latest']
        });

        // Convertir de Wei en MATIC
        return (parseInt(balance, 16) / 1e18).toFixed(4);
    },

    /**
     * Formate une adresse pour l'affichage
     */
    formatAddress(address) {
        if (!address) return '';
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    },

    /**
     * Vérifie si connecté
     */
    isConnected() {
        return this.address !== null;
    }
};
