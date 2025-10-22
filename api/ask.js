import crypto from "crypto";

export const config = { runtime: "edge" };

function sign(secret) {
  const ts = Date.now().toString();
  const str = `${ts}\n${secret}`;
  const h = crypto.createHmac("sha256", secret).update(str).digest("base64");
  const s = encodeURIComponent(h);
  return { ts, s };
}

export default async function handler(req) {
  try {
    const { prompt = "" } = await req.json();
    if (!prompt) return new Response(JSON.stringify({ error: "prompt required" }), { status: 400 });

    const openaiKey = process.env.OPENAI_API_KEY;
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "You are a helpful assistant for a DingTalk group." },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await res.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || "（无内容）";

    const { ts, s } = sign(process.env.DINGTALK_SECRET);
    const url = `${process.env.DINGTALK_WEBHOOK}&timestamp=${ts}&sign=${s}`;
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: answer } })
    });

    return new Response(JSON.stringify({ ok: true, answer }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
}