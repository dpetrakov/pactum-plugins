// Fixtures of the W-06c leak tests (EP-039): unique canaries in every wave-1 format.
import { canary } from "./leak-harness.mjs";

export function fixtures(c) {
  return {
    ".gitignore": ".env.local\n",
    ".env.example": `# Пример окружения\nAPI_TOKEN=${c.ENV_TOKEN}\nexport DB_PASSWORD="${c.ENV_EXPORT}"\nMULTI="first ${c.ENV_MULTI}\nsecond line"\nPLAIN_NAME=${c.ENV_PLAIN} # обычное имя — тоже секрет: все значения .env\n`,
    ".env.local": `LOCAL_TOKEN=${c.LOCAL_ENV}\n`,
    "config/app.yaml": [
      "# Конфигурация (канарейки теста утечки)",
      "service: api",
      "db:",
      "  host: db.internal",
      `  password: ${c.YAML_PASSWORD}`,
      `api_key: '${c.YAML_APIKEY}'`,
      "credentials:",
      `  user: ${c.YAML_CRED_USER}`,
      `  pin: ${c.YAML_CRED_PIN}`,
      `shared: &shared ${c.YAML_ANCHOR}`,
      "auth_token: *shared",
      "private_key: |",
      `  line-one-${c.YAML_BLOCK}`,
      "  line-two",
      `endpoint: postgres://admin:${c.YAML_URL}@db.internal:5432/app`,
      "replicas: 3",
      "",
    ].join("\n"),
    "config/app.json": JSON.stringify({ name: "demo", clientSecret: c.JSON_SECRET, nested: { session_key: c.JSON_SESSION, port: 8080 }, list: [{ id: 1, access_key: c.JSON_ARRAY }] }, null, 2) + "\n",
    "config/settings.jsonc": `{\n  // настройки\n  "apiKey": "${c.JSONC_KEY}", // хвост\n  "mode": "dev",\n}\n`,
    "config/app.toml": `title = "demo"\npassword = "${c.TOML_PASSWORD}"\nsecret = """\n${c.TOML_MULTI}\n"""\nauth = { token = "${c.TOML_INLINE}", user = "u" }\n\n[[db]]\ndsn = "${c.TOML_DSN}"\nname = "main"\n`,
    "docs/keys.md": `# Ключи\n\nСтрока подключения: postgres://u:${c.MD_URL}@h/db\n\n\`\`\`\n-----BEGIN RSA PRIVATE KEY-----\n${c.MD_PEM}\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\n\`\`\`\n\nОбычный абзац для замечаний.\n`,
    "notes/pem.txt": `Ключ сервиса:\n-----BEGIN PRIVATE KEY-----\n${c.TXT_PEM}\n-----END PRIVATE KEY-----\nконец\n`,
    "data/list.csv": `name,url\napi,https://svc:${c.CSV_URL}@api.internal/\n`,
  };
}

/** Canaries; URL passwords must not contain «/» (it ends the password in a URL). */
export function canaries() {
  const names = ["ENV_TOKEN", "ENV_EXPORT", "ENV_MULTI", "ENV_PLAIN", "LOCAL_ENV", "YAML_PASSWORD", "YAML_APIKEY", "YAML_CRED_USER", "YAML_CRED_PIN", "YAML_ANCHOR",
    "YAML_BLOCK", "YAML_URL", "JSON_SECRET", "JSON_SESSION", "JSON_ARRAY", "JSONC_KEY", "TOML_PASSWORD", "TOML_MULTI", "TOML_INLINE", "TOML_DSN", "MD_URL", "MD_PEM", "TXT_PEM", "CSV_URL",
    "AGENT_NEW", "REVEALED"];
  const out = {};
  for (const name of names) out[name] = /URL$/.test(name) ? canary().replace("/", "-") : canary();
  // The PEM body and multi-line values are whole lines: keep them free of characters YAML/TOML would treat specially.
  return out;
}

