export const onRequestGet: PagesFunction = async () => {
  return new Response(JSON.stringify({ status: "ok", db: false, mode: "no_db", frontend: "snippy-llm.pages.dev" }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })
}
export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, {
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "Authorization, Content-Type, X-Device-Id, X-API-Key",
    },
  })
}
