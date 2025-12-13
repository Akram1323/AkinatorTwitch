package akinator.game;

import java.sql.*;
import java.util.ArrayList;
import java.util.List;

public class bdd {

    private static final String DB_PATH = "C:\\Users\\Akram\\Documents\\NetBeansProjects\\Akinator_game\\Akinator_game\\src\\akinator\\game\\game";
    private static final String URL = "jdbc:sqlite:" + DB_PATH;

    // Ouvre une connexion à la base SQLite
    public static Connection getConnection() throws SQLException {
        return DriverManager.getConnection(URL);
    }

    // Récupère les questions par profondeur
    public static List<Question> getQuestionsByDepth(int profondeur) {
        List<Question> questions = new ArrayList<>();
        String sql = "SELECT id, question_text, parent_id FROM questions WHERE profondeur = ?";

        try (Connection conn = getConnection();
             PreparedStatement pstmt = conn.prepareStatement(sql)) {

            pstmt.setInt(1, profondeur);
            ResultSet rs = pstmt.executeQuery();

            while (rs.next()) {
                int id = rs.getInt("id");
                String texte = rs.getString("question_text");
                int parentId = rs.getInt("parent_id");
                if (rs.wasNull()) parentId = -1;  // gérer parent_id NULL

                questions.add(new Question(id, texte, parentId, profondeur));
            }

        } catch (SQLException e) {
            System.err.println("Erreur getQuestionsByDepth : " + e.getMessage());
        }

        return questions;
    }

    // Insère une recommandation liée à une question
    public static boolean insertRecommendation(int questionId, String gameName) {
        String sql = "INSERT INTO recommandations(question_id, game_name) VALUES (?, ?)";

        try (Connection conn = getConnection();
             PreparedStatement pstmt = conn.prepareStatement(sql)) {

            pstmt.setInt(1, questionId);
            pstmt.setString(2, gameName);
            pstmt.executeUpdate();
            return true;

        } catch (SQLException e) {
            System.err.println("Erreur insertRecommendation : " + e.getMessage());
            return false;
        }
    }

    // Classe interne pour représenter une question
    public static class Question {
        private int id;
        private String text;
        private int parentId;
        private int profondeur;

        public Question(int id, String text, int parentId, int profondeur) {
            this.id = id;
            this.text = text;
            this.parentId = parentId;
            this.profondeur = profondeur;
        }

        public int getId() { return id; }
        public String getText() { return text; }
        public int getParentId() { return parentId; }
        public int getProfondeur() { return profondeur; }

        @Override
        public String toString() {
            return "Question{id=" + id + ", text='" + text + "', parentId=" + parentId + ", profondeur=" + profondeur + '}';
        }
    }

    // Méthode test
    public static void main(String[] args) {
        System.out.println("Test récupération questions profondeur 1 :");
        List<Question> questions = getQuestionsByDepth(1);
        for (Question q : questions) {
            System.out.println(q);
        }

        // Exemple insertion recommandation
        // boolean ok = insertRecommendation(1, "The Witcher 3");
        // System.out.println("Insertion recommandation ok ? " + ok);
    }
}
