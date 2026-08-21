export const onRequestGet: PagesFunction = async () => {
  return new Response(JSON.stringify({ detail: "Not authenticated" }), { status: 401, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } })
}
export const onRequestOptions: PagesFunction = async () => new Response(null, { headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "Authorization, X-Device-Id" } })
