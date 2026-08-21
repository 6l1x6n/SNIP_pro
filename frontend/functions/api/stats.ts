export const onRequestGet: PagesFunction = async () => {
  return new Response(JSON.stringify({ total_documents: 0, active_documents: 0, total_chunks: 0, last_collector: null, mode: "no_db" }), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })
}
export const onRequestOptions: PagesFunction = async () => new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "*" } })
