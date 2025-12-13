/*
 * Click nbfs://nbhost/SystemFileSystem/Templates/Licenses/license-default.txt to change this license
 * Click nbfs://nbhost/SystemFileSystem/Templates/Classes/Class.java to edit this template
 */
package akinator.game;

/**
 *
 * @author erwan
 */
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.time.Instant;
import java.util.Scanner;
import org.json.JSONObject;

public class TokenManager {

    static final String CLIENT_ID = "u21n40pgrp5j141wxhjjm7ywrvfhsd";
    private static final String CLIENT_SECRET = "fagguyfhpn0hipzvhl2gi1lcnnem3u";
    private static final String TOKEN_FILE = "token.json";

    public static String getToken() throws Exception {
        File file = new File(TOKEN_FILE);

        if (file.exists()) {
            String content = new Scanner(file).useDelimiter("\\Z").next();
            JSONObject json = new JSONObject(content);
            long expiresAt = json.getLong("expires_at");

            if (Instant.now().getEpochSecond() < expiresAt) {
                return json.getString("access_token");
            }
        }

        return fetchNewToken();
    }

    private static String fetchNewToken() throws Exception {
        String url = String.format(
            "https://id.twitch.tv/oauth2/token?client_id=%s&client_secret=%s&grant_type=client_credentials",
            CLIENT_ID, CLIENT_SECRET
        );

        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);

        BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
        String response = reader.lines().reduce("", (acc, line) -> acc + line);
        reader.close();

        JSONObject json = new JSONObject(response);
        String token = json.getString("access_token");
        int expiresIn = json.getInt("expires_in");
        long expiresAt = Instant.now().getEpochSecond() + expiresIn;

        JSONObject saveJson = new JSONObject();
        saveJson.put("access_token", token);
        saveJson.put("expires_at", expiresAt);

        try (FileWriter fw = new FileWriter(TOKEN_FILE)) {
            fw.write(saveJson.toString());
        }

        return token;
    }
}
