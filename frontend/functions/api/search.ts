export const onRequestPost: PagesFunction = async ({ request }) => {
  try {
    const body: any = await request.json().catch(() => ({}))
    const q = body.query || new URL(request.url).searchParams.get("q") || ""
    return new Response(JSON.stringify({
      query: q,
      mode: body.mode || "fast",
      answer: { answer: "База данных не подключена (Pages mock). Загрузите PDF в Документы или подключите бэкенд с Postgres для поиска по нормам.", is_grounded: false },
      results: [],
      took_ms: 10,
      total_found: 0,
      message: "Режим без БД (Pages Functions mock): поиск по документам отключен. Подключите бэкенд с Postgres."
    }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } })
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "access-control-allow-origin": "*" } })
  }
}
export const onRequestGet: PagesFunction = async ({ request }) => {
  const q = new URL(request.url).searchParams.get("q") || ""
  return new Response(JSON.stringify({
    query: q, mode: "fast",
    answer: { answer: "База данных не подключена (Pages mock).", is_grounded: false },
    results: [], took_ms: 5, total_found: 0, message: "Pages mock — без БД"
  }), { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } })
}
export const onRequestOptions: PagesFunction = async () => new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Content-Type, Authorization, X-Device-Id, X-API-Key" } })
