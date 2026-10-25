# Scouting reports

Generate or refresh reports from the Scouting Reports section in `/admin`. The manually supplied GameChanger token shares the existing opponent-search prompt and stays in page memory. A missing or expired token returns to that prompt. Batch generation targets reachable future opponents and preserves existing reports unless refresh is requested.

The dashboard and admin use the same shared modal in `assets/scouting-report.js` and `assets/scouting-report.css`. Upcoming Games and bracket slots link to saved reports for confirmed, projected, and possible opponents. A report is read from storage when opened; collection is a separate manual action.

Reports cover completed games since September 1 of the report's season, bounded by the pregame cutoff. The overview, game plan, hitters, pitching, tendencies, and history identify their evidence and missing data. A listed 0-0 with no batting or pitching evidence is excluded. A refresh that loses player-box access keeps the last usable report. Earlier pregame versions remain available in storage.

Competition class follows the shared server resolver: an applicable admin correction, then NorCal classification or registration, then provider classification. Bracket membership stays separate. Without confirmed classification, three or more played games support a labeled inference: losses by eight or more runs in at least 25% of games imply likely C; otherwise likely B. Smaller unresolved samples use B by default. Class corrections are applied when a saved report is read.

The five-star rating combines class-adjusted results and verified tournament finishes; C and Rec teams are capped at two stars. Small samples are discounted. Hitters show production per team game alongside batting rates; pitching rates require actual innings, batters faced, or other valid denominators. Missing inputs remain unavailable rather than becoming zero.

Reports and identity corrections stay in private Netlify Blobs. Source control includes only code and synthetic test fixtures. Profile links and class revisions mark old reports as needing refresh when identities change. The public report endpoint and admin read the same merged snapshot and resolve the same opponent classes.

Run the Node.js 24 test suite and `npm run typecheck --prefix netlify/functions` after changes to the TypeScript scouting helpers. The local preview routes both JavaScript and TypeScript functions.
