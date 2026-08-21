export const onRequestPost: PagesFunction = async () => {
  return new Response(JSON.stringify({ detail: "База данных отключена (Pages mock) — вход недоступен. Доки и поиск работают без входа." }), { status: 503, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } })
}
export const onRequestOptions: PagesFunction = async () => new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "Content-Type, X-Device-Id" } })
