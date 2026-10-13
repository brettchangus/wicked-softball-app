// Shared compatibility defaults. Real team, event, and provider data comes from each
// site's Blob catalog. Do not add production identifiers or rosters here.
export const TOURNEY_MACHINE_TOURNAMENT_ID = '';
export const TOURNEY_MACHINE_DIVISION_ID   = '';
export const TOURNEY_MACHINE_TEAM_ID       = '';
export const PUBLIC_EVENT_ID = null;
export const MY_ID         = '';
export const SISTER_ID     = '';
export const AGE_PREFIX    = '10';
// Generic keys are used only when importing a legacy, unscoped site configuration.
// A configured site's catalog supplies its own team, season, and event keys.
export const DEFAULT_TEAM_KEY   = 'team';
export const DEFAULT_SEASON_KEY = 'season';
export const DEFAULT_EVENT_KEY  = 'current-tournament';
export const TEAM_NAME          = 'Team';
export const SEASON_NAME        = 'Season';
export const EVENT_KEY          = DEFAULT_EVENT_KEY;
export const RULES_URL     = '';
// Bump when buildStructure's shape changes — forces check-scores to re-run setup even
// though the event id is unchanged (otherwise the old structure blob would persist).
export const SETUP_VERSION = 17;
export const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
