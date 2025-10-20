// /api/changelog.js  (Node 18+, ESM не обязателен)
import fetch from "node-fetch";

const REPO_OWNER = process.env.GH_REPO_OWNER;      // например: "mgshop-inc"
const REPO_NAME  = process.env.GH_REPO_NAME;       // например: "skladsborka-site"
const FILE_PATH  = process.env.GH_FILE_PATH || "public/changelog.json"; // где хранить файл
const BRANCH     = process.env.GH_BRANCH || "main"; // ветка
const GH_TOKEN   = process.env.GITHUB_TOKEN;        // GitHub PAT с правом repo:contents
const ADMIN_SECRET = process.env.ADMIN_SECRET;      // твой секрет для админ-операций

const GH_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(FILE_PATH)}`;

function bad(res, code, msg) { return res.status(code).json({ ok: false, error: msg }); }
function ok(res, payload)   { return res.status(200).json({ ok: true, ...payload }); }

// безопасная сортировка: по дате DESC (ISO), дальше по версии (семвер-похоже), дальше по вставке
function parseSemverLike(v = "") {
  const m = String(v).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)?$/);
  if (!m) return [0,0,0,""];
  return [Number(m[1]||0), Number(m[2]||0), Number(m[3]||0), String(m[4]||"")];
}
function cmpRelease(a, b) {
  const ad = a?.date || ""; const bd = b?.date || "";
  if (ad !== bd) return bd.localeCompare(ad); // ISO "YYYY-MM-DD" — лекс. сравнение ок
  // если даты равны/отсутствуют — сравним версии
  const [a1,a2,a3,as] = parseSemverLike(a?.version);
  const [b1,b2,b3,bs] = parseSemverLike(b?.version);
  if (a1 !== b1) return b1 - a1;
  if (a2 !== b2) return b2 - a2;
  if (a3 !== b3) return b3 - a3;
  return String(bs).localeCompare(String(as)); // суффиксы типа -beta
}

async function readFile() {
  const r = await fetch(`${GH_API}?ref=${BRANCH}`, {
    headers: { Authorization: `token ${GH_TOKEN}`, "User-Agent": "skladsborka-changelog" }
  });
  if (r.status === 404) {
    const empty = { showOnMain: 2, apkUrl: "", releases: [] };
    return { json: empty, sha: null };
  }
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);
  const j = await r.json();
  const content = Buffer.from(j.content || "", "base64").toString("utf8");
  return { json: JSON.parse(content), sha: j.sha };
}

async function writeFile(nextJson, prevSha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(nextJson, null, 2)).toString("base64"),
    branch: BRANCH,
    sha: prevSha || undefined,
  };
  const r = await fetch(GH_API, {
    method: "PUT",
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      "User-Agent": "skladsborka-changelog",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`GitHub PUT failed: ${r.status} ${t}`);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const { json } = await readFile();
      // подстрахуем сортировку на чтении
      json.releases = (json.releases || []).slice().sort(cmpRelease);
      return ok(res, { data: json });
    }

    // ниже — админ-операции
    const secret = req.headers["x-admin-secret"];
    if (!ADMIN_SECRET || secret !== ADMIN_SECRET) {
      return bad(res, 401, "unauthorized");
    }

    if (req.method === "POST") {
      // создать/обновить релиз
      const { release, showOnMain, apkUrl } = req.body || {};
      if (!release || !release.version || !Array.isArray(release.items)) {
        return bad(res, 400, "invalid payload");
      }
      const { json, sha } = await readFile();

      // обновим общие поля (optional)
      if (Number.isFinite(showOnMain)) json.showOnMain = Number(showOnMain);
      if (typeof apkUrl === "string" && apkUrl.trim()) json.apkUrl = apkUrl.trim();

      // если такая версия была — заменим; иначе добавим
      const list = Array.isArray(json.releases) ? json.releases.slice() : [];
      const idx = list.findIndex(r => String(r.version) === String(release.version));
      if (idx >= 0) list[idx] = { ...list[idx], ...release };
      else list.push(release);

      // жёстко отсортируем и сохраним
      list.sort(cmpRelease);
      json.releases = list;

      await writeFile(json, sha, `chore(changelog): ${idx>=0 ? "update" : "add"} ${release.version}`);
      return ok(res, { saved: true });
    }

    if (req.method === "DELETE") {
      const version = req.query.version || req.body?.version;
      if (!version) return bad(res, 400, "version required");
      const { json, sha } = await readFile();
      const before = json.releases?.length || 0;
      json.releases = (json.releases || []).filter(r => String(r.version) !== String(version));
      if (json.releases.length === before) return bad(res, 404, "version not found");
      await writeFile(json, sha, `chore(changelog): remove ${version}`);
      return ok(res, { removed: true });
    }

    res.setHeader("Allow", "GET,POST,DELETE");
    return bad(res, 405, "method not allowed");
  } catch (e) {
    return bad(res, 500, String(e.message || e));
  }
}
