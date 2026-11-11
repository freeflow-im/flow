// A temporary control for the tab-switching measurements: answers at once, with nothing else in the script.
export default { fetch: () => new Response('ok', { headers: { 'cache-control': 'no-store' } }) };
