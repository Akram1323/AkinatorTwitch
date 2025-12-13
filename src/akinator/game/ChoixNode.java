package akinator.game;

import java.util.ArrayList;
import java.util.List;

public class ChoixNode {
    private int id;
    private String decision;
    private String slug;
    private boolean isFilter; // false = ne doit pas apparaître dans la requête IGDB
    private int tempParentId; // utilisé pour construire l’arbre
    private List<ChoixNode> children;

    public ChoixNode(int id, String decision, String slug, boolean isFilter) {
        this.id = id;
        this.decision = decision;
        this.slug = slug;
        this.isFilter = isFilter;
        this.children = new ArrayList<>();
    }

    public void addChild(ChoixNode child) {
        children.add(child);
    }

    public List<ChoixNode> getListChildNodes() {
        return children;
    }

    public String getDecision() {
        return decision;
    }

    public String getSlug() {
        return slug;
    }

    public boolean isFilter() {
        return isFilter;
    }

    public int getId() {
        return id;
    }

    public void setTempParentId(int id) {
        this.tempParentId = id;
    }

    public int getTempParentId() {
        return tempParentId;
    }

    // Optionnel : affichage récursif (pour debug)
    public void printTree(String prefix) {
        System.out.println(prefix + "- " + decision + (isFilter ? " [filter]" : ""));
        for (ChoixNode child : children) {
            child.printTree(prefix + "  ");
        }
    }
}
