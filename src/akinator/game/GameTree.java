package akinator.game;

import java.sql.*;
import java.util.*;

public class GameTree {
    private static ChoixNode rootNode = new ChoixNode(0, "Vous recherchez ?", null, false);
    private static final Map<Integer, ChoixNode> nodeMap = new HashMap<>();

    public static void buildTreeFromDatabase(Connection conn) throws SQLException {
    nodeMap.clear();
    rootNode = new ChoixNode(0, "Vous recherchez ?", null, false);
    nodeMap.put(0, rootNode);

    String query = "SELECT id, question_text, slug_igdb, parent_id, is_filter FROM questions";
    try (PreparedStatement stmt = conn.prepareStatement(query);
         ResultSet rs = stmt.executeQuery()) {

        while (rs.next()) {
            int id = rs.getInt("id");
            String question = rs.getString("question_text");
            String slug = rs.getString("slug_igdb");
            int parentId = rs.getInt("parent_id");
            boolean isFilter = rs.getBoolean("is_filter");

            ChoixNode node = new ChoixNode(id, question, slug, isFilter);
            node.setTempParentId(parentId);
            nodeMap.put(id, node);
        }

        for (ChoixNode node : nodeMap.values()) {
            if (node.getId() == 0) continue;
            int parentId = node.getTempParentId();
            ChoixNode parent = nodeMap.get(parentId);
            if (parent != null) {
                parent.addChild(node);
            }
        }
    }
}

    public static List<ChoixNode> getChildrenByPath(List<String> path) {
    ChoixNode current = rootNode;
    for (String label : path) {
        Optional<ChoixNode> next = current.getListChildNodes().stream()
            .filter(c -> c.getDecision().equalsIgnoreCase(label))
            .findFirst();
        if (next.isPresent()) {
            current = next.get();
        } else {
            return Collections.emptyList();
        }
    }
    return current.getListChildNodes(); // enfants directs du dernier choix
}


    public static ChoixNode getRootNode() {
        return rootNode;
    }
}