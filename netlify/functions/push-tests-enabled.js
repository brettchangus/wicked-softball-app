// Exposes the server-side ENABLE_PUSH_TESTS flag to the static page so it can
// decide whether to show the "register for push tests" affordance. The page only
// queries this in test paths (standalone app or ?test=1), never for normal visits.
export default async function handler() {
  return new Response(
    JSON.stringify({ enabled: process.env.ENABLE_PUSH_TESTS === '1' }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  );
}

export const config = { path: '/push-tests-enabled' };
