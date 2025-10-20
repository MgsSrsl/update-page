// /api/changelog.js — Node.js 18+, обычный serverless (НЕ edge)
// Без внешних зависимостей. Использует глобальный fetch.

const REPO_OWNER   = process.env.GH_REPO_OWNER;
const REPO_NAME    = process.env.GH_REPO_NAME;
const FILE_PATH    = process.env.GH_FILE_PATH || "public/changelog.json";
const BRANCH       = process.env.GH_BRANCH || "main";
const GH_TOKEN     = process.env.GITHUB_TOKEN;
const ADMIN_SECRET = process.env.ADMIN_SECRET;

function bad(res, code, msg, extra = {}) {
  return res.status(code).json({ ok: false, error: msg, ...extra });
}
function ok(res, payload) {
  return res.status(200).json({ ok: true, ...payload });
}

// Сортировка (дата DESC → семвер DESC)
function parseSemverLike(v = "") {
  const m = String(v).trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)?$/);
  if (!m) return [0, 0, 0, ""];
  return [Number(m[1]||0), Number(m[2]||0), Number(m[3]||0), String(m[4]||"")];
}
function cmpRelease(a, b) {
  const ad = a?.date || ""; const bd = b?.date || "";
  if (ad !== bd) return bd.localeCompare(ad);
  const [a1,a2,a3,as] = parseSemverLike(a?.version);
  const [b1,b2,b3,bs] = parseSemverLike(b?.version);
  if (a1 !== b1) return b1 - a1;
  if (a2 !== b2) return b2 - a2;
  if (a3 !== b3) return b3 - a3;
  return String(bs).localeCompare(String(as));
}

function ghApiUrl() {
  if (!REPO_OWNER || !REPO_NAME) return null;
  return `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${encodeURIComponent(FILE_PATH)}`;
}

async function ghGetContents() {
  const url = ghApiUrl();
  const r = await fetch(`${url}?ref=${encodeURIComponent(BRANCH)}`, {
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      "User-Agent": "skladsborka-changelog"
    }
  });
  if (r.status === 404) {
    return { json: { showOnMain: 2, apkUrl: "", releases: [] }, sha: null };
  }
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`GitHub GET ${r.status}: ${t}`);
  }
  const j = await r.json();
  const content = Buffer.from(j.content || "", "base64").toString("utf8");
  return { json: JSON.parse(content), sha: j.sha };
}

async function ghPutContents(nextJson, prevSha, message) {
  const url = ghApiUrl();
  const body = {
    message,
    content: Buffer.from(JSON.stringify(nextJson, null, 2)).toString("base64"),
    branch: BRANCH,
    sha: prevSha || undefined,
  };
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${GH_TOKEN}`,
      "User-Agent": "skladsborka-changelog",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(()=>"");
    throw new Error(`GitHub PUT ${r.status}: ${t}`);
  }
}

export default async function handler(req, res) {
  try {
    // Базовые проверки ENV — вернём понятную ошибку вместо 500
    const missing = [];
    if (!GH_TOKEN)     missing.push("GITHUB_TOKEN");
    if (!REPO_OWNER)   missing.push("GH_REPO_OWNER");
    if (!REPO_NAME)    missing.push("GH_REPO_NAME");
    if (!BRANCH)       missing.push("GH_BRANCH");
    if (!ghApiUrl())   missing.push("GH_API_URL");
    if (missing.length && req.method !== "GET") {
      return bad(res, 500, "Missing ENV", { missing });
    }

    if (req.method === "GET") {
      const { json } = await ghGetContents();
      json.releases = (json.releases || []).slice().sort(cmpRelease);
      return ok(res, { data: json });
    }

    // Админ-проверка
    const secret = req.headers["x-admin-secret"];
    if (!ADMIN_SECRET) return bad(res, 500, "ADMIN_SECRET not set");
    if (secret !== ADMIN_SECRET) return bad(res, 401, "unauthorized");

    if (req.method === "POST") {
      const { release, showOnMain, apkUrl } = req.body || {};
      if (!release || !release.version || !Array.isArray(release.items)) {
        return bad(res, 400, "invalid payload: require {release.version, release.items[]}");
      }
      const { json, sha } = await ghGetContents();

      if (Number.isFinite(showOnMain)) json.showOnMain = Number(showOnMain);
      if (typeof apkUrl === "string" && apkUrl.trim()) json.apkUrl = apkUrl.trim();

      const list = Array.isArray(json.releases) ? json.releases.slice() : [];
      const idx = list.findIndex(r => String(r.version) === String(release.version));
      if (idx >= 0) list[idx] = { ...list[idx], ...release };
      else list.push(release);

      list.sort(cmpRelease);
      json.releases = list;

      await ghPutContents(json, sha, `chore(changelog): ${idx>=0 ? "update" : "add"} ${release.version}`);
      return ok(res, { saved: true });
    }

    if (req.method === "DELETE") {
      const version = req.query.version || req.body?.version;
      if (!version) return bad(res, 400, "version required");
      const { json, sha } = await ghGetContents();
      const before = json.releases?.length || 0;
      json.releases = (json.releases || []).filter(r => String(r.version) !== String(version));
      if ((json.releases?.length || 0) === before) return bad(res, 404, "version not found");
      await ghPutContents(json, sha, `chore(changelog): remove ${version}`);
      return ok(res, { removed: true });
    }

    res.setHeader("Allow", "GET,POST,DELETE");
    return bad(res, 405, "method not allowed");
  } catch (e) {
    return bad(res, 500, e?.message || String(e));
  }
}
