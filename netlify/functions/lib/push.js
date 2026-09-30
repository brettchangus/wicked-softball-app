import { createHash } from 'node:crypto';

// Blob key for a push subscription: a hash of the whole endpoint. Push services share long URL
// prefixes (every Firefox endpoint starts with the same 51 characters), so any truncated form of
// the endpoint maps different devices to one key and each new subscriber overwrites the last.
export const subscriptionKey = endpoint => createHash('sha256').update(String(endpoint)).digest('hex');

// The truncated key used before hashing. Only read to carry an existing device's record over.
export const legacySubscriptionKey = endpoint => Buffer.from(String(endpoint)).toString('base64').slice(0, 64);

// Records from before per-team subscriptions have no `watches` list and follow the default team.
// A record with a list — even an empty one, after un-belling every game — follows only that list.
export const isLegacySubscription = record => !Array.isArray(record?.watches);
