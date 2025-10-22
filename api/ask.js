// api/ask.js
// Vercel Edge Function — 无需 vercel.json
export const config = { runtime: "edge" };

/** 返回 JSON */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** 读取 prompt：支持 GET ?prompt= 与 POST JSON {prompt:"..."} */
async function readPrompt(req) {
  try {
    if (req.method === "GET") {
      const url = new URL(req.url);
      return (url.searchParams.get("prompt") || "").trim();
    }
    // 其余按 JSON 处理
    const body = await req.json().catch(() => ({}));
    return (body?.prompt || "").trim();
  } catch {
    return "";
  }
}

/** Edge Runtime 下的 HMAC-SHA256 + Base64（钉钉加签） */
async function signForDingTalk(secret) {
  const timestamp = Date.now().toString();
  const msg = `${timestamp}\n${secret}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  const bytes = new Uint8Array(sigBuf);
  // Base64
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const base64 = btoa(bin);
  // URL 编码
  const sign = encodeURIComponent(base64);
  return { timestamp, sign };
}

/** 调 OpenAI Chat Completions */
async function callOpenAI(apiKey, prompt) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.6,
      messages: [
        { role: "system", content: "You are a helpful assistant for a DingTalk group." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!r.ok) {
    const t = await r.text();
    throw new Error(`OpenAI HTTP ${r.status}: ${t}`);
  }
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || "（无内容）";
}

/** 发送文本到钉钉机器人 */
async function sendToDingTalk(webhook, secret, text) {
  const { timestamp, sign } = await signForDingTalk(secret);

  // 确保 webhook 里只有 access_token，不要自带 sign / timestamp
  const url =
    `${webhook}` +
    `${webhook.includes("?") ? "&" : "?"}` +
    `timestamp=${timestamp}&sign=${sign}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ msgtype: "text", text: { content: text } }),
  });

  const out = await resp.text();
  if (!resp.ok) throw new Error(`DingTalk HTTP ${resp.status}: ${out}`);
  // 钉钉成功应返回 {"errcode":0,"errmsg":"ok"}
  try {
    const j = JSON.parse(out);
    if (j.errcode !== 0) throw new Error(out);
  } catch (e) {
    // 不是标准 JSON 或 errcode!=0
    throw new Error(out);
  }
}

export default async function handler(req) {
  try {
    // 读取参数
    const prompt = (await readPrompt(req)).slice(0, 4000);
    if (!prompt) return json({ error: "prompt required. Use ?prompt=你好 或 POST {prompt:'...'}" }, 400);

    // 环境变量
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    const DINGTALK_WEBHOOK = process.env.DINGTALK_WEBHOOK;
    const DINGTALK_SECRET = process.env.DINGTALK_SECRET;

    if (!OPENAI_API_KEY || !DINGTALK_WEBHOOK || !DINGTALK_SECRET) {
      return json(
        { error: "Missing env vars", need: ["OPENAI_API_KEY", "DINGTALK_WEBHOOK", "DINGTALK_SECRET"] },
        500
      );
    }

    // 先问 OpenAI，再发钉钉
    const answer = await callOpenAI(OPENAI_API_KEY, prompt);
    await sendToDingTalk(DINGTALK_WEBHOOK, DINGTALK_SECRET, answer);

    return json({ ok: true, answer });
  } catch (err) {
    // 将错误抛回便于你排查（不会泄露密钥）
    return json({ error: "server error", detail: String(err) }, 500);
  }
}
