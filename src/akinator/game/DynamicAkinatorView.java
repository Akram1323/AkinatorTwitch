package akinator.game;

import javax.swing.*;
import java.awt.*;
import java.sql.Connection;
import java.util.List;
import java.util.ArrayList;
import java.util.stream.Collectors;

public class DynamicAkinatorView extends JFrame {

    private final List<bdd.Question> appliedFilters = new ArrayList<>();

    private JPanel buttonsPanel;
    private JLabel questionLabel;
    private JTextArea filtersArea;
    private JTextArea recommendationsArea;
    private JButton backButton;

    public DynamicAkinatorView(Connection conn) {
        super("Akinator Dynamique");

        setDefaultCloseOperation(JFrame.EXIT_ON_CLOSE);
        setSize(600, 400);
        setLocationRelativeTo(null);

        questionLabel = new JLabel("", SwingConstants.CENTER);
        questionLabel.setFont(new Font("Arial", Font.BOLD, 16));

        filtersArea = new JTextArea(2, 50);
        filtersArea.setEditable(false);
        filtersArea.setLineWrap(true);

        recommendationsArea = new JTextArea(4, 50);
        recommendationsArea.setEditable(false);
        recommendationsArea.setLineWrap(true);

        buttonsPanel = new JPanel(new GridLayout(0, 1, 10, 10));

        backButton = new JButton("Retour");
        backButton.setEnabled(false);
        backButton.addActionListener(e -> {
            if (!appliedFilters.isEmpty()) {
                appliedFilters.remove(appliedFilters.size() - 1);
                updateView();
            }
        });

        JPanel topPanel = new JPanel(new BorderLayout());
        topPanel.add(questionLabel, BorderLayout.CENTER);
        topPanel.add(backButton, BorderLayout.WEST);

        getContentPane().setLayout(new BorderLayout(10, 10));
        getContentPane().add(topPanel, BorderLayout.NORTH);
        getContentPane().add(new JScrollPane(buttonsPanel), BorderLayout.CENTER);
        getContentPane().add(new JScrollPane(filtersArea), BorderLayout.WEST);
        getContentPane().add(new JScrollPane(recommendationsArea), BorderLayout.SOUTH);

        updateView();
        setVisible(true);
    }

    private void updateView() {
        buttonsPanel.removeAll();
        filtersArea.setText(String.join(" > ", appliedFilters.stream().map(bdd.Question::getText).toList()));
        recommendationsArea.setText("");

        List<String> path = appliedFilters.stream().map(bdd.Question::getText).toList();
        List<ChoixNode> children = GameTree.getChildrenByPath(path);

        if (appliedFilters.isEmpty()) {
    questionLabel.setText("Vous recherchez ?");
    List<ChoixNode> rootChildren = GameTree.getRootNode().getListChildNodes();
    for (ChoixNode node : rootChildren) {
        JButton btn = new JButton(node.getDecision());
        btn.addActionListener(e -> {
            appliedFilters.add(new bdd.Question(
                node.getId(),
                node.getDecision(),
                node.getTempParentId(),
                0
            ));
            updateView();
        });
        buttonsPanel.add(btn);
            }
        }
         else if (!children.isEmpty()) {
            questionLabel.setText("Choisissez une catégorie :");
            for (ChoixNode node : children) {
                JButton btn = new JButton(node.getDecision());
                btn.addActionListener(e -> {
                    appliedFilters.add(new bdd.Question(
                        node.getId(),
                        node.getDecision(),
                        node.getTempParentId(),
                        0 // profondeur non utilisée
                    ));
                    updateView();
                });
                buttonsPanel.add(btn);
            }

            JButton recommendNow = new JButton("Voir les recommandations maintenant");
            recommendNow.addActionListener(e -> showRecommendations());
            buttonsPanel.add(recommendNow);

        } else {
            showRecommendations();
        }

        backButton.setEnabled(!appliedFilters.isEmpty());
        buttonsPanel.revalidate();
        buttonsPanel.repaint();
    }

    private void showRecommendations() {
        StringBuilder sb = new StringBuilder();
        sb.append("Recommandations pour : \n");
        for (bdd.Question q : appliedFilters) {
            sb.append("- ").append(q.getText()).append("\n");
        }

        List<String> games = IGDBClient.searchGamesByStructuredFilters(appliedFilters);

        if (games.isEmpty()) {
            sb.append("\nAucune recommandation trouvée sur IGDB.");
        } else {
            sb.append("\nJeux recommandés :\n");
            for (String game : games) {
                sb.append("- ").append(game).append("\n");
            }
        }

        recommendationsArea.setText(sb.toString());
    }
}
