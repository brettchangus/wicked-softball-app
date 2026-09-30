export default async function handler() {
  return new Response('Git snapshot export has been retired; season data is stored in Netlify Blobs.', {
    status:410,
  });
}
