/**
 * RFC 7807 bodies, in the exact shape the page defines (`page.tsx:678-705`):
 * `{ type, title, status, detail, code, instance }`.
 *
 * THE MACHINE CODE GOES IN `code`. `title` is the human phrase for the status — the page's own
 * example is `{ "title": "Bad Request", …, "code": "BOT_ID_NOT_NAMESPACED" }`, and it says in as many
 * words: "Branch on `code`, never on `detail` — the human text changes, the code does not". Putting
 * the code in `title` would produce a body that reads fine to a human and that remi cannot branch on.
 */
const TITLES: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    404: 'Not Found',
    409: 'Conflict',
    422: 'Unprocessable Entity',
    503: 'Service Unavailable',
}

export function problem(status: number, code: string, extra: Record<string, unknown> = {}): Response {
    return new Response(JSON.stringify({ type: 'about:blank', title: TITLES[status] ?? 'Error', status, code, ...extra }), {
        status,
        headers: { 'content-type': 'application/problem+json' },
    })
}
