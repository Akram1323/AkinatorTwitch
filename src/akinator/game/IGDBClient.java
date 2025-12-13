package akinator.game;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;

import org.json.JSONArray;
import org.json.JSONObject;

public class IGDBClient {
    private static final String IGDB_URL = "https://api.igdb.com/v4/games";
    private static final String GENRES_URL = "https://api.igdb.com/v4/genres";
    private static final String PLATFORMS_URL = "https://api.igdb.com/v4/platforms";
    private static final String THEMES_URL = "https://api.igdb.com/v4/themes";
    private static final String GAMEMODES_URL = "https://api.igdb.com/v4/game_modes";
    private static final String CLIENT_ID = "u21n40pgrp5j141wxhjjm7ywrvfhsd";

    /**
     * Interroge un endpoint IGDB pour récupérer l'ID d'une entrée selon slug ou name.
     */
    private static int fetchFilterId(String endpointUrl, String field, String value) {
        try {
            String token = TokenManager.getToken();
            HttpURLConnection conn = (HttpURLConnection) new URL(endpointUrl).openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Client-ID", CLIENT_ID);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            conn.setDoOutput(true);
            String body = String.format("fields id,%s; where %s=\"%s\";", field, field, value);
            try (OutputStream os = conn.getOutputStream()) { os.write(body.getBytes()); }
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder(); String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            JSONArray arr = new JSONArray(sb.toString());
            if (arr.length() > 0) return arr.getJSONObject(0).getInt("id");
        } catch (Exception e) {
            e.printStackTrace();
        }
        return -1;
    }

    private static String normalizeSlug(String s) {
        String slug = s.trim().toLowerCase(Locale.ROOT)
            .replaceAll("[\\s/()]+", "-")
            .replaceAll("[^a-z0-9-]", "");
        return slug;
    }

    /**
     * Recherche des jeux par filtres structurés (genres, plateformes, thèmes, modes de jeu).
     */
    public static List<String> searchGamesByStructuredFilters(List<bdd.Question> filters) {
        List<String> results = new ArrayList<>();
        if (filters == null || filters.isEmpty()) return results;
        try {
            String token = TokenManager.getToken();
            List<Integer> genreIds = new ArrayList<>();
            List<Integer> platformIds = new ArrayList<>();
            List<Integer> themeIds = new ArrayList<>();
            List<Integer> gamemodeIds = new ArrayList<>();

            for (bdd.Question q : filters) {
                if (q.getProfondeur() == 0) continue;
                String raw = q.getText().trim();
                String slug = normalizeSlug(raw);
                int id;
                switch (q.getProfondeur()) {
                    case 1:
                        id = fetchFilterId(GENRES_URL, "slug", slug);
                        if (id < 0) id = fetchFilterId(GENRES_URL, "name", raw);
                        if (id > 0) genreIds.add(id);
                        break;
                    case 2:
                        id = fetchFilterId(PLATFORMS_URL, "slug", slug);
                        if (id < 0) id = fetchFilterId(PLATFORMS_URL, "name", raw);
                        if (id > 0) platformIds.add(id);
                        break;
                    case 3:
                        id = fetchFilterId(THEMES_URL, "slug", slug);
                        if (id < 0) id = fetchFilterId(THEMES_URL, "name", raw);
                        if (id > 0) themeIds.add(id);
                        break;
                    case 4:
                        id = fetchFilterId(GAMEMODES_URL, "slug", slug);
                        if (id < 0) id = fetchFilterId(GAMEMODES_URL, "name", raw);
                        if (id > 0) gamemodeIds.add(id);
                        break;
                    default:
                        break;
                }
            }

            // ✅ Ajout automatique du filtre "Solo" si aucun autre mode de jeu n’est sélectionné
            if (gamemodeIds.isEmpty()) {
                gamemodeIds.add(1); // ID de "Single player"
            }

            List<String> conds = new ArrayList<>();
            if (!genreIds.isEmpty()) conds.add("genres = (" + join(genreIds) + ")");
            if (!platformIds.isEmpty()) conds.add("platforms = (" + join(platformIds) + ")");
            if (!themeIds.isEmpty()) conds.add("themes = (" + join(themeIds) + ")");
            if (!gamemodeIds.isEmpty()) conds.add("game_modes = (" + join(gamemodeIds) + ")");
            conds.add("category = 0"); // Exclut les DLC, remakes, mods, etc.
            String where = "where " + String.join(" & ", conds) + ";";
            String body = "fields name; " + where + " limit 10;";
            System.out.println("Requête IGDB envoyée : " + body);
            HttpURLConnection conn = (HttpURLConnection) new URL(IGDB_URL).openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Client-ID", CLIENT_ID);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            conn.setRequestProperty("Accept", "application/json");
            conn.setDoOutput(true);
            try (OutputStream os = conn.getOutputStream()) { os.write(body.getBytes()); }
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
            StringBuilder sb = new StringBuilder(); String line;
            while ((line = reader.readLine()) != null) sb.append(line);
            reader.close();
            JSONArray arr = new JSONArray(sb.toString());
            for (int i = 0; i < arr.length(); i++) results.add(arr.getJSONObject(i).getString("name"));
        } catch (Exception e) {
            e.printStackTrace();
        }
        return results;
    }

    private static String join(List<Integer> ids) {
        return ids.stream().map(Object::toString).collect(Collectors.joining(","));
    }
}
