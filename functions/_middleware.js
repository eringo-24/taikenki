// public/内の全ファイル（index.html, css/*, js/* すべて）に自動的にBasic認証がかかります。
// ユーザー名・パスワードはコードに書かず、Cloudflareの「Secrets」に保存します
// （README.mdのwrangler pages secret putコマンド、またはダッシュボードのUIから設定）。

export async function onRequest(context) {
  const { request, env, next } = context;

  const validUser = env.CHECKER_USER;
  const validPass = env.CHECKER_PASS;

  const authHeader = request.headers.get("Authorization");

  if (authHeader && authHeader.startsWith("Basic ")) {
    const encoded = authHeader.slice(6);
    let decoded = "";
    try {
      decoded = atob(encoded);
    } catch (e) {
      decoded = "";
    }
    const sepIndex = decoded.indexOf(":");
    const user = decoded.slice(0, sepIndex);
    const pass = decoded.slice(sepIndex + 1);

    if (user === validUser && pass === validPass) {
      return next(); // 認証OK → 本来のファイル（index.html / css / js）を返す
    }
  }

  return new Response("認証が必要です", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="taikenki-checker", charset="UTF-8"'
    }
  });
}
