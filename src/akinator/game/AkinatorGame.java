// ======= FICHIER : AkinatorGame.java =======
package akinator.game;

import javax.swing.*;
import java.sql.Connection;

public class AkinatorGame {
    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            try {
                Connection conn = bdd.getConnection(); // ✅ Connexion via bdd.java
                GameTree.buildTreeFromDatabase(conn); // ✅ Construction arbre
                new DynamicAkinatorView(conn);         // ✅ Lancement UI
            } catch (Exception e) {
                JOptionPane.showMessageDialog(null, "Erreur : " + e.getMessage(), "Erreur", JOptionPane.ERROR_MESSAGE);
                e.printStackTrace();
            }
        });
    }
}